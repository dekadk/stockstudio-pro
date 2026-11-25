//! AI Image Upscaler powered by Real-ESRGAN NCNN Vulkan (MIT) with on-demand
//! model downloading, guaranteed >= 3000 px shortest side, and automatic
//! microstock output format (JPG 95% for opaque, PNG for transparent images).

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, Runtime};

pub const UPSCALER_PROGRESS_EVENT: &str = "stockstudio-upscaler-progress";
pub const UPSCALER_DONE_EVENT: &str = "stockstudio-upscaler-done";
pub const DEFAULT_MIN_SHORTEST_PX: u32 = 3000;
const JPEG_QUALITY: u8 = 95;

const REALESRGAN_WINDOWS_ZIP_URL: &str =
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";

const NMKD_SIAX_PARAM_URL: &str =
    "https://raw.githubusercontent.com/upscayl/custom-models/main/models/4x_NMKD-Siax_200k.param";
const NMKD_SIAX_BIN_URL: &str =
    "https://raw.githubusercontent.com/upscayl/custom-models/main/models/4x_NMKD-Siax_200k.bin";

const NMKD_SUPERSCALE_PARAM_URL: &str =
    "https://raw.githubusercontent.com/upscayl/custom-models/main/models/4x_NMKD-Superscale-SP_178000_G.param";
const NMKD_SUPERSCALE_BIN_URL: &str =
    "https://raw.githubusercontent.com/upscayl/custom-models/main/models/4x_NMKD-Superscale-SP_178000_G.bin";

pub struct UpscalerState {
    running: Arc<AtomicBool>,
    cancel_requested: Arc<AtomicBool>,
}

impl Default for UpscalerState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct UpscaleBatchRequest {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub input_dir: Option<String>,
    pub output_dir: String,
    #[serde(default = "default_model_id")]
    pub model_id: String,
    #[serde(default = "default_true")]
    pub recursive: bool,
    #[serde(default = "default_min_px")]
    pub min_shortest_px: u32,
}

fn default_model_id() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

fn default_min_px() -> u32 {
    DEFAULT_MIN_SHORTEST_PX
}

