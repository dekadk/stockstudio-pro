//! Native Rust AI Background Removal powered by ONNX Runtime (DirectML GPU + CPU fallback)
//! supporting SOTA MIT-licensed models:
//! - `BiRefNet-general-lite` (Auto / Recommended, 1024×1024, ~214 MB)
//! - `BEN2_Base` (Sharp Cutout, 1024×1024, ~213 MB)
//! - `BiRefNet_HR-matting` (Ultra HD Matting, 2048×2048, ~1.05 GB)
//!
//! Includes on-demand 1x download of Microsoft ONNX Runtime DirectML + selected model
//! and Photoroom-style Fast Foreground Color Decontamination (`FB_blur_fusion`) for
//! halo-free microstock PNG cutouts.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, Rgba};
use ort::environment::Environment;
use ort::ep::{DirectML, CPU};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, Runtime};

pub const BGREMOVER_PROGRESS_EVENT: &str = "stockstudio-bgremover-progress";
pub const BGREMOVER_DONE_EVENT: &str = "stockstudio-bgremover-done";

const ORT_DIRECTML_NUPKG_URL: &str =
    "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/1.24.4/microsoft.ml.onnxruntime.directml.1.24.4.nupkg";
const DIRECTML_NUPKG_URL: &str =
    "https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg";

const BIREFNET_LITE_URL: &str =
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx";
const BEN2_BASE_URL: &str = "https://huggingface.co/PramaLLC/BEN2/resolve/main/BEN2_Base.onnx";
const BIREFNET_HR_MATTING_URL: &str =
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet_HR-matting-epoch_135.onnx";

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

static ORT_ENV: OnceLock<Result<Environment, String>> = OnceLock::new();

pub struct BgRemoverState {
    running: Arc<AtomicBool>,
    cancel_requested: Arc<AtomicBool>,
}

impl Default for BgRemoverState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, Debug)]
pub struct BgModelSpec {
    #[allow(dead_code)]
    pub id: &'static str,
    pub display_name: &'static str,
    pub file_name: &'static str,
    pub download_url: &'static str,
    pub default_size: u32,
}

