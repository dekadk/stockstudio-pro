use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

pub const DOWNLOADS_UPDATED_EVENT: &str = "stockstudio-downloads-updated";
pub const DOWNLOAD_TOAST_LABEL: &str = "download-toast-popover";
pub const OPEN_DOWNLOADS_EVENT: &str = "stockstudio-open-downloads";
const MAX_DOWNLOAD_HISTORY: usize = 50;
const MAX_VISIBLE_TOASTS: usize = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Preparing,
    Downloading,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DownloadRecord {
    pub id: String,
    pub file_name: String,
    pub destination_path: String,
    pub extension: String,
    pub account_id: String,
    pub tool_id: String,
    pub status: DownloadStatus,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: Option<u64>,
    pub progress_percent: Option<u8>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub error_message: Option<String>,
    #[serde(default)]
    pub dismissed_toast: bool,
    #[serde(default)]
    pub file_exists: bool,
}

#[derive(Default)]
struct DownloadStateInner {
    loaded: bool,
    records: Vec<DownloadRecord>,
    /// Maps active download IDs to sanitized `(account_id, request_url_key)` for
    /// matching `DownloadEvent::Finished` when concurrent downloads are active.
    /// Never persisted to disk so signed download URLs/tokens are never stored.
    active_request_keys: HashMap<String, String>,
}

#[derive(Default)]
pub struct DownloadManager {
    inner: Mutex<DownloadStateInner>,
}

fn history_file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve("downloads.json", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}

fn extract_file_name_and_ext(path: &Path) -> (String, String) {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Downloaded file")
        .to_string();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    (file_name, extension)
}

/// Rejects executable / script extensions for the optional "Open File" action.
/// "Show in Folder" remains available for any existing downloaded file.
pub fn is_safe_open_extension(ext: &str) -> bool {
    let normalized = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    !matches!(
        normalized.as_str(),
        "exe"
            | "msi"
            | "msp"
            | "bat"
            | "cmd"
            | "ps1"
            | "psm1"
            | "vbs"
            | "vbe"
            | "js"
            | "jse"
            | "wsf"
            | "wsh"
            | "scr"
            | "com"
            | "pif"
            | "reg"
            | "hta"
            | "lnk"
            | "dll"
            | "sys"
            | "jar"
    )
}

fn bound_history(records: &mut Vec<DownloadRecord>) {
    if records.len() > MAX_DOWNLOAD_HISTORY {
        records.truncate(MAX_DOWNLOAD_HISTORY);
    }
}

fn read_history_from_disk(path: &Path) -> Vec<DownloadRecord> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut records: Vec<DownloadRecord> = serde_json::from_str(&raw).unwrap_or_default();
    for record in &mut records {
        if matches!(
            record.status,
            DownloadStatus::Preparing | DownloadStatus::Downloading
        ) {
            record.status = DownloadStatus::Cancelled;
            record.error_message = Some("Interrupted before completion".to_string());
        }
        // Historical downloads from prior sessions should not pop up as new toasts on startup.
        record.dismissed_toast = true;
    }
    bound_history(&mut records);
    records
}

fn write_history_to_disk(path: &Path, records: &[DownloadRecord]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(records) {
        let _ = fs::write(path, bytes);
    }
}

fn ensure_loaded<R: Runtime>(app: &AppHandle<R>, inner: &mut DownloadStateInner) {
    if inner.loaded {
        return;
    }
    if let Ok(path) = history_file_path(app) {
        inner.records = read_history_from_disk(&path);
    }
    inner.loaded = true;
}

fn snapshot_with_existence(records: &[DownloadRecord]) -> Vec<DownloadRecord> {
    records
        .iter()
        .map(|record| {
            let mut cloned = record.clone();
            let p = Path::new(&cloned.destination_path);
            cloned.file_exists = !cloned.destination_path.is_empty() && p.exists();
            cloned
        })
        .collect()
}

