//! Native Rust Microstock Vector Optimizer (SVG → EPS) powered by TraceDraw (`MIT OR Apache-2.0`).
//!
//! Automated 8-step microstock curator pipeline:
//! 1. Ungroup & Convert to Curves (flattens groups/clip frames, strips hidden bitmaps, pure cubic curves)
//! 2. Remove Outlines & Ghost Paths (sets stroke = none, drops invisible/empty paths, flattens opacity for EPS-10)
//! 3. Resize Proportional to 2100 pt shortest side & fit artboard to (0, 0)
//! 4. Clean Stray Micro-Objects (< 1.5 pt W & H or degenerate zero-area subpaths) + Re-fit artboard
//! 5. Close All Open Paths (`ClosePath`) & Remove Identical Duplicate Objects
//! 6. Z-Order Safe Group, Combine & Weld by Color (prevents layer inversions & EvenOdd overlap holes)
//! 7. Standard Reduce Nodes per Color (TraceDraw Bezier tolerance fitting, preserving crisp corners)
//! 8. Export Clean EPS + On-Demand Visual Audit (Before/After SVG & Wireframe inspection)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracedraw_core::document::{Shape, ShapeKind};
use tracedraw_core::geometry::{Affine, BezPath, PathEl, Point, Rect, Shape as KurboShape, Size};
use tracedraw_core::id::IdSource;
use tracedraw_core::nodes;
use tracedraw_core::shaping::{self, FillRule, Op};
use tracedraw_core::{Color, Document, Fill};

pub const CONVERTER_PROGRESS_EVENT: &str = "stockstudio-converter-progress";
pub const CONVERTER_DONE_EVENT: &str = "stockstudio-converter-done";
pub const DEFAULT_MIN_SIZE_PT: f64 = 2100.0;
const PT_TO_MM: f64 = 25.4 / 72.0;
/// Micro-debris threshold on a 2100 pt artboard (1.5 pt ≈ 0.529 mm).
const STRAY_THRESHOLD_PT: f64 = 1.5;
/// Tight Reduce Nodes deviation tolerance on a 2100 pt artboard (0.10 pt ≈ 0.035 mm).
/// Keeps adjacent color boundaries locked with zero visible sliver gaps while removing redundant nodes.
const REDUCE_NODES_TOLERANCE_PT: f64 = 0.10;
/// Quantization step (mm) for duplicate subpath detection (~0.14 pt).
const DUPLICATE_QUANT_MM: f64 = 0.05;
/// Guard for geometric boolean weld on ultra-dense raw paths so batch runs stay responsive.
const MAX_WELD_ELEMENTS: usize = 2500;

pub struct ConverterState {
    running: Arc<AtomicBool>,
    cancel_requested: Arc<AtomicBool>,
}

impl Default for ConverterState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VectorOptimizerMode {
    #[default]
    LogoMascot,
    Pattern,
}