pub fn resolve_bg_model(model_id: &str) -> BgModelSpec {
    match model_id.trim().to_ascii_lowercase().as_str() {
        "ben2" => BgModelSpec {
            id: "ben2",
            display_name: "BEN2 (Sharp Cutout)",
            file_name: "BEN2_Base.onnx",
            download_url: BEN2_BASE_URL,
            default_size: 1024,
        },
        "birefnet-hr" => BgModelSpec {
            id: "birefnet-hr",
            display_name: "BiRefNet HR Matting",
            file_name: "BiRefNet_HR-matting-epoch_135.onnx",
            download_url: BIREFNET_HR_MATTING_URL,
            default_size: 2048,
        },
        _ => BgModelSpec {
            id: "birefnet-lite",
            display_name: "BiRefNet Lite",
            file_name: "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
            download_url: BIREFNET_LITE_URL,
            default_size: 1024,
        },
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct BgRemoveBatchRequest {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub input_dir: Option<String>,
    pub output_dir: String,
    #[serde(default = "default_model")]
    pub model_id: String,
    #[serde(default = "default_true")]
    pub recursive: bool,
}

fn default_model() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
pub struct BgScanResult {
    pub files: Vec<String>,
    pub total: usize,
    pub default_output_dir: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BgStartResponse {
    pub total_files: usize,
    pub output_dir: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct BgProgressEvent {
    pub stage: String, // "downloading" | "loading" | "processing"
    pub current: usize,
    pub total: usize,
    pub percent: u8,
    pub file_name: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct BgDoneEvent {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub output_dir: String,
    pub total_ms: u64,
    pub last_error: Option<String>,
}

fn is_supported_image(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|ext| {
                ext.eq_ignore_ascii_case("png")
                    || ext.eq_ignore_ascii_case("jpg")
                    || ext.eq_ignore_ascii_case("jpeg")
                    || ext.eq_ignore_ascii_case("webp")
            })
            .unwrap_or(false)
}

fn collect_images_recursive(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recursive {
                collect_images_recursive(&path, true, out);
            }
        } else if is_supported_image(&path) {
            out.push(path);
        }
    }
}

fn expand_paths_to_images(raw_paths: &[String], recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for raw in raw_paths {
        let p = PathBuf::from(raw.trim());
        if p.is_dir() {
            collect_images_recursive(&p, recursive, &mut files);
        } else if is_supported_image(&p) {
            files.push(p);
        }
    }
    files.sort_by(|a, b| {
        a.to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&b.to_string_lossy().to_ascii_lowercase())
    });
    files.dedup();
    files
}

fn bg_remover_root_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve("bg-remover", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}

fn download_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    dest: &Path,
    label: &str,
    cancel_flag: &AtomicBool,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create dir failed: {e}"))?;
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1200))
        .user_agent("StockStudioPro-BgRemover")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Download server returned HTTP {}",
            resp.status().as_u16()
        ));
    }

    let total_bytes = resp.content_length().unwrap_or(0);
    let tmp_path = dest.with_extension("download.tmp");
    let mut file = File::create(&tmp_path).map_err(|e| format!("Create temp file failed: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut last_pct: u8 = 255;
    let mut buf = [0u8; 64 * 1024];

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&tmp_path);
            return Err("Download cancelled.".to_string());
        }
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("Read stream failed: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Write failed: {e}"))?;
        downloaded += n as u64;
        if total_bytes > 0 {
            let pct = ((downloaded * 100) / total_bytes).min(100) as u8;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit(
                    BGREMOVER_PROGRESS_EVENT,
                    BgProgressEvent {
                        stage: "downloading".to_string(),
                        current: 0,
                        total: 100,
                        percent: pct,
                        file_name: label.to_string(),
                        status: "info".to_string(),
                        message: format!("Downloading {label}… {pct}%"),
                    },
                );
            }
        }
    }

    file.flush().map_err(|e| format!("Flush failed: {e}"))?;
    drop(file);
    std::fs::rename(&tmp_path, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Finalize download failed: {e}")
    })?;
    Ok(())
}

fn extract_dlls_from_nupkg(
    nupkg_path: &Path,
    dest_dir: &Path,
    prefix_filter: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("Create runtime dir failed: {e}"))?;
    let zip_file =
        File::open(nupkg_path).map_err(|e| format!("Open runtime package failed: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(zip_file).map_err(|e| format!("Invalid runtime package: {e}"))?;

    let prefix_lower = prefix_filter.to_ascii_lowercase();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Read package entry failed: {e}"))?;
        let Some(enclosed) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let norm = enclosed
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if entry.is_dir() || !norm.starts_with(&prefix_lower) || !norm.ends_with(".dll") {
            continue;
        }
        let Some(file_name) = enclosed.file_name() else {
            continue;
        };
        let out_path = dest_dir.join(file_name);
        let mut out_file =
            File::create(&out_path).map_err(|e| format!("Extract DLL failed: {e}"))?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| format!("Copy DLL failed: {e}"))?;
    }
    Ok(())
}