fn active_toast_count(records: &[DownloadRecord]) -> usize {
    records
        .iter()
        .filter(|r| !r.dismissed_toast)
        .take(MAX_VISIBLE_TOASTS)
        .count()
}

fn compute_toast_window_size(visible_items: usize) -> (f64, f64) {
    const TOAST_WIDTH: f64 = 356.0;
    const ITEM_HEIGHT: f64 = 108.0;
    const GAP: f64 = 8.0;
    const PADDING: f64 = 16.0;
    let count = visible_items.clamp(1, MAX_VISIBLE_TOASTS) as f64;
    let gaps = (visible_items
        .saturating_sub(1)
        .min(MAX_VISIBLE_TOASTS.saturating_sub(1))) as f64
        * GAP;
    (TOAST_WIDTH, PADDING + count * ITEM_HEIGHT + gaps)
}

fn emit_and_sync_toast<R: Runtime>(app: &AppHandle<R>, records: Vec<DownloadRecord>) {
    let _ = app.emit_to("main", DOWNLOADS_UPDATED_EVENT, &records);
    let _ = app.emit_to(DOWNLOAD_TOAST_LABEL, DOWNLOADS_UPDATED_EVENT, &records);

    let toast_count = active_toast_count(&records);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        sync_download_toast_window(&app_handle, toast_count);
    });
}

fn sync_download_toast_window<R: Runtime>(app: &AppHandle<R>, toast_count: usize) {
    if toast_count == 0 {
        if let Some(toast) = app.get_webview_window(DOWNLOAD_TOAST_LABEL) {
            let _ = toast.hide();
        }
        return;
    }

    let Some(main_window) = app.get_window("main") else {
        return;
    };
    let scale = main_window.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let Ok(inner_pos) = main_window.inner_position() else {
        return;
    };
    let Ok(inner_size) = main_window.inner_size() else {
        return;
    };

    let (width, height) = compute_toast_window_size(toast_count);
    let phys_w = (width * scale).round() as i32;
    let phys_h = (height * scale).round() as i32;
    let margin = (18.0 * scale).round() as i32;

    let mut phys_x = inner_pos.x + (inner_size.width as i32) - phys_w - margin;
    let mut phys_y = inner_pos.y + (inner_size.height as i32) - phys_h - margin;

    if let Some(monitor) = main_window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| main_window.primary_monitor().ok().flatten())
    {
        let area = monitor.work_area();
        let min_x = area.position.x + 8;
        let max_x = (area.position.x + area.size.width as i32 - phys_w - 8).max(min_x);
        let min_y = area.position.y + 8;
        let max_y = (area.position.y + area.size.height as i32 - phys_h - 8).max(min_y);
        phys_x = phys_x.clamp(min_x, max_x);
        phys_y = phys_y.clamp(min_y, max_y);
    }

    if let Some(toast) = app.get_webview_window(DOWNLOAD_TOAST_LABEL) {
        let _ = toast.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
        let _ = toast.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            phys_x, phys_y,
        )));
        let _ = toast.show();
        return;
    }

    let logical_x = f64::from(phys_x) / scale;
    let logical_y = f64::from(phys_y) / scale;
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        DOWNLOAD_TOAST_LABEL,
        tauri::WebviewUrl::App("index.html?popover=download-toast".into()),
    )
    .title("Downloads")
    .decorations(false)
    .resizable(false)
    .always_on_top(false)
    .skip_taskbar(true)
    .shadow(true)
    .theme(Some(tauri::Theme::Dark))
    .background_color(tauri::window::Color(17, 19, 22, 255))
    .inner_size(width, height)
    .position(logical_x, logical_y)
    .focused(false)
    .visible(false);

    #[cfg(target_os = "windows")]
    if let Ok(owner_hwnd) = main_window.hwnd() {
        builder = builder.owner_raw(owner_hwnd);
    }

    if let Ok(toast) = builder.build() {
        let _ = toast.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            phys_x, phys_y,
        )));
        let _ = toast.show();
    }
}

