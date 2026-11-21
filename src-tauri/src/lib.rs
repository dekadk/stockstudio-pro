use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

mod account_store;
mod download_manager;
mod license_store;
mod webview_manager;

const ACCOUNT_POPOVER_LABEL: &str = "account-switcher-popover";
const ACCOUNT_POPOVER_DATA_EVENT: &str = "stockstudio-account-popover-data";
const ACCOUNT_SWITCH_EVENT: &str = "stockstudio-account-switch";
const ACCOUNT_ADD_EVENT: &str = "stockstudio-account-add";
const POPOVER_BLUR_GRACE_MS: u64 = 250;
const POPOVER_REOPEN_DEBOUNCE_MS: u64 = 250;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct AccountMenuEntry {
    id: String,
    name: String,
    avatar_url: Option<String>,
    is_active: bool,
    is_live: bool,
}

#[derive(Default)]
struct AccountPopoverInner {
    entries: Vec<AccountMenuEntry>,
    opened_at: Option<Instant>,
    closed_at: Option<Instant>,
}

#[derive(Default)]
struct AccountPopoverState(Mutex<AccountPopoverInner>);

/// Computes compact no-scroll logical dimensions so every registered account row
/// and the "Add Google Account" footer are fully visible without clipping or scrollbars.
fn compute_account_popover_size(
    account_count: usize,
    max_logical_height: Option<f64>,
) -> (f64, f64) {
    const POPOVER_WIDTH: f64 = 268.0;
    const ROW_HEIGHT: f64 = 42.0;
    const ROW_GAP: f64 = 2.0;
    const SURFACE_PADDING: f64 = 14.0;
    const DIVIDER_HEIGHT: f64 = 11.0;
    const FOOTER_HEIGHT: f64 = 40.0;
    let rows = account_count.max(1) as f64;
    let gaps = (account_count.saturating_sub(1)) as f64 * ROW_GAP;
    let natural_height =
        SURFACE_PADDING + rows * ROW_HEIGHT + gaps + DIVIDER_HEIGHT + FOOTER_HEIGHT;
    let ceiling = max_logical_height
        .filter(|h| h.is_finite() && *h >= 140.0)
        .unwrap_or(900.0);
    (POPOVER_WIDTH, natural_height.min(ceiling))
}

fn clamp_popover_physical_position(
    desired_x: i32,
    desired_y: i32,
    phys_width: i32,
    phys_height: i32,
    work_area: Option<(i32, i32, i32, i32)>,
) -> (i32, i32) {
    let Some((area_x, area_y, area_w, area_h)) = work_area else {
        return (desired_x, desired_y);
    };
    let margin = 8;
    let min_x = area_x + margin;
    let max_x = (area_x + area_w - phys_width - margin).max(min_x);
    let min_y = area_y + margin;
    let max_y = (area_y + area_h - phys_height - margin).max(min_y);
    (desired_x.clamp(min_x, max_x), desired_y.clamp(min_y, max_y))
}

fn within_window(timestamp: Option<Instant>, now: Instant, window_ms: u64) -> bool {
    timestamp
        .and_then(|ts| now.checked_duration_since(ts))
        .map_or(false, |elapsed| elapsed < Duration::from_millis(window_ms))
}

#[tauri::command]
fn get_account_popover_state(
    state: tauri::State<AccountPopoverState>,
) -> Result<Vec<AccountMenuEntry>, String> {
    state
        .0
        .lock()
        .map(|inner| inner.entries.clone())
        .map_err(|_| "account popover state unavailable".to_string())
}

#[tauri::command]
async fn hide_account_switcher_popover(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut inner) = app.state::<AccountPopoverState>().0.lock() {
        inner.closed_at = Some(Instant::now());
    }
    if let Some(popover) = app.get_webview_window(ACCOUNT_POPOVER_LABEL) {
        let _ = popover.hide();
    }
    Ok(())
}