fn ensure_runtime_and_model<R: Runtime>(
    app: &AppHandle<R>,
    root_dir: &Path,
    spec: &BgModelSpec,
    cancel_flag: &AtomicBool,
) -> Result<(PathBuf, PathBuf), String> {
    let runtime_dir = root_dir.join("runtime");
    let ort_dll = runtime_dir.join("onnxruntime.dll");
    let dml_dll = runtime_dir.join("DirectML.dll");

    if !ort_dll.exists() {
        let nupkg = root_dir.join("ort-directml.nupkg");
        download_with_progress(
            app,
            ORT_DIRECTML_NUPKG_URL,
            &nupkg,
            "AI Runtime (ONNX DirectML)",
            cancel_flag,
        )?;
        extract_dlls_from_nupkg(&nupkg, &runtime_dir, "runtimes/win-x64/native/")?;
        let _ = std::fs::remove_file(&nupkg);
        if !ort_dll.exists() {
            return Err("onnxruntime.dll missing after extraction.".to_string());
        }
    }

    if !dml_dll.exists() {
        let nupkg = root_dir.join("directml.nupkg");
        if download_with_progress(
            app,
            DIRECTML_NUPKG_URL,
            &nupkg,
            "DirectML GPU Driver",
            cancel_flag,
        )
        .is_ok()
        {
            let _ = extract_dlls_from_nupkg(&nupkg, &runtime_dir, "bin/x64-win/");
            let _ = std::fs::remove_file(&nupkg);
        }
    }

    let model_path = root_dir.join("models").join(spec.file_name);
    if !model_path.exists() {
        download_with_progress(
            app,
            spec.download_url,
            &model_path,
            spec.display_name,
            cancel_flag,
        )?;
    }

    Ok((ort_dll, model_path))
}

fn ensure_ort_env(ort_dll: &Path) -> Result<Environment, String> {
    let res = ORT_ENV.get_or_init(|| {
        let builder =
            ort::init_from(ort_dll).map_err(|e| format!("Failed to load ONNX Runtime DLL: {e}"))?;
        builder
            .with_name("stockstudio-pro")
            .build()
            .map_err(|e| format!("Failed to initialize ONNX Runtime environment: {e}"))
    });
    res.clone()
}

fn create_cpu_session(env: &Environment, model_path: &Path) -> Result<Session, String> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4);
    let mut builder = Session::builder(env)
        .map_err(|e| format!("Session builder error: {e}"))?
        .with_intra_threads(threads)
        .map_err(|e| format!("CPU thread config error: {e}"))?
        .with_execution_providers([CPU::default().build()])
        .map_err(|e| format!("CPU provider setup failed: {e}"))?;
    builder
        .commit_from_file(model_path)
        .map_err(|e| format!("Failed to load AI model on CPU: {e}"))
}

fn create_inference_session(
    env: &Environment,
    model_path: &Path,
) -> Result<(Session, bool), String> {
    // Prefer Windows DirectML GPU acceleration with memory_pattern disabled
    // (required by DirectML to prevent 0x8007000E VRAM arena OOM on 2-4GB/iGPUs).
    if let Ok(builder) = Session::builder(env) {
        if let Ok(builder) = builder.with_memory_pattern(false) {
            if let Ok(builder) = builder.with_parallel_execution(false) {
                if let Ok(mut builder) = builder
                    .with_execution_providers([DirectML::default().build(), CPU::default().build()])
                {
                    if let Ok(session) = builder.commit_from_file(model_path) {
                        return Ok((session, true));
                    }
                }
            }
        }
    }

    create_cpu_session(env, model_path).map(|s| (s, false))
}