impl VectorOptimizerMode {
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pattern" => Self::Pattern,
            _ => Self::LogoMascot,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::LogoMascot => "logo-mascot",
            Self::Pattern => "pattern",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ConvertBatchRequest {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub input_dir: Option<String>,
    pub output_dir: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_true")]
    pub recursive: bool,
    #[serde(default = "default_true")]
    pub up_size: bool,
    #[serde(default = "default_min_size_pt")]
    pub min_size_pt: f64,
    #[serde(default = "default_true")]
    pub remove_outlines: bool,
    #[serde(default = "default_true")]
    pub combine_by_color: bool,
    #[serde(default = "default_true")]
    pub overwrite_existing: bool,
}

fn default_mode() -> String {
    "logo-mascot".to_string()
}

fn default_true() -> bool {
    true
}

fn default_min_size_pt() -> f64 {
    DEFAULT_MIN_SIZE_PT
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct VectorOptimizeStats {
    pub width_pt: f64,
    pub height_pt: f64,
    pub shapes_before: usize,
    pub shapes_after: usize,
    pub nodes_before: usize,
    pub nodes_after: usize,
    pub stray_removed: usize,
    pub duplicates_removed: usize,
    pub open_paths_closed: usize,
    pub colors_count: usize,
    pub background_solidified: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct OptimizedFileRecord {
    pub file_name: String,
    pub input_path: String,
    pub output_path: String,
    pub stats: VectorOptimizeStats,
}

#[derive(Clone, Debug, Serialize)]
pub struct VectorAuditPreview {
    pub file_name: String,
    pub before_svg: String,
    pub after_svg: String,
    pub stats: VectorOptimizeStats,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConvertBatchStartResponse {
    pub total_files: usize,
    pub output_dir: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConvertProgressEvent {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
    pub output_path: Option<String>,
    pub status: String,
    pub message: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConvertDoneEvent {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub output_dir: String,
    pub total_ms: u64,
    pub shapes_before: usize,
    pub shapes_after: usize,
    pub nodes_before: usize,
    pub nodes_after: usize,
    pub stray_removed: usize,
    pub duplicates_removed: usize,
    pub open_paths_closed: usize,
    pub backgrounds_solidified: usize,
    pub mode: String,
    pub last_error: Option<String>,
    pub files: Vec<OptimizedFileRecord>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanResult {
    pub files: Vec<String>,
    pub total: usize,
    pub default_output_dir: Option<String>,
}

fn is_svg_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("svg"))
            .unwrap_or(false)
}

fn collect_svg_files_recursive(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recursive {
                collect_svg_files_recursive(&path, true, out);
            }
        } else if is_svg_file(&path) {
            out.push(path);
        }
    }
}

pub fn scan_svg_paths(input_dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if input_dir.is_dir() {
        collect_svg_files_recursive(input_dir, recursive, &mut files);
    }
    files.sort_by(|a, b| {
        a.to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&b.to_string_lossy().to_ascii_lowercase())
    });
    files
}

fn expand_paths_to_svgs(raw_paths: &[String], recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for raw in raw_paths {
        let p = PathBuf::from(raw.trim());
        if p.is_dir() {
            collect_svg_files_recursive(&p, recursive, &mut files);
        } else if is_svg_file(&p) {
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

fn split_subpaths(path: &BezPath) -> Vec<BezPath> {
    let mut result = Vec::new();
    let mut current: Option<BezPath> = None;

    for el in path.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                if let Some(sub) = current.take() {
                    if !sub.elements().is_empty() {
                        result.push(sub);
                    }
                }
                let mut sub = BezPath::new();
                sub.move_to(p);
                current = Some(sub);
            }
            other => {
                if let Some(sub) = current.as_mut() {
                    sub.push(other);
                }
            }
        }
    }

    if let Some(sub) = current {
        if !sub.elements().is_empty() {
            result.push(sub);
        }
    }
    result
}

fn append_path(target: &mut BezPath, src: &BezPath) {
    for el in src.elements() {
        target.push(*el);
    }
}

fn count_path_nodes(path: &BezPath) -> usize {
    nodes::nodes(path).len()
}

fn subpath_distinct_point_count(sub: &BezPath) -> usize {
    let mut pts: Vec<Point> = Vec::new();
    for el in sub.elements() {
        let p = match *el {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => Some(p),
            PathEl::QuadTo(_, p) | PathEl::CurveTo(_, _, p) => Some(p),
            PathEl::ClosePath => None,
        };
        if let Some(pt) = p {
            if !pts.iter().any(|prev| (*prev - pt).hypot() < 1e-4) {
                pts.push(pt);
            }
        }
    }
    pts.len()
}

fn subpath_is_closed(sub: &BezPath) -> bool {
    matches!(sub.elements().last(), Some(PathEl::ClosePath))
}

fn ensure_subpath_closed(sub: &mut BezPath) -> bool {
    if subpath_is_closed(sub) {
        false
    } else {
        sub.close_path();
        true
    }
}

fn subpath_is_stray(sub: &BezPath, stray_mm: f64) -> bool {
    let bb = sub.bounding_box();
    if !bb.width().is_finite() || !bb.height().is_finite() {
        return true;
    }
    if bb.width() < stray_mm && bb.height() < stray_mm {
        return true;
    }
    let has_curve = sub
        .elements()
        .iter()
        .any(|el| matches!(el, PathEl::CurveTo(..) | PathEl::QuadTo(..)));
    let distinct = subpath_distinct_point_count(sub);
    if !has_curve && distinct < 3 {
        return true;
    }
    if has_curve && distinct < 2 {
        return true;
    }
    false
}

/// Blends semi-transparent solid RGB colors over white so EPS-10 contains zero unsupported opacity.
fn flatten_solid_opacity(color: Color, opacity: f64) -> Color {
    let a = opacity.clamp(0.0, 1.0);
    if a >= 0.999 {
        return color;
    }
    let [r, g, b] = color.to_rgb8();
    let blend = |ch: u8| -> f32 {
        let v = (ch as f64 / 255.0) * a + (1.0 - a);
        v.clamp(0.0, 1.0) as f32
    };
    Color::Rgb {
        r: blend(r),
        g: blend(g),
        b: blend(b),
    }
}

struct FlattenedCurve {
    fill: Fill,
    solid_rgb: Option<[u8; 3]>,
    opacity: f64,
    fill_rule: FillRule,
    path: BezPath,
}

/// Step 1 & 2: Recursively ungroups all groups/clip-frames, strips embedded bitmaps,
/// converts every vector primitive/text into pure cubic curves, strips outlines,
/// drops ghost/invisible paths, and flattens solid opacity for EPS-10 safety.
fn ungroup_convert_and_strip(
    shapes: Vec<Shape>,
    parent_transform: Affine,
    parent_opacity: f64,
    remove_outlines: bool,
    out: &mut Vec<FlattenedCurve>,
    shapes_before: &mut usize,
    nodes_before: &mut usize,
) {
    for mut shape in shapes {
        if !shape.visible {
            continue;
        }
        let eff_opacity = (parent_opacity * shape.opacity).clamp(0.0, 1.0);
        if eff_opacity <= 0.001 {
            continue;
        }

        match shape.kind {
            ShapeKind::Group { children } => {
                let xform = parent_transform * shape.transform;
                ungroup_convert_and_strip(
                    children,
                    xform,
                    eff_opacity,
                    remove_outlines,
                    out,
                    shapes_before,
                    nodes_before,
                );
            }
            ShapeKind::ClipFrame { contents, .. } => {
                let xform = parent_transform * shape.transform;
                ungroup_convert_and_strip(
                    contents,
                    xform,
                    eff_opacity,
                    remove_outlines,
                    out,
                    shapes_before,
                    nodes_before,
                );
            }
            ShapeKind::Bitmap { .. } => {
                // Drop embedded raster bitmaps so EPS-10 remains 100% pure vector.
                continue;
            }
            _ => {
                if parent_transform != Affine::IDENTITY {
                    shape.transform_by(parent_transform);
                }
                let raw_path = nodes::normalize(&shape.page_path());
                if raw_path.elements().is_empty() {
                    continue;
                }

                *shapes_before += 1;
                *nodes_before += count_path_nodes(&raw_path);

                if remove_outlines {
                    shape.stroke = None;
                }

                // Drop ghost / invisible paths that have no fill after outline removal.
                if matches!(shape.fill, Fill::None) {
                    continue;
                }

                let (fill, solid_rgb, final_opacity) = match shape.fill {
                    Fill::Solid(c) => {
                        let flat_c = flatten_solid_opacity(c, eff_opacity);
                        let rgb = flat_c.to_rgb8();
                        (Fill::Solid(flat_c), Some(rgb), 1.0)
                    }
                    other => (other, None, eff_opacity),
                };

                out.push(FlattenedCurve {
                    fill,
                    solid_rgb,
                    opacity: final_opacity,
                    fill_rule: shape.fill_rule,
                    path: raw_path,
                });
            }
        }
    }
}

fn curves_bounding_box(curves: &[FlattenedCurve]) -> Option<Rect> {
    let mut union: Option<Rect> = None;
    for c in curves {
        let b = c.path.bounding_box();
        if b.width().is_finite() && b.height().is_finite() && (b.width() > 0.0 || b.height() > 0.0)
        {
            union = Some(match union {
                Some(acc) => acc.union(b),
                None => b,
            });
        }
    }
    union
}

/// Scales proportionally so shortest side equals `target_size_pt` (2100 pt) and aligns origin to (0, 0).
fn resize_and_fit_curves(curves: &mut [FlattenedCurve], target_size_pt: f64) -> (f64, f64) {
    let Some(bounds) = curves_bounding_box(curves) else {
        return (0.0, 0.0);
    };
    let w0 = bounds.width();
    let h0 = bounds.height();
    let shortest = w0.min(h0);
    if shortest <= 0.0 || !shortest.is_finite() {
        return (w0, h0);
    }

    let target_mm = target_size_pt.max(0.0) * PT_TO_MM;
    let scale = if target_mm > 0.0 {
        (target_mm / shortest) * 1.0002
    } else {
        1.0
    };

    let transform = Affine::scale(scale) * Affine::translate((-bounds.x0, -bounds.y0));
    for c in curves.iter_mut() {
        c.path.apply_affine(transform);
    }

    (w0 * scale, h0 * scale)
}

fn rects_overlap(a: Rect, b: Rect) -> bool {
    let inter = a.intersect(b);
    inter.width() > 1e-4 && inter.height() > 1e-4
}

fn duplicate_fingerprint(rgb: [u8; 3], sub: &BezPath) -> ([u8; 3], i64, i64, i64, i64, i64, usize) {
    let bb = sub.bounding_box();
    let q = |v: f64| -> i64 { (v / DUPLICATE_QUANT_MM).round() as i64 };
    let area_q = (sub.area().abs() / (DUPLICATE_QUANT_MM * DUPLICATE_QUANT_MM)).round() as i64;
    (
        rgb,
        q(bb.x0),
        q(bb.y0),
        q(bb.x1),
        q(bb.y1),
        area_q,
        sub.elements().len(),
    )
}

/// Evaluates whether a point lies inside the *filled* region of a (possibly compound) path
/// respecting its `FillRule` (so points inside an EvenOdd cutout hole return `false`!).
fn point_in_filled_path(path: &BezPath, pt: Point, fill_rule: FillRule) -> bool {
    if !path.bounding_box().contains(pt) {
        return false;
    }
    let w = path.winding(pt);
    match fill_rule {
        FillRule::EvenOdd => (w & 1) != 0,
        FillRule::NonZero => w != 0,
    }
}

/// Samples representative *actually filled* interior points of a path (filtering out points
/// that fall inside EvenOdd/NonZero cutout holes!) for fast geometric overlap tests.
fn sample_path_points(path: &BezPath, fill_rule: FillRule) -> Vec<Point> {
    let mut pts = Vec::new();
    for sub in split_subpaths(path) {
        let bb = sub.bounding_box();
        if bb.width().is_finite() && bb.height().is_finite() {
            let center = bb.center();
            if point_in_filled_path(path, center, fill_rule) {
                pts.push(center);
            }
        }
        // Sample up to 6 anchor points around the subpath slightly nudged toward center
        let center = bb.center();
        let mut count = 0usize;
        for el in sub.elements() {
            if count >= 6 {
                break;
            }
            let p = match *el {
                PathEl::MoveTo(p) | PathEl::LineTo(p) => Some(p),
                PathEl::QuadTo(_, p) | PathEl::CurveTo(_, _, p) => Some(p),
                PathEl::ClosePath => None,
            };
            if let Some(pt) = p {
                let nudged = pt + (center - pt) * 0.05;
                if point_in_filled_path(path, nudged, fill_rule) {
                    pts.push(nudged);
                    count += 1;
                }
            }
        }
    }
    pts
}

/// Exact geometric interior overlap test between two filled paths (respecting cutout holes!).
/// Returns `true` ONLY when their actual filled interiors overlap by more than a tiny sliver
/// (> 0.25 mm²), NEVER false-triggering on concave bounding boxes or dots inside hollow cutouts.
fn paths_geometrically_overlap(
    a: &BezPath,
    a_rule: FillRule,
    b: &BezPath,
    b_rule: FillRule,
) -> bool {
    let bb_a = a.bounding_box();
    let bb_b = b.bounding_box();
    if !rects_overlap(bb_a, bb_b) {
        return false;
    }

    // Fast path: check sampled filled points of B inside filled A and vice versa
    for pt in sample_path_points(b, b_rule) {
        if point_in_filled_path(a, pt, a_rule) {
            return true;
        }
    }
    for pt in sample_path_points(a, a_rule) {
        if point_in_filled_path(b, pt, b_rule) {
            return true;
        }
    }

    // Exact polygon intersection fallback for edge-crossing overlaps (e.g. X-crosses)
    let total_els = a.elements().len() + b.elements().len();
    if total_els <= MAX_WELD_ELEMENTS {
        let rule = if a_rule == FillRule::EvenOdd || b_rule == FillRule::EvenOdd {
            FillRule::EvenOdd
        } else {
            FillRule::NonZero
        };
        let inter = shaping::overlay_with(a, b, Op::Intersect, rule);
        return inter.area().abs() > 0.25;
    }

    false
}

/// Welds ONLY same-color paths that genuinely overlap in filled interior area (respecting
/// their original `FillRule` so cutout holes are NEVER filled!), while directly combining
/// disjoint shapes and shapes sitting inside hollow cutouts.
fn combine_or_weld_same_color(paths: Vec<(BezPath, FillRule)>) -> (BezPath, FillRule) {
    if paths.is_empty() {
        return (BezPath::new(), FillRule::NonZero);
    }
    if paths.len() == 1 {
        return paths.into_iter().next().unwrap();
    }

    let out_rule = if paths.iter().any(|(_, r)| *r == FillRule::EvenOdd) {
        FillRule::EvenOdd
    } else {
        FillRule::NonZero
    };

    // Group into connected clusters based on REAL geometric interior overlap (not crude bbox!)
    let mut clusters: Vec<Vec<(BezPath, FillRule)>> = Vec::new();
    for (p, r) in paths {
        let mut touching_indices: Vec<usize> = Vec::new();
        for (idx, cluster) in clusters.iter().enumerate() {
            if cluster
                .iter()
                .any(|(cp, cr)| paths_geometrically_overlap(cp, *cr, &p, r))
            {
                touching_indices.push(idx);
            }
        }
        if touching_indices.is_empty() {
            clusters.push(vec![(p, r)]);
        } else {
            let primary = touching_indices[0];
            clusters[primary].push((p, r));
            for &merge_idx in touching_indices.iter().skip(1).rev() {
                let moved = clusters.remove(merge_idx);
                clusters[primary].extend(moved);
            }
        }
    }

    let mut combined = BezPath::new();
    for cluster in clusters {
        if cluster.len() == 1 {
            append_path(&mut combined, &cluster[0].0);
            continue;
        }
        let total_els: usize = cluster.iter().map(|(p, _)| p.elements().len()).sum();
        let cluster_rule = if cluster.iter().any(|(_, r)| *r == FillRule::EvenOdd) {
            FillRule::EvenOdd
        } else {
            FillRule::NonZero
        };
        if total_els <= MAX_WELD_ELEMENTS {
            let mut acc = cluster[0].0.clone();
            let mut weld_ok = true;
            for (next, _) in cluster.iter().skip(1) {
                let welded = shaping::overlay_with(&acc, next, Op::Weld, cluster_rule);
                if welded.elements().is_empty() {
                    weld_ok = false;
                    break;
                }
                acc = welded;
            }
            if weld_ok && !acc.elements().is_empty() {
                append_path(&mut combined, &acc);
                continue;
            }
        }
        for (p, _) in cluster {
            append_path(&mut combined, &p);
        }
    }
    (combined, out_rule)
}

/// Step 7: Tight Reduce Nodes per subpath, keeping crisp geometric primitives (<= 4 nodes) intact.
fn reduce_nodes_standard(path: &BezPath, tolerance_mm: f64) -> BezPath {
    let mut out = BezPath::new();
    for sub in split_subpaths(path) {
        let norm = nodes::normalize(&sub);
        let node_count = count_path_nodes(&norm);
        let mut reduced = if node_count > 4 {
            let candidate = nodes::reduce_nodes(&norm, tolerance_mm);
            if candidate.elements().is_empty() {
                norm
            } else {
                candidate
            }
        } else {
            norm
        };
        let _ = ensure_subpath_closed(&mut reduced);
        append_path(&mut out, &reduced);
    }
    out
}

/// Checks whether a subpath touches any outer edge of the artboard (within 1.5% margin).
fn subpath_touches_canvas_edge(bb: Rect, page_w: f64, page_h: f64) -> bool {
    let mx = page_w * 0.015;
    let my = page_h * 0.015;
    bb.x0 <= mx || bb.y0 <= my || bb.x1 >= page_w - mx || bb.y1 >= page_h - my
}

/// Checks if a point lies inside a single closed subpath (independent fill, ignoring winding sign).
fn point_in_subpath(sub: &BezPath, pt: Point) -> bool {
    sub.bounding_box().contains(pt) && sub.winding(pt) != 0
}

/// Performs CorelDRAW-style "Combine -> Break Apart -> Weld" on a background path:
/// breaks the compound path into independent closed subpaths, then welds them together
/// so every interior cutout hole inside the outer silhouette is filled completely solid.
fn break_apart_and_weld_solid(path: &BezPath) -> BezPath {
    let subs = split_subpaths(path);
    if subs.len() <= 1 {
        return path.clone();
    }

    // Sort descending by enclosed area so the outer boundary comes first.
    let mut ranked: Vec<(f64, Rect, BezPath)> = subs
        .into_iter()
        .map(|s| (s.area().abs(), s.bounding_box(), s))
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // Break apart: drop any subpath strictly contained inside a larger outer boundary
    // (those are interior cutout holes), and weld any non-contained sibling pieces.
    let mut kept_outers: Vec<(Rect, BezPath)> = Vec::new();
    for (_, bb, sub) in ranked {
        let probe = bb.center();
        let inside_existing = kept_outers.iter().any(|(outer_bb, outer_path)| {
            outer_bb.x0 <= bb.x0 + 1e-3
                && outer_bb.y0 <= bb.y0 + 1e-3
                && outer_bb.x1 >= bb.x1 - 1e-3
                && outer_bb.y1 >= bb.y1 - 1e-3
                && point_in_subpath(outer_path, probe)
        });
        if !inside_existing {
            kept_outers.push((bb, sub));
        }
    }

    if kept_outers.len() == 1 {
        return kept_outers.into_iter().next().unwrap().1;
    }

    let outer_paths: Vec<(BezPath, FillRule)> = kept_outers
        .into_iter()
        .map(|(_, p)| (p, FillRule::NonZero))
        .collect();
    combine_or_weld_same_color(outer_paths).0
}

/// Scales a Pattern SVG proportionally to `target_size_pt` shortest side while locking the
/// declared tile artboard frame (when valid) so seamless repeat borders never shift.
fn resize_pattern_tile(
    curves: &mut [FlattenedCurve],
    declared_size: Size,
    target_size_pt: f64,
) -> (f64, f64) {
    let dw = declared_size.width;
    let dh = declared_size.height;
    if dw.is_finite() && dh.is_finite() && dw > 0.0 && dh > 0.0 {
        if let Some(bounds) = curves_bounding_box(curves) {
            let within_tile = bounds.x0 >= -dw * 0.25
                && bounds.y0 >= -dh * 0.25
                && bounds.x1 <= dw * 1.25
                && bounds.y1 <= dh * 1.25;
            if within_tile {
                let shortest = dw.min(dh);
                let target_mm = target_size_pt.max(0.0) * PT_TO_MM;
                let scale = if target_mm > 0.0 {
                    (target_mm / shortest) * 1.0002
                } else {
                    1.0
                };
                let transform = Affine::scale(scale);
                for c in curves.iter_mut() {
                    c.path.apply_affine(transform);
                }
                return (dw * scale, dh * scale);
            }
        }
    }
    resize_and_fit_curves(curves, target_size_pt)
}

/// Auto-detects whether a Logo/Mascot artwork has a full-canvas background (not an isolated
/// icon/wreath/frame), extracts it BEFORE foreground color combining, and solidifies it via
/// Combine -> Break Apart -> Weld so Layer 0 is 100% solid with zero cutout holes.
fn extract_and_solidify_background_curves(
    curves: &mut Vec<FlattenedCurve>,
    page_w: f64,
    page_h: f64,
    ids: &mut IdSource,
) -> Option<Shape> {
    if page_w <= 0.0 || page_h <= 0.0 {
        return None;
    }

    // Guard: an isolated single-color frame/border has no foreground shapes inside it.
    let mut distinct_colors: HashSet<[u8; 3]> = HashSet::new();
    let mut non_solid_count = 0usize;
    for c in curves.iter() {
        if let Some(rgb) = c.solid_rgb {
            distinct_colors.insert(rgb);
        } else {
            non_solid_count += 1;
        }
    }
    if distinct_colors.len() + non_solid_count < 2 {
        return None;
    }

    let canvas_area = page_w * page_h;

    // Pattern 1: Scan for a solid curve whose outer contour spans >= 92% W x >= 92% H
    // and covers >= 85% of the canvas area (rectangle or rounded-rect backdrop, never a circle ~78% or wreath),
    // even if it isn't literally at index 0 in the source SVG!
    let mut full_bg_match: Option<(usize, Color, [u8; 3])> = None;
    for (idx, curve) in curves.iter().enumerate() {
        let (Fill::Solid(bg_color), Some(bg_rgb)) = (curve.fill.clone(), curve.solid_rgb) else {
            continue;
        };
        let subs = split_subpaths(&curve.path);
        let max_outer = subs
            .iter()
            .map(|s| (s.area().abs(), s.bounding_box()))
            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        if let Some((outer_area, outer_bb)) = max_outer {
            let covers_canvas = outer_bb.width() >= page_w * 0.92
                && outer_bb.height() >= page_h * 0.92
                && outer_area >= canvas_area * 0.85;
            if covers_canvas {
                full_bg_match = Some((idx, bg_color, bg_rgb));
                break;
            }
        }
    }

    if let Some((bg_idx, bg_color, bg_rgb)) = full_bg_match {
        let removed = curves.remove(bg_idx);
        let solid = break_apart_and_weld_solid(&removed.path);

        // Also strip any other stray edge-touching pieces of the same background color
        // (while keeping interior foreground details of that same color, e.g. white eyes!).
        let mut remaining: Vec<FlattenedCurve> = Vec::with_capacity(curves.len());
        for mut curve in std::mem::take(curves) {
            if curve.solid_rgb == Some(bg_rgb) {
                let mut interior_only = BezPath::new();
                for sub in split_subpaths(&curve.path) {
                    if !subpath_touches_canvas_edge(sub.bounding_box(), page_w, page_h) {
                        append_path(&mut interior_only, &sub);
                    }
                }
                if !interior_only.elements().is_empty() {
                    curve.path = interior_only;
                    remaining.push(curve);
                }
            } else {
                remaining.push(curve);
            }
        }
        *curves = remaining;

        let mut bg_shape = Shape::new(
            tracedraw_core::ShapeId(ids.next()),
            ShapeKind::Path {
                path: solid,
                closed: true,
            },
        );
        bg_shape.fill = Fill::Solid(bg_color);
        bg_shape.stroke = None;
        bg_shape.opacity = 1.0;
        bg_shape.fill_rule = FillRule::NonZero;
        return Some(bg_shape);
    }

    // Pattern 2: Background was sliced into 2+ corner/edge pieces of the same solid color
    // by a full-bleed foreground subject crossing the canvas.
    let corners = [
        Point::new(page_w * 0.008, page_h * 0.008),
        Point::new(page_w * 0.992, page_h * 0.008),
        Point::new(page_w * 0.992, page_h * 0.992),
        Point::new(page_w * 0.008, page_h * 0.992),
    ];

    let mut corner_votes: Vec<(Color, [u8; 3], [bool; 4])> = Vec::new();
    for curve in curves.iter() {
        let (Fill::Solid(color), Some(rgb)) = (&curve.fill, curve.solid_rgb) else {
            continue;
        };
        let subs = split_subpaths(&curve.path);
        let mut hits = [false; 4];
        let mut any_hit = false;
        for (ci, &corner) in corners.iter().enumerate() {
            if subs.iter().any(|s| point_in_subpath(s, corner)) {
                hits[ci] = true;
                any_hit = true;
            }
        }
        if any_hit {
            if let Some(entry) = corner_votes.iter_mut().find(|(_, r, _)| *r == rgb) {
                for ci in 0..4 {
                    entry.2[ci] |= hits[ci];
                }
            } else {
                corner_votes.push((*color, rgb, hits));
            }
        }
    }

    let winner = corner_votes
        .into_iter()
        .find(|(_, _, hits)| hits.iter().filter(|&&h| h).count() >= 3);

    let (bg_color, bg_rgb, _) = winner?;

    // Verify edge-touching pieces of bg_rgb span >= 96% of artboard width & height
    let mut edge_union: Option<Rect> = None;
    for curve in curves.iter() {
        if curve.solid_rgb != Some(bg_rgb) {
            continue;
        }
        for sub in split_subpaths(&curve.path) {
            let bb = sub.bounding_box();
            if subpath_touches_canvas_edge(bb, page_w, page_h) {
                edge_union = Some(match edge_union {
                    Some(acc) => acc.union(bb),
                    None => bb,
                });
            }
        }
    }

    let u = edge_union?;
    if u.width() < page_w * 0.96 || u.height() < page_h * 0.96 {
        return None;
    }

    // Remove only the edge-touching background cutout pieces (keeping interior same-color
    // highlights like white eye sparkles safely in foreground!) and create a clean 4-node solid
    // full-artboard background rectangle for Layer 0.
    let mut bg_rect = BezPath::new();
    bg_rect.move_to(Point::new(0.0, 0.0));
    bg_rect.line_to(Point::new(page_w, 0.0));
    bg_rect.line_to(Point::new(page_w, page_h));
    bg_rect.line_to(Point::new(0.0, page_h));
    bg_rect.close_path();

    let mut bg_shape = Shape::new(
        tracedraw_core::ShapeId(ids.next()),
        ShapeKind::Path {
            path: bg_rect,
            closed: true,
        },
    );
    bg_shape.fill = Fill::Solid(bg_color);
    bg_shape.stroke = None;
    bg_shape.opacity = 1.0;
    bg_shape.fill_rule = FillRule::NonZero;

    let mut remaining: Vec<FlattenedCurve> = Vec::with_capacity(curves.len());
    for mut curve in std::mem::take(curves) {
        if curve.solid_rgb == Some(bg_rgb) {
            let mut interior_only = BezPath::new();
            for sub in split_subpaths(&curve.path) {
                if !subpath_touches_canvas_edge(sub.bounding_box(), page_w, page_h) {
                    append_path(&mut interior_only, &sub);
                }
            }
            if !interior_only.elements().is_empty() {
                curve.path = interior_only;
                remaining.push(curve);
            }
        } else {
            remaining.push(curve);
        }
    }
    *curves = remaining;

    Some(bg_shape)
}

/// Builds a clean, XSS-safe preview document from the original imported SVG (pre-optimization)
/// aligned consistently with the chosen optimization mode so Before vs After matches 1:1.
fn build_before_preview_doc(
    imported_shapes: Vec<Shape>,
    imported_size: Size,
    mode: VectorOptimizerMode,
) -> Document {
    let mut doc = Document::new("before", imported_size);
    doc.pages[0].layers[0].shapes = imported_shapes;

    if mode == VectorOptimizerMode::Pattern
        && imported_size.width.is_finite()
        && imported_size.height.is_finite()
        && imported_size.width > 0.0
        && imported_size.height > 0.0
    {
        return doc;
    }

    let artwork_bounds = doc.pages[0]
        .layers
        .iter()
        .flat_map(|l| l.shapes.iter())
        .map(|s| s.bounds())
        .filter(|b| {
            b.width().is_finite() && b.height().is_finite() && (b.width() > 0.0 || b.height() > 0.0)
        })
        .reduce(|a, b| a.union(b));

    if let Some(b) = artwork_bounds {
        let shift = Affine::translate((-b.x0, -b.y0));
        for layer in &mut doc.pages[0].layers {
            for shape in &mut layer.shapes {
                shape.transform_by(shift);
            }
        }
        doc.pages[0].size = Size::new(b.width().max(1.0), b.height().max(1.0));
    }
    doc
}

/// Runs the full 8-step Microstock Vector Optimizer pipeline and returns the optimized Document + stats.
pub fn optimize_svg_document(
    svg_text: &str,
    mode: VectorOptimizerMode,
    up_size: bool,
    min_size_pt: f64,
    remove_outlines: bool,
    combine_by_color: bool,
) -> Result<(Document, VectorOptimizeStats), String> {
    let mut ids = IdSource::default();
    let imported = tracedraw_io::svg_import::parse(svg_text, &mut ids)
        .map_err(|err| format!("SVG parse error: {err}"))?;

    let mut stats = VectorOptimizeStats::default();

    // Steps 1 & 2: Ungroup, Convert to Curves, Remove Outlines, Strip Ghost/Bitmap, Flatten Opacity
    let mut curves: Vec<FlattenedCurve> = Vec::new();
    ungroup_convert_and_strip(
        imported.shapes,
        Affine::IDENTITY,
        1.0,
        remove_outlines,
        &mut curves,
        &mut stats.shapes_before,
        &mut stats.nodes_before,
    );

    if curves.is_empty() {
        return Err("No valid vector fills found in SVG.".to_string());
    }

    // Step 3: Resize proportional to target shortest side (default 2100 pt)
    let target_pt = if up_size {
        if min_size_pt > 0.0 {
            min_size_pt
        } else {
            DEFAULT_MIN_SIZE_PT
        }
    } else {
        0.0
    };
    let (mut page_w_mm, mut page_h_mm) = if up_size {
        match mode {
            VectorOptimizerMode::Pattern => {
                resize_pattern_tile(&mut curves, imported.size, target_pt)
            }
            VectorOptimizerMode::LogoMascot => resize_and_fit_curves(&mut curves, target_pt),
        }
    } else {
        (imported.size.width, imported.size.height)
    };

    // Step 4 & 5: Clean stray micro-subpaths (< 1.5 pt), close open paths, remove identical duplicates
    let stray_mm = STRAY_THRESHOLD_PT * PT_TO_MM;
    let mut seen_duplicates: HashSet<([u8; 3], i64, i64, i64, i64, i64, usize)> = HashSet::new();
    let mut cleaned_curves: Vec<FlattenedCurve> = Vec::with_capacity(curves.len());

    for curve in curves {
        let mut kept_path = BezPath::new();
        for mut sub in split_subpaths(&curve.path) {
            if subpath_is_stray(&sub, stray_mm) {
                stats.stray_removed += 1;
                continue;
            }
            if ensure_subpath_closed(&mut sub) {
                stats.open_paths_closed += 1;
            }
            if let Some(rgb) = curve.solid_rgb {
                let fp = duplicate_fingerprint(rgb, &sub);
                if !seen_duplicates.insert(fp) {
                    stats.duplicates_removed += 1;
                    continue;
                }
            }
            append_path(&mut kept_path, &sub);
        }
        if !kept_path.elements().is_empty() {
            cleaned_curves.push(FlattenedCurve {
                fill: curve.fill,
                solid_rgb: curve.solid_rgb,
                opacity: curve.opacity,
                fill_rule: curve.fill_rule,
                path: kept_path,
            });
        }
    }

    if cleaned_curves.is_empty() {
        return Err("All shapes were removed as empty or micro-debris.".to_string());
    }

    // Re-fit artboard after stray cleanup ONLY in Logo/Mascot mode.
    // In Pattern mode, tile boundaries stay locked so seamless repeat edges never shift!
    if mode == VectorOptimizerMode::LogoMascot && up_size && stats.stray_removed > 0 {
        let (w, h) = resize_and_fit_curves(&mut cleaned_curves, target_pt);
        page_w_mm = w;
        page_h_mm = h;
    }

    // Step 6A (Logo/Mascot only): Extract & solidify full-canvas background FIRST so its
    // full-canvas bounding box never interferes with foreground same-color combining.
    let solid_bg_shape = if mode == VectorOptimizerMode::LogoMascot {
        extract_and_solidify_background_curves(&mut cleaned_curves, page_w_mm, page_h_mm, &mut ids)
    } else {
        None
    };
    stats.background_solidified = solid_bg_shape.is_some();

    // Step 6B: Group & Combine / Weld per Color according to active mode
    enum LayerSlot {
        SolidGroup {
            color: Color,
            rgb: [u8; 3],
            paths: Vec<(BezPath, FillRule)>,
        },
        Passthrough {
            curve: FlattenedCurve,
        },
    }

    impl LayerSlot {
        fn geometrically_overlaps(&self, other_path: &BezPath, other_rule: FillRule) -> bool {
            match self {
                LayerSlot::SolidGroup { paths, .. } => paths
                    .iter()
                    .any(|(p, r)| paths_geometrically_overlap(p, *r, other_path, other_rule)),
                LayerSlot::Passthrough { curve } => paths_geometrically_overlap(
                    &curve.path,
                    curve.fill_rule,
                    other_path,
                    other_rule,
                ),
            }
        }
    }

    let mut slots: Vec<LayerSlot> = Vec::new();

    if combine_by_color {
        match mode {
            VectorOptimizerMode::Pattern => {
                // Pattern mode: strict Full Global Combine (1 Color = 1 Object) in first-seen Z-order,
                // preserving all cutout holes (NO Solid BG, NO destructive NonZero hole filling).
                let mut color_to_slot: HashMap<[u8; 3], usize> = HashMap::new();
                for curve in cleaned_curves {
                    if let (Fill::Solid(color), Some(rgb)) = (curve.fill.clone(), curve.solid_rgb) {
                        if let Some(&idx) = color_to_slot.get(&rgb) {
                            if let LayerSlot::SolidGroup { paths, .. } = &mut slots[idx] {
                                paths.push((curve.path, curve.fill_rule));
                            }
                        } else {
                            let idx = slots.len();
                            color_to_slot.insert(rgb, idx);
                            slots.push(LayerSlot::SolidGroup {
                                color,
                                rgb,
                                paths: vec![(curve.path, curve.fill_rule)],
                            });
                        }
                    } else {
                        slots.push(LayerSlot::Passthrough { curve });
                    }
                }
            }
            VectorOptimizerMode::LogoMascot => {
                // Logo/Mascot mode (Option A): Smart Geometric Z-Order Safe Combine on foreground
                // shapes above the solidified background! Uses real filled-area overlap so curved
                // mosaic shapes always combine into 1 object per color while stacked details stay safe.
                for curve in cleaned_curves {
                    if let (Fill::Solid(color), Some(rgb)) = (curve.fill.clone(), curve.solid_rgb) {
                        let mut target_idx: Option<usize> = None;

                        for idx in (0..slots.len()).rev() {
                            if let LayerSlot::SolidGroup { rgb: slot_rgb, .. } = &slots[idx] {
                                if *slot_rgb == rgb {
                                    target_idx = Some(idx);
                                    break;
                                }
                            }
                            if slots[idx].geometrically_overlaps(&curve.path, curve.fill_rule) {
                                break;
                            }
                        }

                        if let Some(idx) = target_idx {
                            if let LayerSlot::SolidGroup { paths, .. } = &mut slots[idx] {
                                paths.push((curve.path, curve.fill_rule));
                            }
                        } else {
                            slots.push(LayerSlot::SolidGroup {
                                color,
                                rgb,
                                paths: vec![(curve.path, curve.fill_rule)],
                            });
                        }
                    } else {
                        slots.push(LayerSlot::Passthrough { curve });
                    }
                }
            }
        }
    } else {
        for curve in cleaned_curves {
            slots.push(LayerSlot::Passthrough { curve });
        }
    }

    // Build final merged color shapes (Layer 0 = solidified background if detected, then foreground)
    let mut merged_shapes: Vec<Shape> = Vec::with_capacity(slots.len() + 1);
    let mut unique_colors: HashSet<[u8; 3]> = HashSet::new();

    if let Some(bg) = solid_bg_shape {
        if let Fill::Solid(c) = bg.fill {
            unique_colors.insert(c.to_rgb8());
        }
        merged_shapes.push(bg);
    }

    for slot in slots {
        match slot {
            LayerSlot::SolidGroup {
                color, rgb, paths, ..
            } => {
                unique_colors.insert(rgb);
                let (merged, merged_rule) = combine_or_weld_same_color(paths);
                if merged.elements().is_empty() {
                    continue;
                }
                let mut s = Shape::new(
                    tracedraw_core::ShapeId(ids.next()),
                    ShapeKind::Path {
                        path: merged,
                        closed: true,
                    },
                );
                s.fill = Fill::Solid(color);
                s.stroke = None;
                s.opacity = 1.0;
                s.fill_rule = merged_rule;
                merged_shapes.push(s);
            }
            LayerSlot::Passthrough { curve } => {
                if let Some(rgb) = curve.solid_rgb {
                    unique_colors.insert(rgb);
                }
                if curve.path.elements().is_empty() {
                    continue;
                }
                let mut s = Shape::new(
                    tracedraw_core::ShapeId(ids.next()),
                    ShapeKind::Path {
                        path: curve.path,
                        closed: true,
                    },
                );
                s.fill = curve.fill;
                s.stroke = None;
                s.opacity = curve.opacity;
                s.fill_rule = curve.fill_rule;
                merged_shapes.push(s);
            }
        }
    }

    // Step 7: Tight Reduce Nodes per color (0.10 pt tolerance prevents color seam gaps)
    let reduce_tol_mm = REDUCE_NODES_TOLERANCE_PT * PT_TO_MM;
    let mut final_shapes: Vec<Shape> = Vec::with_capacity(merged_shapes.len());
    let mut nodes_after = 0usize;

    for mut shape in merged_shapes {
        if let ShapeKind::Path { path, .. } = &shape.kind {
            let reduced = reduce_nodes_standard(path, reduce_tol_mm);
            if reduced.elements().is_empty() {
                continue;
            }
            nodes_after += count_path_nodes(&reduced);
            shape.kind = ShapeKind::Path {
                path: reduced,
                closed: true,
            };
        }
        final_shapes.push(shape);
    }

    let mut doc = Document::new("vector-optimized", Size::new(page_w_mm, page_h_mm));
    doc.pages[0].layers[0].shapes = final_shapes;

    stats.width_pt = page_w_mm / PT_TO_MM;
    stats.height_pt = page_h_mm / PT_TO_MM;
    stats.shapes_after = doc.pages[0].layers[0].shapes.len();
    stats.nodes_after = nodes_after;
    stats.colors_count = unique_colors.len();

    Ok((doc, stats))
}

pub fn convert_svg_string_to_eps(
    svg_text: &str,
    mode: VectorOptimizerMode,
    up_size: bool,
    min_size_pt: f64,
    remove_outlines: bool,
    combine_by_color: bool,
) -> Result<(String, VectorOptimizeStats), String> {
    let (doc, stats) = optimize_svg_document(
        svg_text,
        mode,
        up_size,
        min_size_pt,
        remove_outlines,
        combine_by_color,
    )?;

    let eps = tracedraw_io::eps::page_to_eps(&doc, 0);
    if eps.trim().is_empty() {
        return Err("Empty EPS output generated.".to_string());
    }
    Ok((eps, stats))
}

fn read_svg_lossy(svg_path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(svg_path).map_err(|e| format!("Read failed: {e}"))?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned(),
    })
}