#[tauri::command]
async fn select_account_from_popover(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<(), String> {
    if let Ok(mut inner) = app.state::<AccountPopoverState>().0.lock() {
        inner.closed_at = Some(Instant::now());
    }
    if let Some(popover) = app.get_webview_window(ACCOUNT_POPOVER_LABEL) {
        let _ = popover.hide();
    }
    let _ = app.emit_to("main", ACCOUNT_SWITCH_EVENT, account_id);
    Ok(())
}

#[tauri::command]
async fn add_account_from_popover(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut inner) = app.state::<AccountPopoverState>().0.lock() {
        inner.closed_at = Some(Instant::now());
    }
    if let Some(popover) = app.get_webview_window(ACCOUNT_POPOVER_LABEL) {
        let _ = popover.hide();
    }
    let _ = app.emit_to("main", ACCOUNT_ADD_EVENT, ());
    Ok(())
}

/// Toggles an owned top-level popover window anchored below the Account Selector button.
/// Uses `app.get_window("main")` (not `get_webview_window("main")`, which can fail once
/// child Google Flow WebViews are attached) and Win32 `owner_raw(main_hwnd)` so Windows DWM
/// guarantees the popover floats strictly above `main` and all embedded WebView2 HWNDs
/// while keeping Google Flow 100% visible and never floating above unrelated apps.
#[tauri::command]
async fn toggle_account_switcher_popover(
    app: tauri::AppHandle,
    anchor_right: f64,
    anchor_bottom: f64,
    accounts: Vec<AccountMenuEntry>,
) -> Result<bool, String> {
    if !anchor_right.is_finite()
        || !anchor_bottom.is_finite()
        || anchor_right < 0.0
        || anchor_bottom < 0.0
    {
        return Err("invalid popover anchor".to_string());
    }
    if accounts.is_empty() {
        return Ok(false);
    }

    let now = Instant::now();
    {
        let state = app.state::<AccountPopoverState>();
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "account popover state unavailable".to_string())?;
        if within_window(guard.closed_at, now, POPOVER_REOPEN_DEBOUNCE_MS) {
            guard.closed_at = None;
            return Ok(false);
        }
        guard.entries = accounts.clone();
    }

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let scale = main_window.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let inner_pos = main_window
        .inner_position()
        .map_err(|e| format!("failed to read main window position: {e}"))?;

    let work_area = main_window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| main_window.primary_monitor().ok().flatten())
        .map(|monitor| {
            let area = monitor.work_area();
            (
                area.position.x,
                area.position.y,
                area.size.width as i32,
                area.size.height as i32,
            )
        });
    let max_logical_height = work_area.map(|(_, _, _, area_h)| (f64::from(area_h) / scale) - 32.0);
    let (width, height) = compute_account_popover_size(accounts.len(), max_logical_height);
    let phys_width = (width * scale).round() as i32;
    let phys_height = (height * scale).round() as i32;
    let desired_x = inner_pos.x + (anchor_right * scale).round() as i32 - phys_width;
    let desired_y = inner_pos.y + (anchor_bottom * scale).round() as i32;
    let (phys_x, phys_y) =
        clamp_popover_physical_position(desired_x, desired_y, phys_width, phys_height, work_area);

    if let Some(popover) = app.get_webview_window(ACCOUNT_POPOVER_LABEL) {
        if popover.is_visible().unwrap_or(false) {
            if let Ok(mut guard) = app.state::<AccountPopoverState>().0.lock() {
                guard.closed_at = Some(Instant::now());
            }
            let _ = popover.hide();
            return Ok(false);
        }
        if let Ok(mut guard) = app.state::<AccountPopoverState>().0.lock() {
            guard.opened_at = Some(Instant::now());
            guard.closed_at = None;
        }
        popover
            .set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
            .map_err(|e| e.to_string())?;
        popover
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                phys_x, phys_y,
            )))
            .map_err(|e| e.to_string())?;
        let _ = app.emit_to(ACCOUNT_POPOVER_LABEL, ACCOUNT_POPOVER_DATA_EVENT, accounts);
        popover.show().map_err(|e| e.to_string())?;
        let _ = popover.set_focus();
        return Ok(true);
    }

    if let Ok(mut guard) = app.state::<AccountPopoverState>().0.lock() {
        guard.opened_at = Some(Instant::now());
        guard.closed_at = None;
    }

    let logical_x = f64::from(phys_x) / scale;
    let logical_y = f64::from(phys_y) / scale;
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        ACCOUNT_POPOVER_LABEL,
        tauri::WebviewUrl::App("index.html?popover=account-switcher".into()),
    )
    .title("Account Switcher")
    .decorations(false)
    .resizable(false)
    .always_on_top(false)
    .skip_taskbar(true)
    .shadow(true)
    .theme(Some(tauri::Theme::Dark))
    .background_color(tauri::window::Color(30, 32, 36, 255))
    .inner_size(width, height)
    .position(logical_x, logical_y)
    .focused(true)
    .visible(false);

    #[cfg(target_os = "windows")]
    {
        let owner_hwnd = main_window
            .hwnd()
            .map_err(|e| format!("failed to read main window hwnd: {e}"))?;
        builder = builder.owner_raw(owner_hwnd);
    }

    let popover = builder
        .build()
        .map_err(|e| format!("failed to build account switcher popover: {e}"))?;

    let _ = popover.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        phys_x, phys_y,
    )));

    let hide_handle = popover.clone();
    let event_app = app.clone();
    popover.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let now = Instant::now();
            if let Ok(mut guard) = event_app.state::<AccountPopoverState>().0.lock() {
                if within_window(guard.opened_at, now, POPOVER_BLUR_GRACE_MS) {
                    return;
                }
                guard.closed_at = Some(now);
            }
            let _ = hide_handle.hide();
        }
    });

    popover.show().map_err(|e| e.to_string())?;
    let _ = popover.set_focus();
    Ok(true)
}