fn normalize_rgb_to_nchw(img: &DynamicImage, target_w: u32, target_h: u32) -> Vec<f32> {
    let resized = img
        .resize_exact(target_w, target_h, FilterType::Triangle)
        .to_rgb8();
    let plane = (target_w as usize) * (target_h as usize);
    let mut tensor = vec![0.0f32; 3 * plane];
    let raw = resized.as_raw();

    for i in 0..plane {
        let r = raw[i * 3] as f32 / 255.0;
        let g = raw[i * 3 + 1] as f32 / 255.0;
        let b = raw[i * 3 + 2] as f32 / 255.0;
        tensor[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
        tensor[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
        tensor[2 * plane + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
    tensor
}

/// Converts raw model output (either logits or already-sigmoided probabilities) into [0..1] alpha.
pub fn normalize_mask_probabilities(raw: &[f32]) -> Vec<f32> {
    if raw.is_empty() {
        return Vec::new();
    }
    let mut min_raw = f32::INFINITY;
    let mut max_raw = f32::NEG_INFINITY;
    for &v in raw {
        if v.is_finite() {
            if v < min_raw {
                min_raw = v;
            }
            if v > max_raw {
                max_raw = v;
            }
        }
    }

    let needs_sigmoid = min_raw < -0.05 || max_raw > 1.05;
    let mut probs = Vec::with_capacity(raw.len());
    let mut min_p = f32::INFINITY;
    let mut max_p = f32::NEG_INFINITY;

    for &v in raw {
        let p = if !v.is_finite() {
            0.0
        } else if needs_sigmoid {
            1.0 / (1.0 + (-v.clamp(-30.0, 30.0)).exp())
        } else {
            v.clamp(0.0, 1.0)
        };
        if p < min_p {
            min_p = p;
        }
        if p > max_p {
            max_p = p;
        }
        probs.push(p);
    }

    let span = max_p - min_p;
    if span > 1e-5 {
        for p in &mut probs {
            *p = ((*p - min_p) / span).clamp(0.0, 1.0);
        }
    }
    probs
}

/// O(W*H) separable box blur on a single-channel f32 buffer (replicated edge padding).
fn box_blur_plane(src: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    if radius == 0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let win = (2 * radius + 1) as f32;
    let mut horiz = vec![0.0f32; w * h];

    // Horizontal pass
    for y in 0..h {
        let row = y * w;
        let mut sum = 0.0f32;
        for dx in -(radius as isize)..=(radius as isize) {
            let sx = dx.clamp(0, (w - 1) as isize) as usize;
            sum += src[row + sx];
        }
        horiz[row] = sum / win;
        for x in 1..w {
            let add_x = (x + radius).min(w - 1);
            let sub_x = x.saturating_sub(radius + 1);
            sum += src[row + add_x] - src[row + sub_x];
            horiz[row + x] = sum / win;
        }
    }

    // Vertical pass
    let mut out = vec![0.0f32; w * h];
    for x in 0..w {
        let mut sum = 0.0f32;
        for dy in -(radius as isize)..=(radius as isize) {
            let sy = dy.clamp(0, (h - 1) as isize) as usize;
            sum += horiz[sy * w + x];
        }
        out[x] = sum / win;
        for y in 1..h {
            let add_y = (y + radius).min(h - 1);
            let sub_y = y.saturating_sub(radius + 1);
            sum += horiz[add_y * w + x] - horiz[sub_y * w + x];
            out[y * w + x] = sum / win;
        }
    }
    out
}

/// Photoroom `FB_blur_fusion_foreground_estimator_2` color decontamination pass:
/// removes background color bleed/halos along semi-transparent edges (hair, fur, glass).
fn fb_blur_fusion_step(
    img: &[Vec<f32>; 3],
    fg: &[Vec<f32>; 3],
    bg: &[Vec<f32>; 3],
    alpha: &[f32],
    w: usize,
    h: usize,
    radius: usize,
) -> ([Vec<f32>; 3], [Vec<f32>; 3]) {
    let n = w * h;
    let blurred_a = box_blur_plane(alpha, w, h, radius);
    let mut out_f = [vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]];
    let mut out_b = [vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]];

    for c in 0..3 {
        let mut fa = vec![0.0f32; n];
        let mut b1a = vec![0.0f32; n];
        for i in 0..n {
            let a = alpha[i];
            fa[i] = fg[c][i] * a;
            b1a[i] = bg[c][i] * (1.0 - a);
        }
        let blur_fa = box_blur_plane(&fa, w, h, radius);
        let blur_b1a = box_blur_plane(&b1a, w, h, radius);

        for i in 0..n {
            let ba = blurred_a[i];
            let bf = blur_fa[i] / (ba + 1e-5);
            let bb = blur_b1a[i] / ((1.0 - ba) + 1e-5);
            let a = alpha[i];
            let f_val = bf + a * (img[c][i] - a * bf - (1.0 - a) * bb);
            out_f[c][i] = f_val.clamp(0.0, 1.0);
            out_b[c][i] = bb.clamp(0.0, 1.0);
        }
    }
    (out_f, out_b)
}

fn compose_decontaminated_rgba(
    orig: &DynamicImage,
    alpha_mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let rgb = orig.to_rgb8();
    let (w_u32, h_u32) = rgb.dimensions();
    let (w, h) = (w_u32 as usize, h_u32 as usize);
    let n = w * h;

    let raw_rgb = rgb.as_raw();
    let raw_a = alpha_mask.as_raw();

    let mut img_planes = [vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]];
    let mut alpha_f = vec![0.0f32; n];
    for i in 0..n {
        img_planes[0][i] = raw_rgb[i * 3] as f32 / 255.0;
        img_planes[1][i] = raw_rgb[i * 3 + 1] as f32 / 255.0;
        img_planes[2][i] = raw_rgb[i * 3 + 2] as f32 / 255.0;
        alpha_f[i] = raw_a[i] as f32 / 255.0;
    }

    // Scale blur radii reasonably for very high-res images so execution stays fast (<250ms)
    let r1 = ((w.max(h) / 36).clamp(18, 45)) as usize;
    let r2 = 4usize;

    let (fg1, bg1) = fb_blur_fusion_step(&img_planes, &img_planes, &img_planes, &alpha_f, w, h, r1);
    let (fg2, _) = fb_blur_fusion_step(&img_planes, &fg1, &bg1, &alpha_f, w, h, r2);

    let mut out = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(w_u32, h_u32);
    for (i, pixel) in out.pixels_mut().enumerate() {
        let a_u8 = raw_a[i];
        if a_u8 == 0 {
            *pixel = Rgba([0, 0, 0, 0]);
        } else if a_u8 == 255 {
            *pixel = Rgba([raw_rgb[i * 3], raw_rgb[i * 3 + 1], raw_rgb[i * 3 + 2], 255]);
        } else {
            let r = (fg2[0][i] * 255.0).round().clamp(0.0, 255.0) as u8;
            let g = (fg2[1][i] * 255.0).round().clamp(0.0, 255.0) as u8;
            let b = (fg2[2][i] * 255.0).round().clamp(0.0, 255.0) as u8;
            *pixel = Rgba([r, g, b, a_u8]);
        }
    }
    out
}

fn remove_bg_single_image(
    session: &mut Session,
    spec: &BgModelSpec,
    input_path: &Path,
    output_dir: &Path,
    rel_path: &Path,
) -> Result<(), String> {
    let orig = image::open(input_path).map_err(|e| format!("Open image failed: {e}"))?;
    let (orig_w, orig_h) = orig.dimensions();

    let target = spec.default_size;
    let input_data = normalize_rgb_to_nchw(&orig, target, target);
    let input_tensor =
        Tensor::<f32>::from_array(([1usize, 3, target as usize, target as usize], input_data))
            .map_err(|e| format!("Create input tensor failed: {e}"))?;

    let input_name = session
        .inputs()
        .first()
        .map(|i| i.name().to_string())
        .unwrap_or_else(|| "input_image".to_string());

    let outputs = session
        .run(ort::inputs![input_name.as_str() => input_tensor])
        .map_err(|e| format!("AI inference failed: {e}"))?;

    let (_, first_output) = outputs
        .iter()
        .next()
        .ok_or_else(|| "AI model produced no output tensor.".to_string())?;
    let (shape, raw_slice) = first_output
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("Extract mask tensor failed: {e}"))?;

    // Output shape is typically [1, 1, H, W] or [1, H, W]
    let dims: Vec<usize> = shape.iter().map(|&d| d.max(1) as usize).collect();
    let (mask_h, mask_w) = if dims.len() >= 2 {
        (dims[dims.len() - 2], dims[dims.len() - 1])
    } else {
        (target as usize, target as usize)
    };
    let mask_len = mask_h * mask_w;
    if raw_slice.len() < mask_len {
        return Err("AI output mask dimensions mismatch.".to_string());
    }

    let probs = normalize_mask_probabilities(&raw_slice[..mask_len]);
    let mask_u8: Vec<u8> = probs
        .into_iter()
        .map(|p| (p * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect();

    let small_mask =
        ImageBuffer::<Luma<u8>, Vec<u8>>::from_raw(mask_w as u32, mask_h as u32, mask_u8)
            .ok_or_else(|| "Failed to construct alpha mask image.".to_string())?;

    let full_mask = if mask_w as u32 != orig_w || mask_h as u32 != orig_h {
        DynamicImage::ImageLuma8(small_mask)
            .resize_exact(orig_w, orig_h, FilterType::Lanczos3)
            .to_luma8()
    } else {
        small_mask
    };

    let rgba = compose_decontaminated_rgba(&orig, &full_mask);

    let mut final_path = output_dir.join(rel_path);
    final_path.set_extension("png");
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create output dir failed: {e}"))?;
    }

    let tmp_path = final_path.with_extension("png.tmp");
    rgba.save_with_format(&tmp_path, image::ImageFormat::Png)
        .map_err(|e| format!("Save PNG failed: {e}"))?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Finalize PNG failed: {e}")
    })?;

    Ok(())
}