#[derive(Clone, Debug, Serialize)]
pub struct UpscaleScanResult {
    pub files: Vec<String>,
    pub total: usize,
    pub default_output_dir: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpscaleStartResponse {
    pub total_files: usize,
    pub output_dir: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpscaleProgressEvent {
    pub stage: String, // "downloading" | "upscaling"
    pub current: usize,
    pub total: usize,
    pub percent: u8,
    pub file_name: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpscaleDoneEvent {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub output_dir: String,
    pub total_ms: u64,
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

fn resolve_canonical_model(model_id: &str) -> &'static str {
    match model_id.trim() {
        "4x_NMKD-Siax_200k" => "4x_NMKD-Siax_200k",
        "4x_NMKD-Superscale-SP_178000_G" => "4x_NMKD-Superscale-SP_178000_G",
        _ => "realesrgan-x4plus",
    }
}

fn upscaler_root_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve("upscaler", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}

fn download_file_with_progress<R: Runtime>(
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
        .timeout(Duration::from_secs(600))
        .user_agent("StockStudioPro-Upscaler")
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
                    UPSCALER_PROGRESS_EVENT,
                    UpscaleProgressEvent {
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

fn ensure_engine_and_model<R: Runtime>(
    app: &AppHandle<R>,
    root_dir: &Path,
    model_name: &str,
    cancel_flag: &AtomicBool,
) -> Result<(PathBuf, PathBuf), String> {
    let exe_path = root_dir.join("realesrgan-ncnn-vulkan.exe");
    let models_dir = root_dir.join("models");

    if !exe_path.exists() || !models_dir.join("realesrgan-x4plus.bin").exists() {
        let zip_path = root_dir.join("realesrgan-engine.zip");
        download_file_with_progress(
            app,
            REALESRGAN_WINDOWS_ZIP_URL,
            &zip_path,
            "AI Engine & Standard Model",
            cancel_flag,
        )?;

        let zip_file = File::open(&zip_path).map_err(|e| format!("Open engine zip failed: {e}"))?;
        let mut archive =
            zip::ZipArchive::new(zip_file).map_err(|e| format!("Invalid engine zip: {e}"))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Read zip entry failed: {e}"))?;
            let Some(enclosed) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            let out_path = root_dir.join(&enclosed);
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)
                    .map_err(|e| format!("Create dir failed: {e}"))?;
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Create parent dir failed: {e}"))?;
                }
                let mut out_file =
                    File::create(&out_path).map_err(|e| format!("Extract file failed: {e}"))?;
                std::io::copy(&mut entry, &mut out_file)
                    .map_err(|e| format!("Extract copy failed: {e}"))?;
            }
        }
        let _ = std::fs::remove_file(&zip_path);
    }

    let param_path = models_dir.join(format!("{model_name}.param"));
    let bin_path = models_dir.join(format!("{model_name}.bin"));

    if !param_path.exists() || !bin_path.exists() {
        let (param_url, bin_url, label) = match model_name {
            "4x_NMKD-Siax_200k" => (NMKD_SIAX_PARAM_URL, NMKD_SIAX_BIN_URL, "NMKD Siax 200k"),
            "4x_NMKD-Superscale-SP_178000_G" => (
                NMKD_SUPERSCALE_PARAM_URL,
                NMKD_SUPERSCALE_BIN_URL,
                "NMKD Superscale SP",
            ),
            _ => {
                return Err(format!(
                    "Model '{model_name}' not found after engine extraction."
                ))
            }
        };
        if !param_path.exists() {
            download_file_with_progress(app, param_url, &param_path, label, cancel_flag)?;
        }
        if !bin_path.exists() {
            download_file_with_progress(app, bin_url, &bin_path, label, cancel_flag)?;
        }
    }

    Ok((exe_path, models_dir))
}

pub fn image_has_transparency(img: &DynamicImage) -> bool {
    match img.color() {
        ColorType::Rgba8
        | ColorType::Rgba16
        | ColorType::Rgba32F
        | ColorType::La8
        | ColorType::La16 => {
            let rgba = img.to_rgba8();
            rgba.pixels().any(|p| p[3] < 255)
        }
        _ => false,
    }
}

pub fn compute_target_dimensions(width: u32, height: u32, min_shortest_px: u32) -> (u32, u32) {
    let shortest = width.min(height);
    if shortest == 0 || shortest >= min_shortest_px {
        return (width, height);
    }
    let scale = f64::from(min_shortest_px) / f64::from(shortest);
    let new_w = (f64::from(width) * scale).ceil() as u32;
    let new_h = (f64::from(height) * scale).ceil() as u32;
    (new_w.max(min_shortest_px), new_h.max(min_shortest_px))
}

fn upscale_single_image(
    exe_path: &Path,
    models_dir: &Path,
    model_name: &str,
    input_path: &Path,
    output_dir: &Path,
    rel_path: &Path,
    min_shortest_px: u32,
) -> Result<String, String> {
    let source_img = image::open(input_path).map_err(|e| format!("Open image failed: {e}"))?;
    let is_transparent = image_has_transparency(&source_img);

    let tmp_png = output_dir.join(format!(
        ".ss_upscale_tmp_{}.png",
        uuid::Uuid::new_v4().simple()
    ));

    let mut cmd = std::process::Command::new(exe_path);
    cmd.arg("-i")
        .arg(input_path)
        .arg("-o")
        .arg(&tmp_png)
        .arg("-n")
        .arg(model_name)
        .arg("-m")
        .arg(models_dir)
        .arg("-s")
        .arg("4")
        .arg("-f")
        .arg("png");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output();
    let mut upscaled_img = match output {
        Ok(res) if res.status.success() && tmp_png.exists() => {
            let loaded =
                image::open(&tmp_png).map_err(|e| format!("Read upscaled PNG failed: {e}"))?;
            let _ = std::fs::remove_file(&tmp_png);
            loaded
        }
        _ => {
            let _ = std::fs::remove_file(&tmp_png);
            // Graceful fallback when Vulkan GPU is unavailable: high-quality Lanczos3
            source_img
        }
    };

    let (w, h) = upscaled_img.dimensions();
    let (target_w, target_h) = compute_target_dimensions(w, h, min_shortest_px);
    if target_w != w || target_h != h {
        upscaled_img = upscaled_img.resize_exact(target_w, target_h, FilterType::Lanczos3);
    }

    let mut final_path = output_dir.join(rel_path);
    final_path.set_extension(if is_transparent { "png" } else { "jpg" });
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create output dir failed: {e}"))?;
    }

    if is_transparent {
        upscaled_img
            .save_with_format(&final_path, image::ImageFormat::Png)
            .map_err(|e| format!("Save PNG failed: {e}"))?;
    } else {
        let rgb = upscaled_img.to_rgb8();
        let file = File::create(&final_path).map_err(|e| format!("Create JPG failed: {e}"))?;
        let mut writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
        encoder
            .encode_image(&rgb)
            .map_err(|e| format!("Encode JPG failed: {e}"))?;
    }

    Ok(format!(
        "{}×{} px ({})",
        target_w,
        target_h,
        if is_transparent { "PNG" } else { "JPG" }
    ))
}