async fn run_on_ui_thread<F, T>(app: &tauri::AppHandle, operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(operation());
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "WebView operation timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_google_flow(
    app: tauri::AppHandle,
    account_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    target_url: Option<String>,
    tool_id: Option<String>,
) -> Result<webview_manager::WorkspaceSessionInfo, String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || {
        webview_manager::open(
            &operation_app,
            account_id,
            x,
            y,
            width,
            height,
            target_url,
            tool_id,
        )
    })
    .await
}

#[tauri::command]
async fn list_google_flow_sessions(
    app: tauri::AppHandle,
) -> Result<Vec<webview_manager::WorkspaceSessionInfo>, String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || webview_manager::list_sessions(&operation_app)).await
}

#[tauri::command]
async fn navigate_google_flow(
    app: tauri::AppHandle,
    account_id: String,
    action: String,
) -> Result<webview_manager::NavigationState, String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || {
        webview_manager::navigate_action(&operation_app, account_id, action)
    })
    .await
}

#[tauri::command]
async fn close_google_flow(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<(), String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || {
        webview_manager::close(&operation_app, account_id)
    })
    .await
}

#[tauri::command]
async fn set_google_flow_visible(
    app: tauri::AppHandle,
    account_id: String,
    visible: bool,
) -> Result<(), String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || {
        webview_manager::set_visible(&operation_app, account_id, visible)
    })
    .await
}

#[tauri::command]
async fn resize_google_flow(
    app: tauri::AppHandle,
    account_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || {
        webview_manager::resize(&operation_app, account_id, x, y, width, height)
    })
    .await
}

#[tauri::command]
async fn remove_google_flow_account(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<bool, String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || {
        webview_manager::remove(&operation_app, account_id)
    })
    .await
}

/// Exact-match HTTPS allowlist for external browser links opened via `tauri-plugin-opener`.
/// AIO Metadata is opened externally rather than embedded in a child WebView.
const ALLOWED_EXTERNAL_URLS: &[&str] = &["https://share.gemini.google/CwUs3ZQJlnrk"];