#[tauri::command]
pub fn pick_bg_remover_files() -> Result<BgScanResult, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Select Images for Background Removal")
        .add_filter("Image Files", &["png", "jpg", "jpeg", "webp"])
        .pick_files()
        .unwrap_or_default();

    let files: Vec<String> = picked
        .iter()
        .filter(|p| is_supported_image(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    let default_output_dir = picked
        .first()
        .and_then(|p| p.parent())
        .map(|parent| parent.join("NoBG_Output").to_string_lossy().into_owned());

    let total = files.len();
    Ok(BgScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn resolve_dropped_bg_remover_paths(
    paths: Vec<String>,
    recursive: bool,
) -> Result<BgScanResult, String> {
    let resolved = expand_paths_to_images(&paths, recursive);
    let default_output_dir = paths.first().and_then(|first| {
        let p = PathBuf::from(first.trim());
        if p.is_dir() {
            Some(p.join("NoBG_Output").to_string_lossy().into_owned())
        } else {
            p.parent()
                .map(|parent| parent.join("NoBG_Output").to_string_lossy().into_owned())
        }
    });
    let total = resolved.len();
    let files = resolved
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Ok(BgScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn scan_bg_remover_images(input_dir: String, recursive: bool) -> Result<BgScanResult, String> {
    let dir = PathBuf::from(input_dir.trim());
    if !dir.is_dir() {
        return Err("Input folder does not exist.".to_string());
    }
    let mut paths = Vec::new();
    collect_images_recursive(&dir, recursive, &mut paths);
    paths.sort_by(|a, b| {
        a.to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&b.to_string_lossy().to_ascii_lowercase())
    });
    let total = paths.len();
    let files = paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let default_output_dir = Some(dir.join("NoBG_Output").to_string_lossy().into_owned());
    Ok(BgScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn cancel_bg_remove_batch<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<BgRemoverState>();
    state.cancel_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn start_bg_remove_batch<R: Runtime>(
    app: AppHandle<R>,
    request: BgRemoveBatchRequest,
) -> Result<BgStartResponse, String> {
    let input_dir_opt = request
        .input_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let files: Vec<PathBuf> = if !request.files.is_empty() {
        expand_paths_to_images(&request.files, request.recursive)
    } else if let Some(ref dir) = input_dir_opt {
        if !dir.is_dir() {
            return Err("Input folder does not exist.".to_string());
        }
        let mut found = Vec::new();
        collect_images_recursive(dir, request.recursive, &mut found);
        found.sort();
        found
    } else {
        return Err("Please select at least one image or folder.".to_string());
    };

    if files.is_empty() {
        return Err("No supported images (.png, .jpg, .webp) found.".to_string());
    }

    let output_dir = if !request.output_dir.trim().is_empty() {
        PathBuf::from(request.output_dir.trim())
    } else if let Some(ref dir) = input_dir_opt {
        dir.join("NoBG_Output")
    } else if let Some(parent) = files[0].parent() {
        parent.join("NoBG_Output")
    } else {
        return Err("Output folder is required.".to_string());
    };

    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Cannot create output folder: {e}"))?;

    let root_dir = bg_remover_root_dir(&app)?;
    let spec = resolve_bg_model(&request.model_id);

    let state = app.state::<BgRemoverState>();
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Background removal is already running.".to_string());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    let total_files = files.len();
    let output_dir_str = output_dir.to_string_lossy().into_owned();
    let running_flag = Arc::clone(&state.running);
    let cancel_flag = Arc::clone(&state.cancel_requested);
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let batch_start = Instant::now();
        let mut succeeded = 0usize;
        let mut failed = 0usize;
        let mut cancelled = false;
        let mut last_error: Option<String> = None;

        let setup = ensure_runtime_and_model(&app_handle, &root_dir, &spec, &cancel_flag).and_then(
            |(ort_dll, model_path)| {
                let _ = app_handle.emit(
                    BGREMOVER_PROGRESS_EVENT,
                    BgProgressEvent {
                        stage: "loading".to_string(),
                        current: 0,
                        total: total_files,
                        percent: 0,
                        file_name: spec.display_name.to_string(),
                        status: "info".to_string(),
                        message: format!("Loading {}…", spec.display_name),
                    },
                );
                let env = ensure_ort_env(&ort_dll)?;
                let (session, using_dml) = create_inference_session(&env, &model_path)?;
                Ok((env, model_path, session, using_dml))
            },
        );

        match setup {
            Ok((env, model_path, initial_session, mut using_dml)) => {
                let mut session_opt = Some(initial_session);
                for (idx, img_path) in files.iter().enumerate() {
                    if cancel_flag.load(Ordering::SeqCst) {
                        cancelled = true;
                        break;
                    }
                    let rel = input_dir_opt
                        .as_ref()
                        .and_then(|dir| img_path.strip_prefix(dir).ok())
                        .unwrap_or_else(|| Path::new(img_path.file_name().unwrap_or_default()));
                    let display_name = rel.to_string_lossy().into_owned();

                    let _ = app_handle.emit(
                        BGREMOVER_PROGRESS_EVENT,
                        BgProgressEvent {
                            stage: "processing".to_string(),
                            current: idx,
                            total: total_files,
                            percent: ((idx * 100) / total_files) as u8,
                            file_name: display_name.clone(),
                            status: "info".to_string(),
                            message: "Removing background…".to_string(),
                        },
                    );

                    let mut attempt = match session_opt.as_mut() {
                        Some(session) => {
                            remove_bg_single_image(session, &spec, img_path, &output_dir, rel)
                        }
                        None => Err("AI session unavailable.".to_string()),
                    };

                    // Automatic runtime fallback: if DirectML GPU runs out of VRAM (e.g. 0x8007000E)
                    // during inference, drop the DirectML session first to release VRAM/shared RAM,
                    // then switch seamlessly to multi-threaded CPU and retry the image.
                    if attempt.is_err() && using_dml {
                        let _ = app_handle.emit(
                            BGREMOVER_PROGRESS_EVENT,
                            BgProgressEvent {
                                stage: "loading".to_string(),
                                current: idx,
                                total: total_files,
                                percent: ((idx * 100) / total_files) as u8,
                                file_name: display_name.clone(),
                                status: "info".to_string(),
                                message: "GPU memory limit reached — switching to CPU mode…"
                                    .to_string(),
                            },
                        );
                        session_opt = None;
                        using_dml = false;
                        match create_cpu_session(&env, &model_path) {
                            Ok(cpu_session) => {
                                session_opt = Some(cpu_session);
                                let _ = app_handle.emit(
                                    BGREMOVER_PROGRESS_EVENT,
                                    BgProgressEvent {
                                        stage: "processing".to_string(),
                                        current: idx,
                                        total: total_files,
                                        percent: ((idx * 100) / total_files) as u8,
                                        file_name: display_name.clone(),
                                        status: "info".to_string(),
                                        message: "Removing background (CPU)…".to_string(),
                                    },
                                );
                                if let Some(session) = session_opt.as_mut() {
                                    attempt = remove_bg_single_image(
                                        session,
                                        &spec,
                                        img_path,
                                        &output_dir,
                                        rel,
                                    );
                                }
                            }
                            Err(cpu_err) => {
                                attempt = Err(cpu_err);
                            }
                        }
                    }

                    match attempt {
                        Ok(()) => {
                            succeeded += 1;
                            let _ = app_handle.emit(
                                BGREMOVER_PROGRESS_EVENT,
                                BgProgressEvent {
                                    stage: "processing".to_string(),
                                    current: idx + 1,
                                    total: total_files,
                                    percent: (((idx + 1) * 100) / total_files) as u8,
                                    file_name: display_name,
                                    status: "ok".to_string(),
                                    message: "Done".to_string(),
                                },
                            );
                        }
                        Err(err) => {
                            failed += 1;
                            last_error = Some(err.clone());
                            let _ = app_handle.emit(
                                BGREMOVER_PROGRESS_EVENT,
                                BgProgressEvent {
                                    stage: "processing".to_string(),
                                    current: idx + 1,
                                    total: total_files,
                                    percent: (((idx + 1) * 100) / total_files) as u8,
                                    file_name: display_name,
                                    status: "error".to_string(),
                                    message: err,
                                },
                            );
                        }
                    }
                }
            }
            Err(err) => {
                if cancel_flag.load(Ordering::SeqCst) {
                    cancelled = true;
                } else {
                    failed = total_files;
                    last_error = Some(err.clone());
                    let _ = app_handle.emit(
                        BGREMOVER_PROGRESS_EVENT,
                        BgProgressEvent {
                            stage: "downloading".to_string(),
                            current: 0,
                            total: total_files,
                            percent: 0,
                            file_name: String::new(),
                            status: "error".to_string(),
                            message: err,
                        },
                    );
                }
            }
        }

        running_flag.store(false, Ordering::SeqCst);
        let _ = app_handle.emit(
            BGREMOVER_DONE_EVENT,
            BgDoneEvent {
                total: total_files,
                succeeded,
                failed,
                cancelled,
                output_dir: output_dir.to_string_lossy().into_owned(),
                total_ms: batch_start.elapsed().as_millis() as u64,
                last_error,
            },
        );
    });

    Ok(BgStartResponse {
        total_files,
        output_dir: output_dir_str,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_birefnet_and_ben2_model_specs() {
        let auto = resolve_bg_model("auto");
        assert_eq!(auto.id, "birefnet-lite");
        assert_eq!(auto.default_size, 1024);

        let ben2 = resolve_bg_model("ben2");
        assert_eq!(ben2.id, "ben2");
        assert_eq!(ben2.default_size, 1024);

        let hr = resolve_bg_model("birefnet-hr");
        assert_eq!(hr.id, "birefnet-hr");
        assert_eq!(hr.default_size, 2048);
    }

    #[test]
    fn normalizes_both_logits_and_probabilities_to_unit_range() {
        let logits = normalize_mask_probabilities(&[-8.0, 0.0, 8.0]);
        assert!(logits[0] < 0.01);
        assert!((logits[1] - 0.5).abs() < 0.05);
        assert!(logits[2] > 0.99);

        let probs = normalize_mask_probabilities(&[0.0, 0.5, 1.0]);
        assert!((probs[0] - 0.0).abs() < 1e-5);
        assert!((probs[1] - 0.5).abs() < 1e-5);
        assert!((probs[2] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn separable_box_blur_preserves_constant_plane() {
        let src = vec![0.75f32; 16 * 16];
        let blurred = box_blur_plane(&src, 16, 16, 3);
        for v in blurred {
            assert!((v - 0.75).abs() < 1e-4);
        }
    }
}