fn convert_single_file(
    svg_path: &Path,
    eps_path: &Path,
    mode: VectorOptimizerMode,
    up_size: bool,
    min_size_pt: f64,
    remove_outlines: bool,
    combine_by_color: bool,
) -> Result<VectorOptimizeStats, String> {
    let svg_text = read_svg_lossy(svg_path)?;
    let (eps_content, stats) = convert_svg_string_to_eps(
        &svg_text,
        mode,
        up_size,
        min_size_pt,
        remove_outlines,
        combine_by_color,
    )?;

    if let Some(parent) = eps_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create output dir failed: {e}"))?;
    }
    let tmp_path = eps_path.with_extension("eps.tmp");
    std::fs::write(&tmp_path, eps_content.as_bytes())
        .map_err(|e| format!("Write EPS failed: {e}"))?;
    std::fs::rename(&tmp_path, eps_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Finalize EPS failed: {e}")
    })?;

    Ok(stats)
}

/// On-demand Visual Audit generator: returns safe Before SVG & Optimized After SVG + stats
/// without adding memory or disk overhead to batch processing.
#[tauri::command]
pub fn preview_vector_audit(
    input_path: String,
    mode: Option<String>,
) -> Result<VectorAuditPreview, String> {
    let path = PathBuf::from(input_path.trim());
    if !is_svg_file(&path) {
        return Err("Selected file is not a valid SVG.".to_string());
    }
    let svg_text = read_svg_lossy(&path)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "vector.svg".to_string());

    let parsed_mode = VectorOptimizerMode::from_str_lossy(mode.as_deref().unwrap_or("logo-mascot"));

    let mut before_ids = IdSource::default();
    let imported = tracedraw_io::svg_import::parse(&svg_text, &mut before_ids)
        .map_err(|err| format!("SVG parse error: {err}"))?;
    let before_doc = build_before_preview_doc(imported.shapes, imported.size, parsed_mode);
    let before_svg = tracedraw_io::svg::page_to_svg(&before_doc, 0);

    let (after_doc, stats) = optimize_svg_document(
        &svg_text,
        parsed_mode,
        true,
        DEFAULT_MIN_SIZE_PT,
        true,
        true,
    )?;
    let after_svg = tracedraw_io::svg::page_to_svg(&after_doc, 0);

    Ok(VectorAuditPreview {
        file_name,
        before_svg,
        after_svg,
        stats,
    })
}