fn validate_external_url_with_allowlist(
    raw_url: &str,
    allowlist: &[&str],
) -> Result<url::Url, String> {
    if raw_url.is_empty() || raw_url != raw_url.trim() {
        return Err("unsupported external URL".to_string());
    }
    let parsed = url::Url::parse(raw_url).map_err(|_| "unsupported external URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("unsupported external URL".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("unsupported external URL".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("unsupported external URL".to_string());
    }
    let is_allowed = allowlist.iter().any(|allowed| {
        url::Url::parse(allowed)
            .map(|allowed_url| allowed_url == parsed && allowed_url.as_str() == parsed.as_str())
            .unwrap_or(false)
    });
    if !is_allowed {
        return Err("unsupported external URL".to_string());
    }
    Ok(parsed)
}

fn validate_external_url(raw_url: &str) -> Result<url::Url, String> {
    validate_external_url_with_allowlist(raw_url, ALLOWED_EXTERNAL_URLS)
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let validated = validate_external_url(&url)?;
    app.opener()
        .open_url(validated.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

const EXPANDED_TARGET_WIDTH: f64 = 1280.0;
const EXPANDED_TARGET_HEIGHT: f64 = 800.0;
const EXPANDED_MIN_WIDTH: f64 = 1000.0;
const EXPANDED_MIN_HEIGHT: f64 = 700.0;

fn compute_expanded_logical_bounds(
    usable_logical_area: Option<(f64, f64)>,
) -> (tauri::LogicalSize<f64>, tauri::LogicalSize<f64>) {
    let (target_width, target_height) = match usable_logical_area {
        Some((usable_w, usable_h))
            if usable_w.is_finite()
                && usable_h.is_finite()
                && usable_w >= 1.0
                && usable_h >= 1.0 =>
        {
            (
                EXPANDED_TARGET_WIDTH.min(usable_w),
                EXPANDED_TARGET_HEIGHT.min(usable_h),
            )
        }
        _ => (EXPANDED_TARGET_WIDTH, EXPANDED_TARGET_HEIGHT),
    };
    let min_width = EXPANDED_MIN_WIDTH.min(target_width);
    let min_height = EXPANDED_MIN_HEIGHT.min(target_height);
    (
        tauri::LogicalSize::new(target_width, target_height),
        tauri::LogicalSize::new(min_width, min_height),
    )
}

#[tauri::command]
fn expand_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let monitor = match window.current_monitor().map_err(|e| e.to_string())? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor().map_err(|e| e.to_string())?,
    };
    let usable_logical_area = monitor.and_then(|monitor| {
        let scale_factor = monitor.scale_factor();
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return None;
        }
        let work_area = monitor.work_area().size;
        Some((
            f64::from(work_area.width) / scale_factor,
            f64::from(work_area.height) / scale_factor,
        ))
    });
    let (target_size, min_size) = compute_expanded_logical_bounds(usable_logical_area);

    window.set_resizable(true).map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(tauri::Size::Logical(min_size)))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::Size::Logical(target_size))
        .map_err(|e| e.to_string())?;
    window.center().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_downloads(app: tauri::AppHandle) -> Result<Vec<download_manager::DownloadRecord>, String> {
    download_manager::list_downloads(&app)
}

#[tauri::command]
fn dismiss_download_toast(
    app: tauri::AppHandle,
    download_id: String,
) -> Result<Vec<download_manager::DownloadRecord>, String> {
    download_manager::dismiss_toast(&app, download_id)
}

#[tauri::command]
fn dismiss_terminal_download_toasts(
    app: tauri::AppHandle,
) -> Result<Vec<download_manager::DownloadRecord>, String> {
    download_manager::dismiss_terminal_toasts(&app)
}

