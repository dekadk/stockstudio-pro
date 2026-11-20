use std::time::Duration;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

mod account_store;
mod license_store;
mod webview_manager;

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
) -> Result<(), String> {
    let operation_app = app.clone();
    run_on_ui_thread(&app, move || {
        webview_manager::open(&operation_app, account_id, x, y, width, height)
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

const ALLOWED_EXTERNAL_URLS: &[&str] = &[];

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(webview_manager::WebviewManager::default())
        .invoke_handler(tauri::generate_handler![
            expand_main_window,
            open_external_url,
            open_google_flow,
            close_google_flow,
            resize_google_flow,
            remove_google_flow_account,
            license_store::get_device_id,
            license_store::get_license_state,
            license_store::activate_license,
            license_store::validate_license,
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
        compute_expanded_logical_bounds, validate_external_url, validate_external_url_with_allowlist,
        ALLOWED_EXTERNAL_URLS,
    };

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
    fn rejects_valid_https_when_allowlist_is_empty() {
        assert!(ALLOWED_EXTERNAL_URLS.is_empty());
        assert!(validate_external_url("https://example.com").is_err());
        assert!(validate_external_url("https://stockstudio.example/buy").is_err());
    }

    #[test]
    fn accepts_only_exact_https_match_in_synthetic_allowlist() {
        let allowlist = &["https://stockstudio.example/buy"];
        let parsed = validate_external_url_with_allowlist(
            "https://stockstudio.example/buy",
            allowlist,
        )
        .expect("exact allowlisted URL must be accepted");
        assert_eq!(parsed.as_str(), "https://stockstudio.example/buy");
    }

    #[test]
    fn rejects_http_urls() {
        let allowlist = &["https://stockstudio.example/buy", "http://stockstudio.example/buy"];
        assert!(validate_external_url("http://example.com").is_err());
        assert!(validate_external_url_with_allowlist("http://stockstudio.example/buy", allowlist).is_err());
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