/// Records a newly requested WebView2 download (`DownloadEvent::Requested`).
/// Preserves the original destination path and file name without modification.
pub fn handle_download_requested<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    tool_id: &str,
    request_url_key: &str,
    destination: &Path,
) {
    let dest_str = destination.to_string_lossy().to_string();
    let (file_name, extension) = extract_file_name_and_ext(destination);
    let now = Utc::now().to_rfc3339();

    let snapshot = {
        let state = app.state::<DownloadManager>();
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        ensure_loaded(app, &mut inner);

        // Deduplicate if the exact same destination is already actively downloading.
        let already_active = inner.records.iter().any(|r| {
            matches!(
                r.status,
                DownloadStatus::Preparing | DownloadStatus::Downloading
            ) && r.account_id == account_id
                && !dest_str.is_empty()
                && r.destination_path == dest_str
        });
        if already_active {
            return;
        }

        let id = Uuid::new_v4().to_string();
        let record = DownloadRecord {
            id: id.clone(),
            file_name,
            destination_path: dest_str,
            extension,
            account_id: account_id.to_string(),
            tool_id: tool_id.to_string(),
            status: DownloadStatus::Downloading,
            total_bytes: None,
            downloaded_bytes: None,
            progress_percent: None,
            started_at: now,
            completed_at: None,
            error_message: None,
            dismissed_toast: false,
            file_exists: false,
        };
        inner.records.insert(0, record);
        inner
            .active_request_keys
            .insert(id, request_url_key.to_string());
        bound_history(&mut inner.records);

        if let Ok(path) = history_file_path(app) {
            write_history_to_disk(&path, &inner.records);
        }
        snapshot_with_existence(&inner.records)
    };

    emit_and_sync_toast(app, snapshot);
}

/// Records completion or failure of a WebView2 download (`DownloadEvent::Finished`).
pub fn handle_download_finished<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    tool_id: &str,
    request_url_key: &str,
    final_path: Option<&Path>,
    success: bool,
) {
    let final_path_str = final_path.map(|p| p.to_string_lossy().to_string());
    let now = Utc::now().to_rfc3339();

    let snapshot = {
        let state = app.state::<DownloadManager>();
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        ensure_loaded(app, &mut inner);

        // Match the active downloading record (prefer exact destination path, else request key).
        let target_idx = inner
            .records
            .iter()
            .position(|r| {
                matches!(
                    r.status,
                    DownloadStatus::Preparing | DownloadStatus::Downloading
                ) && r.account_id == account_id
                    && final_path_str
                        .as_deref()
                        .map_or(false, |fp| !fp.is_empty() && r.destination_path == fp)
            })
            .or_else(|| {
                inner.records.iter().position(|r| {
                    matches!(
                        r.status,
                        DownloadStatus::Preparing | DownloadStatus::Downloading
                    ) && r.account_id == account_id
                        && inner
                            .active_request_keys
                            .get(&r.id)
                            .map(String::as_str)
                            .map_or(false, |k| k == request_url_key)
                })
            });

        let resolved_size = final_path
            .and_then(|p| fs::metadata(p).ok())
            .map(|m| m.len());

        if let Some(idx) = target_idx {
            let id = inner.records[idx].id.clone();
            inner.active_request_keys.remove(&id);
            let record = &mut inner.records[idx];
            if let Some(fp) = final_path {
                let (name, ext) = extract_file_name_and_ext(fp);
                record.file_name = name;
                record.extension = ext;
                record.destination_path = fp.to_string_lossy().to_string();
            }
            record.completed_at = Some(now);
            record.dismissed_toast = false;
            if success {
                record.status = DownloadStatus::Completed;
                record.total_bytes = resolved_size;
                record.downloaded_bytes = resolved_size;
                record.progress_percent = Some(100);
                record.error_message = None;
            } else {
                record.status = DownloadStatus::Failed;
                record.error_message = Some("Download did not complete.".to_string());
            }
        } else {
            // Fallback if Finished arrived without a prior matching Requested entry.
            let (file_name, extension) = final_path
                .map(extract_file_name_and_ext)
                .unwrap_or_else(|| ("Downloaded file".to_string(), String::new()));
            let record = DownloadRecord {
                id: Uuid::new_v4().to_string(),
                file_name,
                destination_path: final_path_str.unwrap_or_default(),
                extension,
                account_id: account_id.to_string(),
                tool_id: tool_id.to_string(),
                status: if success {
                    DownloadStatus::Completed
                } else {
                    DownloadStatus::Failed
                },
                total_bytes: if success { resolved_size } else { None },
                downloaded_bytes: if success { resolved_size } else { None },
                progress_percent: if success { Some(100) } else { None },
                started_at: now.clone(),
                completed_at: Some(now),
                error_message: if success {
                    None
                } else {
                    Some("Download did not complete.".to_string())
                },
                dismissed_toast: false,
                file_exists: false,
            };
            inner.records.insert(0, record);
            bound_history(&mut inner.records);
        }

        if let Ok(path) = history_file_path(app) {
            write_history_to_disk(&path, &inner.records);
        }
        snapshot_with_existence(&inner.records)
    };

    emit_and_sync_toast(app, snapshot);
}