#[tauri::command]
fn open_downloads_history(app: tauri::AppHandle) -> Result<(), String> {
    let _ = download_manager::dismiss_terminal_toasts(&app);
    let _ = app.emit_to("main", download_manager::OPEN_DOWNLOADS_EVENT, ());
    if let Some(main_window) = app.get_window("main") {
        let _ = main_window.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn remove_download_record(
    app: tauri::AppHandle,
    download_id: String,
) -> Result<Vec<download_manager::DownloadRecord>, String> {
    download_manager::remove_record(&app, download_id)
}

#[tauri::command]
fn clear_completed_downloads(
    app: tauri::AppHandle,
) -> Result<Vec<download_manager::DownloadRecord>, String> {
    download_manager::clear_completed(&app)
}

#[tauri::command]
fn reveal_download_in_folder(app: tauri::AppHandle, download_id: String) -> Result<(), String> {
    download_manager::reveal_in_folder(&app, download_id)
}

#[tauri::command]
fn open_downloaded_file(app: tauri::AppHandle, download_id: String) -> Result<(), String> {
    download_manager::open_downloaded_file(&app, download_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(webview_manager::WebviewManager::default())
        .manage(AccountPopoverState::default())
        .manage(download_manager::DownloadManager::default())
        .invoke_handler(tauri::generate_handler![
            expand_main_window,
            open_external_url,
            toggle_account_switcher_popover,
            get_account_popover_state,
            hide_account_switcher_popover,
            select_account_from_popover,
            add_account_from_popover,
            list_downloads,
            dismiss_download_toast,
            dismiss_terminal_download_toasts,
            open_downloads_history,
            remove_download_record,
            clear_completed_downloads,
            reveal_download_in_folder,
            open_downloaded_file,
            open_google_flow,
            list_google_flow_sessions,
            navigate_google_flow,
            close_google_flow,
            set_google_flow_visible,
            resize_google_flow,
            remove_google_flow_account,
            license_store::get_device_id,
            license_store::get_license_state,
            license_store::activate_license,
            license_store::validate_license,
            license_store::deactivate_license,
            license_store::list_license_devices,
            license_store::clear_license_state,
            account_store::load_accounts,
            account_store::save_accounts
        ])
        .run(tauri::generate_context!())
        .expect("error while running StockStudio Pro");
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_popover_physical_position, compute_account_popover_size,
        compute_expanded_logical_bounds, validate_external_url,
        validate_external_url_with_allowlist, within_window,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn computes_no_scroll_account_popover_dimensions_for_all_accounts() {
        assert_eq!(compute_account_popover_size(1, Some(800.0)), (268.0, 107.0));
        assert_eq!(compute_account_popover_size(3, Some(800.0)), (268.0, 195.0));
        assert_eq!(compute_account_popover_size(8, Some(800.0)), (268.0, 415.0));
        assert_eq!(
            compute_account_popover_size(25, Some(600.0)),
            (268.0, 600.0)
        );
    }

    #[test]
    fn clamps_popover_within_monitor_work_area() {
        let area = Some((0, 0, 1920, 1040));
        assert_eq!(
            clamp_popover_physical_position(1700, 120, 268, 195, area),
            (1644, 120)
        );
        assert_eq!(
            clamp_popover_physical_position(-50, 950, 268, 195, area),
            (8, 837)
        );
    }

    #[test]
    fn enforces_blur_grace_and_reopen_debounce_window() {
        let now = Instant::now();
        assert!(within_window(
            Some(now),
            now + Duration::from_millis(100),
            250
        ));
        assert!(!within_window(
            Some(now),
            now + Duration::from_millis(300),
            250
        ));
        assert!(!within_window(None, now, 250));
    }

    #[test]
    fn uses_default_logical_bounds_without_monitor() {
        let (target, min) = compute_expanded_logical_bounds(None);
        assert_eq!((target.width, target.height), (1280.0, 800.0));
        assert_eq!((min.width, min.height), (1000.0, 700.0));
    }

    #[test]
    fn preserves_default_logical_bounds_on_large_monitor() {
        let (target, min) = compute_expanded_logical_bounds(Some((1920.0, 1040.0)));
        assert_eq!((target.width, target.height), (1280.0, 800.0));
        assert_eq!((min.width, min.height), (1000.0, 700.0));
    }

    #[test]
    fn clamps_height_on_hidpi_150_percent_1080p_monitor() {
        let (target, min) = compute_expanded_logical_bounds(Some((1280.0, 680.0)));
        assert_eq!((target.width, target.height), (1280.0, 680.0));
        assert_eq!((min.width, min.height), (1000.0, 680.0));
    }

    #[test]
    fn clamps_bounds_on_compact_125_percent_laptop() {
        let (target, min) = compute_expanded_logical_bounds(Some((1092.8, 574.4)));
        assert_eq!((target.width, target.height), (1092.8, 574.4));
        assert_eq!((min.width, min.height), (1000.0, 574.4));
    }

    #[test]
    fn allows_registered_aio_metadata_and_rejects_unlisted_https_urls() {
        assert!(validate_external_url("https://share.gemini.google/CwUs3ZQJlnrk").is_ok());
        assert!(validate_external_url("https://share.gemini.google/other").is_err());
        assert!(validate_external_url("https://example.com").is_err());
        assert!(validate_external_url("https://stockstudio.example/buy").is_err());
    }

    #[test]
    fn accepts_only_exact_https_match_in_synthetic_allowlist() {
        let allowlist = &["https://stockstudio.example/buy"];
        let parsed =
            validate_external_url_with_allowlist("https://stockstudio.example/buy", allowlist)
                .expect("exact allowlisted URL must be accepted");
        assert_eq!(parsed.as_str(), "https://stockstudio.example/buy");
    }

    #[test]
    fn rejects_http_urls() {
        let allowlist = &[
            "https://stockstudio.example/buy",
            "http://stockstudio.example/buy",
        ];
        assert!(validate_external_url("http://example.com").is_err());
        assert!(
            validate_external_url_with_allowlist("http://stockstudio.example/buy", allowlist)
                .is_err()
        );
    }

    #[test]
    fn rejects_non_https_schemes() {
        let allowlist = &["file:///C:/Windows/win.ini", "javascript:alert(1)"];
        for candidate in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "ftp://stockstudio.example/file",
            "mailto:support@stockstudio.example",
            "ms-msdt:id",
        ] {
            assert!(validate_external_url(candidate).is_err(), "{candidate}");
            assert!(
                validate_external_url_with_allowlist(candidate, allowlist).is_err(),
                "{candidate}"
            );
        }
    }

    #[test]
    fn rejects_urls_with_username_or_password() {
        let allowlist = &[
            "https://stockstudio.example/buy",
            "https://user@stockstudio.example/buy",
            "https://user:pass@stockstudio.example/buy",
        ];
        for candidate in [
            "https://user@stockstudio.example/buy",
            "https://user:pass@stockstudio.example/buy",
            "https://:pass@stockstudio.example/buy",
        ] {
            assert!(validate_external_url(candidate).is_err(), "{candidate}");
            assert!(
                validate_external_url_with_allowlist(candidate, allowlist).is_err(),
                "{candidate}"
            );
        }
    }

    #[test]
    fn rejects_domain_spoofing_and_path_extensions() {
        let allowlist = &["https://stockstudio.example/buy"];
        for candidate in [
            "https://stockstudio.example.evil.test/buy",
            "https://evil-stockstudio.example/buy",
            "https://stockstudio.example@evil.test/buy",
            "https://stockstudio.example/buy/extra",
            "https://stockstudio.example/buy/",
            "https://stockstudio.example/buy?next=https://evil.test",
            "https://stockstudio.example/buy&calc.exe",
        ] {
            assert!(
                validate_external_url_with_allowlist(candidate, allowlist).is_err(),
                "{candidate}"
            );
        }
    }

    #[test]
    fn rejects_empty_whitespace_and_malformed_urls() {
        let allowlist = &["https://stockstudio.example/buy"];
        for candidate in [
            "",
            "   ",
            " https://stockstudio.example/buy",
            "https://stockstudio.example/buy ",
            "not-a-url",
            "https://",
            "://missing-scheme",
        ] {
            assert!(validate_external_url(candidate).is_err(), "{candidate}");
            assert!(
                validate_external_url_with_allowlist(candidate, allowlist).is_err(),
                "{candidate}"
            );
        }
    }
}