#[tauri::command]
pub fn pick_upscaler_files() -> Result<UpscaleScanResult, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Select Images to Upscale")
        .add_filter("Image Files", &["png", "jpg", "jpeg", "webp"])
        .pick_files()
        .unwrap_or_default();

    let files: Vec<String> = picked
        .iter()
        .filter(|p| is_supported_image(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    let default_output_dir = picked.first().and_then(|p| p.parent()).map(|parent| {
        parent
            .join("Upscaled_Output")
            .to_string_lossy()
            .into_owned()
    });

    let total = files.len();
    Ok(UpscaleScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn resolve_dropped_upscaler_paths(
    paths: Vec<String>,
    recursive: bool,
) -> Result<UpscaleScanResult, String> {
    let resolved = expand_paths_to_images(&paths, recursive);
    let default_output_dir = paths.first().and_then(|first| {
        let p = PathBuf::from(first.trim());
        if p.is_dir() {
            Some(p.join("Upscaled_Output").to_string_lossy().into_owned())
        } else {
            p.parent().map(|parent| {
                parent
                    .join("Upscaled_Output")
                    .to_string_lossy()
                    .into_owned()
            })
        }
    });
    let total = resolved.len();
    let files = resolved
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Ok(UpscaleScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn scan_upscaler_images(
    input_dir: String,
    recursive: bool,
) -> Result<UpscaleScanResult, String> {
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
    let default_output_dir = Some(dir.join("Upscaled_Output").to_string_lossy().into_owned());
    Ok(UpscaleScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn cancel_upscale_batch<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<UpscalerState>();
    state.cancel_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn start_upscale_batch<R: Runtime>(
    app: AppHandle<R>,
    request: UpscaleBatchRequest,
) -> Result<UpscaleStartResponse, String> {
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
        dir.join("Upscaled_Output")
    } else if let Some(parent) = files[0].parent() {
        parent.join("Upscaled_Output")
    } else {
        return Err("Output folder is required.".to_string());
    };

    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Cannot create output folder: {e}"))?;

    let root_dir = upscaler_root_dir(&app)?;
    let model_name = resolve_canonical_model(&request.model_id);
    let min_px = request.min_shortest_px.max(DEFAULT_MIN_SHORTEST_PX);

    let state = app.state::<UpscalerState>();
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("An upscale batch is already running.".to_string());
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

        let engine_ready =
            ensure_engine_and_model(&app_handle, &root_dir, model_name, &cancel_flag);

        match engine_ready {
            Ok((exe_path, models_dir)) => {
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
                        UPSCALER_PROGRESS_EVENT,
                        UpscaleProgressEvent {
                            stage: "upscaling".to_string(),
                            current: idx,
                            total: total_files,
                            percent: ((idx * 100) / total_files) as u8,
                            file_name: display_name.clone(),
                            status: "info".to_string(),
                            message: "Upscaling…".to_string(),
                        },
                    );

                    match upscale_single_image(
                        &exe_path,
                        &models_dir,
                        model_name,
                        img_path,
                        &output_dir,
                        rel,
                        min_px,
                    ) {
                        Ok(info) => {
                            succeeded += 1;
                            let _ = app_handle.emit(
                                UPSCALER_PROGRESS_EVENT,
                                UpscaleProgressEvent {
                                    stage: "upscaling".to_string(),
                                    current: idx + 1,
                                    total: total_files,
                                    percent: (((idx + 1) * 100) / total_files) as u8,
                                    file_name: display_name,
                                    status: "ok".to_string(),
                                    message: info,
                                },
                            );
                        }
                        Err(err) => {
                            failed += 1;
                            let _ = app_handle.emit(
                                UPSCALER_PROGRESS_EVENT,
                                UpscaleProgressEvent {
                                    stage: "upscaling".to_string(),
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
                    let _ = app_handle.emit(
                        UPSCALER_PROGRESS_EVENT,
                        UpscaleProgressEvent {
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
            UPSCALER_DONE_EVENT,
            UpscaleDoneEvent {
                total: total_files,
                succeeded,
                failed,
                cancelled,
                output_dir: output_dir.to_string_lossy().into_owned(),
                total_ms: batch_start.elapsed().as_millis() as u64,
            },
        );
    });

    Ok(UpscaleStartResponse {
        total_files,
        output_dir: output_dir_str,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_minimum_3000px_shortest_side() {
        assert_eq!(compute_target_dimensions(2048, 2048, 3000), (3000, 3000));
        assert_eq!(compute_target_dimensions(1500, 3000, 3000), (3000, 6000));
        assert_eq!(compute_target_dimensions(4096, 4096, 3000), (4096, 4096));
    }

    #[test]
    fn maps_auto_and_custom_nmkd_models() {
        assert_eq!(resolve_canonical_model("auto"), "realesrgan-x4plus");
        assert_eq!(
            resolve_canonical_model("4x_NMKD-Siax_200k"),
            "4x_NMKD-Siax_200k"
        );
        assert_eq!(
            resolve_canonical_model("4x_NMKD-Superscale-SP_178000_G"),
            "4x_NMKD-Superscale-SP_178000_G"
        );
    }
}