pub fn list_downloads<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<DownloadRecord>, String> {
    let state = app.state::<DownloadManager>();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "download manager state unavailable".to_string())?;
    ensure_loaded(app, &mut inner);
    Ok(snapshot_with_existence(&inner.records))
}

pub fn dismiss_toast<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
) -> Result<Vec<DownloadRecord>, String> {
    let snapshot = {
        let state = app.state::<DownloadManager>();
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "download manager state unavailable".to_string())?;
        ensure_loaded(app, &mut inner);
        if let Some(record) = inner.records.iter_mut().find(|r| r.id == download_id) {
            record.dismissed_toast = true;
        }
        if let Ok(path) = history_file_path(app) {
            write_history_to_disk(&path, &inner.records);
        }
        snapshot_with_existence(&inner.records)
    };
    emit_and_sync_toast(app, snapshot.clone());
    Ok(snapshot)
}

/// Auto-dismisses only terminal (Completed, Failed, Cancelled) toast notifications
/// without deleting files, cancelling active downloads, or removing download history.
pub fn dismiss_terminal_toasts<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<DownloadRecord>, String> {
    let snapshot = {
        let state = app.state::<DownloadManager>();
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "download manager state unavailable".to_string())?;
        ensure_loaded(app, &mut inner);
        for record in &mut inner.records {
            if !matches!(
                record.status,
                DownloadStatus::Preparing | DownloadStatus::Downloading
            ) {
                record.dismissed_toast = true;
            }
        }
        if let Ok(path) = history_file_path(app) {
            write_history_to_disk(&path, &inner.records);
        }
        snapshot_with_existence(&inner.records)
    };
    emit_and_sync_toast(app, snapshot.clone());
    Ok(snapshot)
}

pub fn remove_record<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
) -> Result<Vec<DownloadRecord>, String> {
    let snapshot = {
        let state = app.state::<DownloadManager>();
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "download manager state unavailable".to_string())?;
        ensure_loaded(app, &mut inner);
        inner.records.retain(|r| r.id != download_id);
        inner.active_request_keys.remove(&download_id);
        if let Ok(path) = history_file_path(app) {
            write_history_to_disk(&path, &inner.records);
        }
        snapshot_with_existence(&inner.records)
    };
    emit_and_sync_toast(app, snapshot.clone());
    Ok(snapshot)
}

pub fn clear_completed<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<DownloadRecord>, String> {
    let snapshot = {
        let state = app.state::<DownloadManager>();
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "download manager state unavailable".to_string())?;
        ensure_loaded(app, &mut inner);
        inner.records.retain(|r| {
            matches!(
                r.status,
                DownloadStatus::Preparing | DownloadStatus::Downloading
            )
        });
        if let Ok(path) = history_file_path(app) {
            write_history_to_disk(&path, &inner.records);
        }
        snapshot_with_existence(&inner.records)
    };
    emit_and_sync_toast(app, snapshot.clone());
    Ok(snapshot)
}