#[tauri::command]
pub fn pick_converter_files() -> Result<ScanResult, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Select SVG Files to Optimize")
        .add_filter("SVG Vector Files", &["svg"])
        .pick_files()
        .unwrap_or_default();

    let files: Vec<String> = picked
        .iter()
        .filter(|p| is_svg_file(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    let default_output_dir = picked
        .first()
        .and_then(|p| p.parent())
        .map(|parent| parent.join("EPS_Output").to_string_lossy().into_owned());

    let total = files.len();
    Ok(ScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn pick_converter_folder(title: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
        dialog = dialog.set_title(t);
    }
    Ok(dialog
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn resolve_dropped_converter_paths(
    paths: Vec<String>,
    recursive: bool,
) -> Result<ScanResult, String> {
    let resolved = expand_paths_to_svgs(&paths, recursive);
    let default_output_dir = paths.first().and_then(|first| {
        let p = PathBuf::from(first.trim());
        if p.is_dir() {
            Some(p.join("EPS_Output").to_string_lossy().into_owned())
        } else {
            p.parent()
                .map(|parent| parent.join("EPS_Output").to_string_lossy().into_owned())
        }
    });
    let total = resolved.len();
    let files = resolved
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Ok(ScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn scan_converter_svgs(input_dir: String, recursive: bool) -> Result<ScanResult, String> {
    let dir = PathBuf::from(input_dir.trim());
    if !dir.is_dir() {
        return Err("Input folder does not exist.".to_string());
    }
    let paths = scan_svg_paths(&dir, recursive);
    let total = paths.len();
    let files = paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let default_output_dir = Some(dir.join("EPS_Output").to_string_lossy().into_owned());
    Ok(ScanResult {
        files,
        total,
        default_output_dir,
    })
}

#[tauri::command]
pub fn open_converter_folder(path: String) -> Result<(), String> {
    let dir = PathBuf::from(path.trim());
    if !dir.exists() {
        return Err("Folder does not exist.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_svg_to_eps_batch<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<ConverterState>();
    state.cancel_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn start_svg_to_eps_batch<R: Runtime>(
    app: AppHandle<R>,
    request: ConvertBatchRequest,
) -> Result<ConvertBatchStartResponse, String> {
    let input_dir_opt = request
        .input_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let files: Vec<PathBuf> = if !request.files.is_empty() {
        expand_paths_to_svgs(&request.files, request.recursive)
    } else if let Some(ref dir) = input_dir_opt {
        if !dir.is_dir() {
            return Err("Input folder does not exist.".to_string());
        }
        scan_svg_paths(dir, request.recursive)
    } else {
        return Err("Please select at least one SVG file or folder.".to_string());
    };

    if files.is_empty() {
        return Err("No .svg files found.".to_string());
    }

    let output_dir = if !request.output_dir.trim().is_empty() {
        PathBuf::from(request.output_dir.trim())
    } else if let Some(ref dir) = input_dir_opt {
        dir.join("EPS_Output")
    } else if let Some(parent) = files[0].parent() {
        parent.join("EPS_Output")
    } else {
        return Err("Output folder is required.".to_string());
    };

    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Cannot create output folder: {e}"))?;

    let state = app.state::<ConverterState>();
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A vector optimization batch is already running.".to_string());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    let total_files = files.len();
    let mode = VectorOptimizerMode::from_str_lossy(&request.mode);
    let output_dir_str = output_dir.to_string_lossy().into_owned();
    let running_flag = Arc::clone(&state.running);
    let cancel_flag = Arc::clone(&state.cancel_requested);
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let batch_start = Instant::now();
        let mut succeeded = 0usize;
        let mut failed = 0usize;
        let mut skipped = 0usize;
        let mut cancelled = false;
        let mut last_error: Option<String> = None;

        let mut agg_shapes_before = 0usize;
        let mut agg_shapes_after = 0usize;
        let mut agg_nodes_before = 0usize;
        let mut agg_nodes_after = 0usize;
        let mut agg_stray_removed = 0usize;
        let mut agg_duplicates_removed = 0usize;
        let mut agg_open_paths_closed = 0usize;
        let mut agg_backgrounds_solidified = 0usize;
        let mut processed_files: Vec<OptimizedFileRecord> = Vec::new();

        for (idx, svg_path) in files.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }

            let file_start = Instant::now();
            let rel = input_dir_opt
                .as_ref()
                .and_then(|dir| svg_path.strip_prefix(dir).ok())
                .unwrap_or_else(|| Path::new(svg_path.file_name().unwrap_or_default()));
            let mut eps_path = output_dir.join(rel);
            eps_path.set_extension("eps");

            let display_name = rel.to_string_lossy().into_owned();

            if !request.overwrite_existing && eps_path.exists() {
                skipped += 1;
                let _ = app_handle.emit(
                    CONVERTER_PROGRESS_EVENT,
                    ConvertProgressEvent {
                        current: idx + 1,
                        total: total_files,
                        file_name: display_name,
                        output_path: Some(eps_path.to_string_lossy().into_owned()),
                        status: "skipped".to_string(),
                        message: "Skipped".to_string(),
                        duration_ms: file_start.elapsed().as_millis() as u64,
                    },
                );
                continue;
            }

            match convert_single_file(
                svg_path,
                &eps_path,
                mode,
                request.up_size,
                request.min_size_pt,
                request.remove_outlines,
                request.combine_by_color,
            ) {
                Ok(stats) => {
                    succeeded += 1;
                    agg_shapes_before += stats.shapes_before;
                    agg_shapes_after += stats.shapes_after;
                    agg_nodes_before += stats.nodes_before;
                    agg_nodes_after += stats.nodes_after;
                    agg_stray_removed += stats.stray_removed;
                    agg_duplicates_removed += stats.duplicates_removed;
                    agg_open_paths_closed += stats.open_paths_closed;
                    if stats.background_solidified {
                        agg_backgrounds_solidified += 1;
                    }

                    let msg = format!(
                        "{:.0}×{:.0} pt · {}→{} nodes",
                        stats.width_pt, stats.height_pt, stats.nodes_before, stats.nodes_after
                    );
                    processed_files.push(OptimizedFileRecord {
                        file_name: display_name.clone(),
                        input_path: svg_path.to_string_lossy().into_owned(),
                        output_path: eps_path.to_string_lossy().into_owned(),
                        stats,
                    });
                    let _ = app_handle.emit(
                        CONVERTER_PROGRESS_EVENT,
                        ConvertProgressEvent {
                            current: idx + 1,
                            total: total_files,
                            file_name: display_name,
                            output_path: Some(eps_path.to_string_lossy().into_owned()),
                            status: "ok".to_string(),
                            message: msg,
                            duration_ms: file_start.elapsed().as_millis() as u64,
                        },
                    );
                }
                Err(err) => {
                    failed += 1;
                    last_error = Some(err.clone());
                    let _ = app_handle.emit(
                        CONVERTER_PROGRESS_EVENT,
                        ConvertProgressEvent {
                            current: idx + 1,
                            total: total_files,
                            file_name: display_name,
                            output_path: None,
                            status: "error".to_string(),
                            message: err,
                            duration_ms: file_start.elapsed().as_millis() as u64,
                        },
                    );
                }
            }
        }

        running_flag.store(false, Ordering::SeqCst);
        let _ = app_handle.emit(
            CONVERTER_DONE_EVENT,
            ConvertDoneEvent {
                total: total_files,
                succeeded,
                failed,
                skipped,
                cancelled,
                output_dir: output_dir.to_string_lossy().into_owned(),
                total_ms: batch_start.elapsed().as_millis() as u64,
                shapes_before: agg_shapes_before,
                shapes_after: agg_shapes_after,
                nodes_before: agg_nodes_before,
                nodes_after: agg_nodes_after,
                stray_removed: agg_stray_removed,
                duplicates_removed: agg_duplicates_removed,
                open_paths_closed: agg_open_paths_closed,
                backgrounds_solidified: agg_backgrounds_solidified,
                mode: mode.as_str().to_string(),
                last_error,
                files: processed_files,
            },
        );
    });

    Ok(ConvertBatchStartResponse {
        total_files,
        output_dir: output_dir_str,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optimizes_svg_through_all_8_curator_steps() {
        // Contains:
        // - Nested group & stroke to strip
        // - 2 identical duplicate orange squares (duplicate should be dropped)
        // - 1 tiny stray micro-debris speck (< 1.5 pt after 2100 pt scaling)
        // - 1 open path (should be closed)
        // - 1 dense wavy auto-trace polygon with many redundant collinear nodes (should reduce nodes)
        // - 1 Z-order sandwich: Black base -> White eye -> Black pupil overlapping eye (must preserve Z-order!)
        let sample_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <g>
                <rect x="0" y="0" width="100" height="100" fill="#111111" stroke="#ff0000" stroke-width="2"/>
                <rect x="20" y="20" width="60" height="60" fill="#ffffff"/>
                <rect x="40" y="40" width="20" height="20" fill="#111111"/>
                <rect x="5" y="5" width="10" height="10" fill="#ff6600"/>
                <rect x="5" y="5" width="10" height="10" fill="#ff6600"/>
                <rect x="90" y="90" width="0.02" height="0.02" fill="#00ff00"/>
                <path d="M 10 85 L 15 85 L 20 85 L 25 85 L 30 85 L 30 95 L 10 95" fill="#3366ff" stroke="#000000" stroke-width="1"/>
            </g>
        </svg>"##;

        let (eps, stats) = convert_svg_string_to_eps(
            sample_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Vector Optimizer should succeed");

        assert!(eps.starts_with("%!PS-Adobe-"));
        assert!(eps.contains("%%BoundingBox:"));
        assert!(
            stats.width_pt >= DEFAULT_MIN_SIZE_PT && stats.height_pt >= DEFAULT_MIN_SIZE_PT,
            "Shortest side must be >= 2100 pt, got {}x{}",
            stats.width_pt,
            stats.height_pt
        );
        assert_eq!(stats.stray_removed, 1, "Tiny micro-speck must be removed");
        assert_eq!(
            stats.duplicates_removed, 1,
            "Exact duplicate square must be removed"
        );
        assert_eq!(
            stats.open_paths_closed, 1,
            "Open path must be explicitly closed"
        );
        assert!(
            stats.nodes_after < stats.nodes_before,
            "Redundant collinear nodes must be reduced ({} -> {})",
            stats.nodes_before,
            stats.nodes_after
        );
        // Z-order safety: Black base (#111111) and Black pupil (#111111) have White eye (#ffffff)
        // overlapping between them, so Black must remain 2 separate Z-layers (NOT collapsed behind White).
        assert!(
            stats.shapes_after >= 5,
            "Z-order sandwich must stay intact, got {} shapes",
            stats.shapes_after
        );
    }

    #[test]
    fn welds_overlapping_same_color_and_combines_disjoint_same_color() {
        let sample_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <rect x="0" y="0" width="40" height="40" fill="#ff6600"/>
            <rect x="20" y="0" width="40" height="40" fill="#ff6600"/>
            <rect x="70" y="60" width="30" height="30" fill="#ff6600"/>
        </svg>"##;

        let (_eps, stats) = convert_svg_string_to_eps(
            sample_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Same-color weld + combine should succeed");

        assert_eq!(stats.shapes_before, 3);
        assert_eq!(
            stats.shapes_after, 1,
            "All 3 orange shapes without other colors between them must merge into 1 color object"
        );
        assert_eq!(stats.colors_count, 1);
    }

    #[test]
    fn detects_and_solidifies_background_with_cutout_holes() {
        // Background rectangle (0..100) with a punched-out hole (25..75) + foreground circle inside
        let sample_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <path fill="#ffffff" fill-rule="evenodd" d="M 0 0 H 100 V 100 H 0 Z M 25 25 H 75 V 75 H 25 Z"/>
            <rect x="25" y="25" width="50" height="50" fill="#ff6600"/>
        </svg>"##;

        let (doc, stats) = optimize_svg_document(
            sample_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Background solidify should succeed");

        assert!(
            stats.background_solidified,
            "Full-canvas background with cutout hole must be detected and solidified"
        );
        let bg = &doc.pages[0].layers[0].shapes[0];
        let ShapeKind::Path { path, .. } = &bg.kind else {
            panic!("Expected solidified path at layer 0");
        };
        assert_eq!(
            split_subpaths(path).len(),
            1,
            "Background must have 0 cutout holes (1 solid outer subpath)"
        );
    }

    #[test]
    fn does_not_falsely_solidify_isolated_hollow_frame_or_circle() {
        // Single-color hollow square frame on transparent background (no foreground shapes inside)
        let frame_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <path fill="#d4af37" fill-rule="evenodd" d="M 0 0 H 100 V 100 H 0 Z M 15 15 H 85 V 85 H 15 Z"/>
        </svg>"##;
        let (frame_doc, frame_stats) = optimize_svg_document(
            frame_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Frame optimize should succeed");
        assert!(
            !frame_stats.background_solidified,
            "Isolated hollow frame must NOT be filled solid"
        );
        if let ShapeKind::Path { path, .. } = &frame_doc.pages[0].layers[0].shapes[0].kind {
            assert_eq!(
                split_subpaths(path).len(),
                2,
                "Frame hole must be preserved"
            );
        }

        // Circular wreath/badge with foreground center on transparent background (area ~78.5% < 85%)
        let circle_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" fill="#1a1a1a"/>
            <circle cx="50" cy="50" r="20" fill="#ff6600"/>
        </svg>"##;
        let (_circle_doc, circle_stats) = optimize_svg_document(
            circle_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Circle badge optimize should succeed");
        assert!(
            !circle_stats.background_solidified,
            "Circular badge on transparent background must NOT be misclassified as canvas background"
        );
    }

    #[test]
    fn logo_mascot_combines_disjoint_foreground_colors_after_solid_bg() {
        // White full background + two distant blue shapes separated by a non-overlapping red middle shape
        let sample_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <path fill="#ffffff" fill-rule="evenodd" d="M 0 0 H 100 V 100 H 0 Z M 10 10 H 90 V 90 H 10 Z"/>
            <rect x="10" y="10" width="15" height="15" fill="#0066cc"/>
            <rect x="42" y="42" width="16" height="16" fill="#cc0000"/>
            <rect x="75" y="75" width="15" height="15" fill="#0066cc"/>
        </svg>"##;

        let (_doc, stats) = optimize_svg_document(
            sample_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Logo/Mascot foreground combine should succeed");

        assert!(stats.background_solidified);
        // 1 solid white BG + 1 combined blue foreground + 1 red foreground = 3 shapes total!
        assert_eq!(
            stats.shapes_after, 3,
            "Disjoint same-color foreground shapes after Solid BG must combine into 1 object"
        );
    }

    #[test]
    fn pattern_mode_disables_solid_bg_locks_tile_and_combines_all_same_colors() {
        // Pattern tile with full-bleed base, interleaved repeated colors, and a stray speck
        let pattern_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <path fill="#f5efe6" fill-rule="evenodd" d="M 0 0 H 100 V 100 H 0 Z M 20 20 H 40 V 40 H 20 Z"/>
            <rect x="15" y="15" width="20" height="20" fill="#225533"/>
            <rect x="20" y="20" width="20" height="20" fill="#cc4422"/>
            <rect x="25" y="25" width="20" height="20" fill="#225533"/>
            <rect x="65" y="65" width="20" height="20" fill="#cc4422"/>
            <rect x="2" y="2" width="0.02" height="0.02" fill="#000000"/>
        </svg>"##;

        let (doc, stats) = optimize_svg_document(
            pattern_svg,
            VectorOptimizerMode::Pattern,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Pattern mode optimization should succeed");

        assert!(
            !stats.background_solidified,
            "Pattern mode must NEVER run Solid BG"
        );
        assert_eq!(stats.stray_removed, 1, "Stray speck must be removed");
        assert_eq!(
            stats.shapes_after, 3,
            "Pattern mode must globally combine all shapes into exactly 1 object per unique color (3 colors -> 3 shapes)"
        );
        assert!(
            (stats.width_pt - stats.height_pt).abs() < 1.0,
            "Seamless tile proportions must stay locked, got {}x{}",
            stats.width_pt,
            stats.height_pt
        );
        if let ShapeKind::Path { path, .. } = &doc.pages[0].layers[0].shapes[0].kind {
            assert_eq!(split_subpaths(path).len(), 2);
        }
    }

    #[test]
    fn logo_mascot_combines_foreground_across_hollow_ring_bbox_using_true_geometry() {
        // Big hollow red ring (outer 10..90, inner hole 25..75) sits between two blue shapes:
        // one blue dot inside the hollow center (40..60) and one blue dot outside (2..8).
        // Even though the red ring's rectangular bbox covers the inner blue dot, their actual
        // filled interiors DO NOT overlap, so both blue shapes MUST combine into 1 object!
        let sample_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <rect x="2" y="2" width="6" height="6" fill="#0066cc"/>
            <path fill="#cc0000" fill-rule="evenodd" d="M 10 10 H 90 V 90 H 10 Z M 25 25 H 75 V 75 H 25 Z"/>
            <rect x="40" y="40" width="20" height="20" fill="#0066cc"/>
        </svg>"##;

        let (_doc, stats) = optimize_svg_document(
            sample_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("True-geometry foreground combine should succeed");

        assert_eq!(
            stats.shapes_after, 2,
            "Blue dot inside hollow ring cutout and blue dot outside have 0 real overlap with red ring and must combine into 1 blue object (2 shapes total)"
        );
    }

    #[test]
    fn logo_mascot_detects_background_even_when_not_at_index_zero() {
        // Background path sits at index 1 (not index 0), plus an extra edge cutout of same color
        let sample_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <rect x="35" y="35" width="30" height="30" fill="#ff6600"/>
            <path fill="#ffffff" fill-rule="evenodd" d="M 0 0 H 100 V 100 H 0 Z M 35 35 H 65 V 65 H 35 Z"/>
            <rect x="45" y="45" width="10" height="10" fill="#ffffff"/>
        </svg>"##;

        let (doc, stats) = optimize_svg_document(
            sample_svg,
            VectorOptimizerMode::LogoMascot,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Non-zero-index background detection should succeed");

        assert!(
            stats.background_solidified,
            "Background not at index 0 must still be detected and solidified at Layer 0"
        );
        // Layer 0 must be solid white background with 1 outer subpath (0 holes)
        if let ShapeKind::Path { path, .. } = &doc.pages[0].layers[0].shapes[0].kind {
            assert_eq!(split_subpaths(path).len(), 1);
        }
        // Interior white highlight (45..55) must still survive on top of orange (total 3 shapes: BG, orange, white highlight)
        assert_eq!(stats.shapes_after, 3);
    }

    #[test]
    fn pattern_mode_preserves_cutout_holes_when_combining_same_color_dot_inside_hole() {
        // Critical regression test: Pattern base color #f5efe6 has an EvenOdd cutout hole (20..80),
        // AND a small #f5efe6 dot (45..55) sitting inside that cutout hole (on top of a dark flower).
        // Pattern mode must combine both into 1 #f5efe6 object WITHOUT filling the 20..80 hole!
        let pattern_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <path fill="#f5efe6" fill-rule="evenodd" d="M 0 0 H 100 V 100 H 0 Z M 20 20 H 80 V 80 H 20 Z"/>
            <rect x="20" y="20" width="60" height="60" fill="#225533"/>
            <rect x="45" y="45" width="10" height="10" fill="#f5efe6"/>
        </svg>"##;

        let (doc, stats) = optimize_svg_document(
            pattern_svg,
            VectorOptimizerMode::Pattern,
            true,
            DEFAULT_MIN_SIZE_PT,
            true,
            true,
        )
        .expect("Pattern hole-preserving combine should succeed");

        assert!(!stats.background_solidified);
        assert_eq!(
            stats.shapes_after, 2,
            "2 unique colors -> 2 combined objects"
        );
        let base_shape = &doc.pages[0].layers[0].shapes[0];
        let ShapeKind::Path { path, .. } = &base_shape.kind else {
            panic!("Expected combined base path");
        };
        assert_eq!(
            split_subpaths(path).len(),
            3,
            "Base color must preserve all 3 subpaths (outer + cutout hole + center dot) without wiping out the cutout hole"
        );
    }
}
