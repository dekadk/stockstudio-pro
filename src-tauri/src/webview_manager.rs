use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::path::BaseDirectory;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl};

const GOOGLE_FLOW_URL: &str = "https://flow.google";
const WEBVIEW_LABEL_PREFIX: &str = "google-flow";
const MAX_CACHED_WEBVIEWS: usize = 10;

/// Hosts the child WebView may navigate to (exact match or a dot-bounded subdomain).
/// Only the hosts that are the Google Flow entry points are listed. Google
/// sign-in / resource hosts must be added here only once they are observed in
/// the blocked-navigation debug log during a real login flow.
const ALLOWED_NAVIGATION_HOSTS: &[&str] = &["flow.google", "labs.google"];

pub fn is_allowed_navigation_url(url: &url::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let host = match url.host() {
        Some(url::Host::Domain(domain)) => domain.to_ascii_lowercase(),
        _ => return false,
    };
    let host = host.trim_end_matches('.');
    if host.is_empty() {
        return false;
    }
    ALLOWED_NAVIGATION_HOSTS.iter().any(|allowed| {
        host == *allowed
            || host
                .strip_suffix(allowed)
                .map_or(false, |prefix| prefix.ends_with('.') && prefix.len() > 1)
    })
}

/// Whether closing `requested` should mark the manager as hidden.
fn should_mark_hidden(active: Option<&str>, requested: Option<&str>) -> bool {
    match active {
        Some(active_id) => requested.map_or(true, |requested_id| requested_id == active_id),
        None => false,
    }
}

pub struct WebviewManager {
    active_account_id: Mutex<Option<String>>,
    visible: Mutex<bool>,
    cached_accounts: Mutex<HashMap<String, u64>>,
    usage_counter: Mutex<u64>,
    operation: Mutex<()>,
}

impl Default for WebviewManager {
    fn default() -> Self {
        Self {
            active_account_id: Mutex::new(None),
            visible: Mutex::new(false),
            cached_accounts: Mutex::new(HashMap::new()),
            usage_counter: Mutex::new(0),
            operation: Mutex::new(()),
        }
    }
}

fn webview_label(account_id: &str) -> String {
    format!("{WEBVIEW_LABEL_PREFIX}-{account_id}")
}

fn touch_account(state: &WebviewManager, account_id: &str) -> Result<(), String> {
    let mut counter = state
        .usage_counter
        .lock()
        .map_err(|_| "webview state unavailable")?;
    *counter = counter.wrapping_add(1);
    let mut cached = state
        .cached_accounts
        .lock()
        .map_err(|_| "webview state unavailable")?;
    cached.insert(account_id.to_string(), *counter);
    Ok(())
}

fn validate_account_id(account_id: &str) -> Result<(), String> {
    if account_id.is_empty()
        || account_id.len() > 128
        || !account_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid account id".to_string());
    }
    Ok(())
}

fn profile_path<R: Runtime>(app: &AppHandle<R>, account_id: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resolve("webview-profiles", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())?;
    let profile = root.join(account_id);
    if profile.parent() != Some(root.as_path()) {
        return Err("invalid account profile path".to_string());
    }
    Ok(profile)
}

fn validate_bounds(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if ![x, y, width, height].iter().all(|value| value.is_finite())
        || x < 0.0
        || y < 0.0
        || width <= 0.0
        || height <= 0.0
    {
        return Err("invalid WebView bounds".to_string());
    }
    Ok(())
}

pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let state = app.state::<WebviewManager>();
    let operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    validate_account_id(&account_id)?;
    validate_bounds(x, y, width, height)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let requested_label = webview_label(&account_id);
    let active_account = state
        .active_account_id
        .lock()
        .map_err(|_| "webview state unavailable")?
        .clone();
    if let Some(active_id) = active_account.as_deref() {
        if active_id != account_id {
            if let Some(webview) = app.get_webview(&webview_label(active_id)) {
                webview.hide().map_err(|e| e.to_string())?;
            }
        }
    }

    if let Some(webview) = app.get_webview(&requested_label) {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        *state
            .active_account_id
            .lock()
            .map_err(|_| "webview state unavailable")? = Some(account_id.clone());
        *state
            .visible
            .lock()
            .map_err(|_| "webview state unavailable")? = true;
        touch_account(&state, &account_id)?;
        return Ok(());
    }

    {
        let mut cached = state
            .cached_accounts
            .lock()
            .map_err(|_| "webview state unavailable")?;
        if cached.len() >= MAX_CACHED_WEBVIEWS {
            let eviction = cached
                .iter()
                .filter(|(id, _)| Some(id.as_str()) != active_account.as_deref())
                .min_by_key(|(_, last_used)| **last_used)
                .map(|(id, _)| id.clone());
            if let Some(evicted_id) = eviction {
                if let Some(webview) = app.get_webview(&webview_label(&evicted_id)) {
                    webview.close().map_err(|e| e.to_string())?;
                }
                cached.remove(&evicted_id);
            }
        }
    }

    let profile = profile_path(app, &account_id)?;
    let url = WebviewUrl::External(
        GOOGLE_FLOW_URL
            .parse()
            .map_err(|_| "invalid Google Flow URL")?,
    );
    let builder = WebviewBuilder::new(requested_label, url)
        .data_directory(profile)
        .on_navigation(|url| {
            let allowed = is_allowed_navigation_url(url);
            if !allowed && cfg!(debug_assertions) {
                // Log scheme and host only: never the path, query, or credentials.
                eprintln!(
                    "[stockstudio-webview] blocked navigation scheme={} host={}",
                    url.scheme(),
                    url.host_str().unwrap_or("<none>")
                );
            }
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    *state
        .active_account_id
        .lock()
        .map_err(|_| "webview state unavailable")? = Some(account_id.clone());
    *state
        .visible
        .lock()
        .map_err(|_| "webview state unavailable")? = true;
    touch_account(&state, &account_id)?;
    drop(operation);
    Ok(())
}

pub fn close<R: Runtime>(app: &AppHandle<R>, account_id: Option<String>) -> Result<(), String> {
    let state = app.state::<WebviewManager>();
    let operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    let active_account = state
        .active_account_id
        .lock()
        .map_err(|_| "webview state unavailable")?
        .clone();
    if should_mark_hidden(active_account.as_deref(), account_id.as_deref()) {
        if let Some(active_id) = active_account.as_deref() {
            if let Some(webview) = app.get_webview(&webview_label(active_id)) {
                webview.hide().map_err(|e| e.to_string())?;
            }
        }
        *state
            .visible
            .lock()
            .map_err(|_| "webview state unavailable")? = false;
    }
    drop(operation);
    Ok(())
}

pub fn resize<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_bounds(x, y, width, height)?;
    let state = app.state::<WebviewManager>();
    let _operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    let active_account = state
        .active_account_id
        .lock()
        .map_err(|_| "webview state unavailable")?
        .clone();
    if active_account.as_deref() != Some(account_id.as_str()) {
        return Ok(());
    }
    if let Some(webview) = app.get_webview(&webview_label(&account_id)) {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn remove<R: Runtime>(app: &AppHandle<R>, account_id: String) -> Result<bool, String> {
    validate_account_id(&account_id)?;
    let state = app.state::<WebviewManager>();
    let _operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    let label = webview_label(&account_id);

    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    {
        let mut cached = state
            .cached_accounts
            .lock()
            .map_err(|_| "webview state unavailable")?;
        cached.remove(&account_id);
    }
    {
        let mut active = state
            .active_account_id
            .lock()
            .map_err(|_| "webview state unavailable")?;
        if active.as_deref() == Some(account_id.as_str()) {
            *active = None;
            *state
                .visible
                .lock()
                .map_err(|_| "webview state unavailable")? = false;
        }
    }

    let profile = profile_path(app, &account_id)?;
    if !profile.exists() {
        return Ok(true);
    }
    match std::fs::remove_dir_all(&profile) {
        Ok(()) => Ok(true),
        Err(error) => {
            eprintln!(
                "[stockstudio-webview] profile cleanup pending account={account_id}: {error}"
            );
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_navigation_url, should_mark_hidden, validate_account_id};

    fn allowed(raw: &str) -> bool {
        url::Url::parse(raw)
            .map(|u| is_allowed_navigation_url(&u))
            .unwrap_or(false)
    }

    #[test]
    fn accepts_primary_flow_hosts() {
        assert!(allowed("https://flow.google"));
        assert!(allowed("https://flow.google/fx/tools/flow"));
        assert!(allowed("https://labs.google"));
        assert!(allowed("https://labs.google/fx"));
    }

    #[test]
    fn accepts_dot_bounded_subdomains_of_allowed_hosts() {
        assert!(allowed("https://www.flow.google"));
        assert!(allowed("https://a.b.labs.google/path"));
        assert!(allowed("https://FLOW.GOOGLE/"));
    }

    #[test]
    fn rejects_domain_spoofing() {
        assert!(!allowed("https://flow.google.evil.com"));
        assert!(!allowed("https://notflow.google"));
        assert!(!allowed("https://evil-googleusercontent.com"));
        assert!(!allowed("https://evil-labs.google"));
        assert!(!allowed("https://flow.google@evil.com"));
        assert!(!allowed("https://evil.com/flow.google"));
        assert!(!allowed("https://evil.com/?u=https://flow.google"));
    }

    #[test]
    fn rejects_unlisted_google_hosts_without_evidence() {
        assert!(!allowed("https://accounts.google.com"));
        assert!(!allowed("https://google.com"));
        assert!(!allowed("https://example.com"));
    }

    #[test]
    fn rejects_http_and_non_https_schemes() {
        assert!(!allowed("http://flow.google"));
        assert!(!allowed("ftp://flow.google"));
        assert!(!allowed("file:///C:/Windows/win.ini"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("about:blank"));
        assert!(!allowed("data:text/html,hi"));
        assert!(!allowed("blob:https://flow.google/abc"));
    }

    #[test]
    fn rejects_credentials_ip_hosts_and_malformed_urls() {
        assert!(!allowed("https://user:pass@flow.google"));
        assert!(!allowed("https://user@flow.google"));
        assert!(!allowed("https://127.0.0.1"));
        assert!(!allowed("https://[::1]/"));
        assert!(!allowed("https://"));
        assert!(!allowed(""));
        assert!(!allowed("not a url"));
        assert!(!allowed("https://.flow.google"));
    }

    #[test]
    fn close_only_hides_when_requested_id_is_active() {
        assert!(should_mark_hidden(Some("a"), Some("a")));
        assert!(should_mark_hidden(Some("a"), None));
        assert!(!should_mark_hidden(Some("a"), Some("b")));
        assert!(!should_mark_hidden(None, Some("a")));
        assert!(!should_mark_hidden(None, None));
    }

    #[test]
    fn validates_account_ids() {
        assert!(validate_account_id("abc-123_X").is_ok());
        assert!(validate_account_id("").is_err());
        assert!(validate_account_id("../evil").is_err());
        assert!(validate_account_id("a/b").is_err());
        assert!(validate_account_id(&"a".repeat(129)).is_err());
    }
}