fn resolve_existing_download_path<R: Runtime>(
    app: &AppHandle<R>,
    download_id: &str,
) -> Result<(PathBuf, String), String> {
    let state = app.state::<DownloadManager>();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "download manager state unavailable".to_string())?;
    ensure_loaded(app, &mut inner);
    let record = inner
        .records
        .iter()
        .find(|r| r.id == download_id)
        .ok_or_else(|| "Download record not found.".to_string())?;
    if record.destination_path.trim().is_empty() {
        return Err("Download destination path is unavailable.".to_string());
    }
    let path = PathBuf::from(&record.destination_path);
    if !path.is_absolute() {
        return Err("Invalid download path.".to_string());
    }
    if !path.exists() {
        return Err("File no longer exists at its download location.".to_string());
    }
    Ok((path, record.extension.clone()))
}

pub fn reveal_in_folder<R: Runtime>(app: &AppHandle<R>, download_id: String) -> Result<(), String> {
    let (path, _) = resolve_existing_download_path(app, &download_id)?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("Unable to open folder: {e}"))
}

pub fn open_downloaded_file<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
) -> Result<(), String> {
    let (path, ext) = resolve_existing_download_path(app, &download_id)?;
    if !path.is_file() {
        return Err("Target path is not a file.".to_string());
    }
    if !is_safe_open_extension(&ext) {
        return Err(
            "Opening executable or script files directly is blocked for safety. Use Show in Folder instead."
                .to_string(),
        );
    }
    let path_str = path.to_string_lossy().to_string();
    app.opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| format!("Unable to open file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_file_name_and_lowercase_extension() {
        let (name, ext) =
            extract_file_name_and_ext(Path::new(r"C:\Users\ok\Downloads\Asset_01.PNG"));
        assert_eq!(name, "Asset_01.PNG");
        assert_eq!(ext, "png");

        let (name2, ext2) = extract_file_name_and_ext(Path::new(r"C:\Users\ok\Downloads\README"));
        assert_eq!(name2, "README");
        assert_eq!(ext2, "");
    }

    #[test]
    fn blocks_executable_and_script_extensions_for_direct_open() {
        assert!(is_safe_open_extension("png"));
        assert!(is_safe_open_extension("JPG"));
        assert!(is_safe_open_extension("webp"));
        assert!(is_safe_open_extension("svg"));
        assert!(is_safe_open_extension("zip"));
        assert!(is_safe_open_extension("pdf"));

        for blocked in [
            "exe", "msi", "bat", "cmd", "ps1", "vbs", "js", "lnk", "scr", "",
        ] {
            assert!(!is_safe_open_extension(blocked), "must block {blocked}");
        }
    }

    #[test]
    fn bounds_download_history_and_computes_compact_toast_sizes() {
        let mut records: Vec<DownloadRecord> = (0..75)
            .map(|i| DownloadRecord {
                id: format!("dl-{i}"),
                file_name: format!("img-{i}.png"),
                destination_path: format!(r"C:\Downloads\img-{i}.png"),
                extension: "png".to_string(),
                account_id: "acc-1".to_string(),
                tool_id: "background".to_string(),
                status: DownloadStatus::Completed,
                total_bytes: Some(1024),
                downloaded_bytes: Some(1024),
                progress_percent: Some(100),
                started_at: "2026-11-21T00:00:00Z".to_string(),
                completed_at: Some("2026-11-21T00:00:02Z".to_string()),
                error_message: None,
                dismissed_toast: false,
                file_exists: false,
            })
            .collect();
        bound_history(&mut records);
        assert_eq!(records.len(), MAX_DOWNLOAD_HISTORY);

        assert_eq!(compute_toast_window_size(1), (356.0, 124.0));
        assert_eq!(compute_toast_window_size(2), (356.0, 124.0));
        assert_eq!(compute_toast_window_size(9), (356.0, 124.0));
    }
}
