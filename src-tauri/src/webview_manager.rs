use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::webview::{DownloadEvent, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl};

const GOOGLE_FLOW_URL: &str = "https://flow.google";
const WEBVIEW_LABEL_PREFIX: &str = "google-flow";
const MAX_CACHED_WEBVIEWS: usize = 10;
const NAV_STATE_EVENT: &str = "stockstudio-webview-nav-state";

/// Hosts the child WebView may navigate to (exact match or a dot-bounded subdomain).
/// Includes Google Flow entry points, shared tools (`flow.google.com`), and
/// Google Sign-In / OAuth / Account Onboarding hosts required for independent
/// per-account login and post-login redirects inside isolated WebView2 profiles.
const ALLOWED_NAVIGATION_HOSTS: &[&str] = &[
    "flow.google",
    "flow.google.com",
    "labs.google",
    "accounts.google.com",
    "accounts.youtube.com",
    "myaccount.google.com",
    "gds.google.com",
    "consent.google.com",
    "ogs.google.com",
    "www.google.com",
    "google.com",
    "gstatic.com",
    "googleusercontent.com",
    "googleapis.com",
];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NavigationState {
    pub account_id: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub is_loading: bool,
    pub current_url: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct WorkspaceSessionInfo {
    pub account_id: String,
    pub tool_id: String,
    pub current_url: String,
    pub is_visible: bool,
    pub reused: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub is_loading: bool,
}

#[derive(Clone, Debug)]
struct CachedSession {
    account_id: String,
    tool_id: String,
    initial_url: String,
    history: Vec<String>,
    history_index: usize,
    is_loading: bool,
    #[allow(dead_code)]
    last_used: u64,
}

impl CachedSession {
    fn new(account_id: String, tool_id: String, initial_url: String, last_used: u64) -> Self {
        Self {
            account_id,
            tool_id,
            history: vec![initial_url.clone()],
            history_index: 0,
            initial_url,
            is_loading: true,
            last_used,
        }
    }

    fn current_url(&self) -> String {
        self.history
            .get(self.history_index)
            .cloned()
            .unwrap_or_else(|| self.initial_url.clone())
    }

    fn can_go_back(&self) -> bool {
        self.history_index > 0
    }

    fn can_go_forward(&self) -> bool {
        self.history_index + 1 < self.history.len()
    }

    fn record_url(&mut self, url: String) {
        if self.history.get(self.history_index).map(String::as_str) == Some(url.as_str()) {
            return;
        }
        // If user clicked Back/Forward, WebView2 loads the adjacent history entry:
        if self.history_index > 0
            && self.history.get(self.history_index - 1).map(String::as_str) == Some(url.as_str())
        {
            self.history_index -= 1;
            return;
        }
        if self.history_index + 1 < self.history.len()
            && self.history.get(self.history_index + 1).map(String::as_str) == Some(url.as_str())
        {
            self.history_index += 1;
            return;
        }
        // Otherwise normal forward navigation: truncate forward stack and push
        self.history.truncate(self.history_index + 1);
        self.history.push(url);
        self.history_index = self.history.len() - 1;
    }

    fn to_nav_state(&self) -> NavigationState {
        NavigationState {
            account_id: self.account_id.clone(),
            can_go_back: self.can_go_back(),
            can_go_forward: self.can_go_forward(),
            is_loading: self.is_loading,
            current_url: self.current_url(),
        }
    }
}

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

/// Whether an initialization/page-load callback for `loaded_account_id` should
/// re-assert WebView visibility (only when that account is still active and visible).
fn should_ensure_visible_on_page_load(
    active: Option<&str>,
    is_visible: bool,
    loaded_account_id: &str,
) -> bool {
    is_visible && active == Some(loaded_account_id)
}

pub struct WebviewManager {
    active_account_id: Mutex<Option<String>>,
    visible: Mutex<bool>,
    cached_sessions: Mutex<HashMap<String, CachedSession>>,
    usage_counter: Mutex<u64>,
    operation: Mutex<()>,
}

impl Default for WebviewManager {
    fn default() -> Self {
        Self {
            active_account_id: Mutex::new(None),
            visible: Mutex::new(false),
            cached_sessions: Mutex::new(HashMap::new()),
            usage_counter: Mutex::new(0),
            operation: Mutex::new(()),
        }
    }
}

fn webview_label(account_id: &str) -> String {
    format!("{WEBVIEW_LABEL_PREFIX}-{account_id}")
}

fn normalize_tool_id(tool_id: Option<&str>) -> String {
    match tool_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id)
            if id.len() <= 64
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            id.to_ascii_lowercase()
        }
        _ => "default".to_string(),
    }
}

fn touch_session(
    state: &WebviewManager,
    account_id: &str,
    tool_id: String,
    initial_url: String,
) -> Result<NavigationState, String> {
    let mut counter = state
        .usage_counter
        .lock()
        .map_err(|_| "webview state unavailable")?;
    *counter = counter.wrapping_add(1);
    let mut cached = state
        .cached_sessions
        .lock()
        .map_err(|_| "webview state unavailable")?;
    let entry = cached
        .entry(account_id.to_string())
        .and_modify(|existing| {
            existing.tool_id = tool_id.clone();
            existing.initial_url = initial_url.clone();
            existing.last_used = *counter;
        })
        .or_insert_with(|| {
            CachedSession::new(account_id.to_string(), tool_id, initial_url, *counter)
        });
    Ok(entry.to_nav_state())
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

fn resolve_target_flow_url(target_url: Option<&str>) -> Result<url::Url, String> {
    let raw = target_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GOOGLE_FLOW_URL);
    let parsed = url::Url::parse(raw).map_err(|_| "invalid Google Flow URL".to_string())?;
    if !is_allowed_navigation_url(&parsed) {
        return Err("unsupported Google Flow URL".to_string());
    }
    Ok(parsed)
}

/// Determines whether an already-running child WebView for `account_id` should
/// navigate to `requested_url` or be shown as-is without forcing a reload.
///
/// Key rule (TASK F-C): Returning to a running workspace or switching between
/// accounts MUST NOT force a reload when the existing session already matches
/// the requested tool/URL, or when no explicit tool URL change is requested.
fn should_navigate_existing_session(
    existing_tool_id: Option<&str>,
    existing_initial_url: Option<&str>,
    requested_tool_id: &str,
    explicit_target_url: Option<&str>,
) -> bool {
    let Some(target) = explicit_target_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    match (existing_tool_id, existing_initial_url) {
        (Some(prev_tool), Some(prev_url))
            if prev_tool == requested_tool_id && prev_url == target =>
        {
            false
        }
        _ => true,
    }
}

pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    target_url: Option<String>,
    tool_id: Option<String>,
) -> Result<WorkspaceSessionInfo, String> {
    let resolved_url = resolve_target_flow_url(target_url.as_deref())?;
    let normalized_tool = normalize_tool_id(tool_id.as_deref());
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

    // Hide the previously visible account WebView WITHOUT closing or reloading it.
    // Its WebView2 process & DOM state remain alive in the background.
    if let Some(active_id) = active_account.as_deref() {
        if active_id != account_id {
            if let Some(webview) = app.get_webview(&webview_label(active_id)) {
                webview.hide().map_err(|e| e.to_string())?;
            }
        }
    }

    // Reuse existing live WebView for this account (1:1 account <-> WebView2 user-data dir).
    if let Some(webview) = app.get_webview(&requested_label) {
        let existing_meta = state
            .cached_sessions
            .lock()
            .map_err(|_| "webview state unavailable")?
            .get(&account_id)
            .cloned();

        let should_nav = should_navigate_existing_session(
            existing_meta.as_ref().map(|s| s.tool_id.as_str()),
            existing_meta.as_ref().map(|s| s.initial_url.as_str()),
            &normalized_tool,
            target_url.as_deref(),
        );

        let effective_url = if should_nav {
            webview
                .navigate(resolved_url.clone())
                .map_err(|e| e.to_string())?;
            resolved_url.as_str().to_string()
        } else {
            existing_meta
                .as_ref()
                .map(|s| s.initial_url.clone())
                .unwrap_or_else(|| resolved_url.as_str().to_string())
        };

        let effective_tool = if should_nav || existing_meta.is_none() {
            normalized_tool
        } else {
            existing_meta.map(|s| s.tool_id).unwrap_or(normalized_tool)
        };

        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        let _ = webview.set_focus();

        *state
            .active_account_id
            .lock()
            .map_err(|_| "webview state unavailable")? = Some(account_id.clone());
        *state
            .visible
            .lock()
            .map_err(|_| "webview state unavailable")? = true;
        let nav_state = touch_session(
            &state,
            &account_id,
            effective_tool.clone(),
            effective_url.clone(),
        )?;
        drop(operation);

        return Ok(WorkspaceSessionInfo {
            account_id,
            tool_id: effective_tool,
            current_url: nav_state.current_url,
            is_visible: true,
            reused: !should_nav,
            can_go_back: nav_state.can_go_back,
            can_go_forward: nav_state.can_go_forward,
            is_loading: nav_state.is_loading,
        });
    }

    // Resource cap safeguard: rather than silently destroying an active background
    // session when MAX_CACHED_WEBVIEWS is reached, return a clear actionable error
    // so the user never loses an in-progress Google Flow generation silently.
    {
        let cached = state
            .cached_sessions
            .lock()
            .map_err(|_| "webview state unavailable")?;
        if cached.len() >= MAX_CACHED_WEBVIEWS {
            return Err(format!(
                "Maximum concurrent sessions ({MAX_CACHED_WEBVIEWS}) reached. Please sign out or close an inactive account session before opening a new one."
            ));
        }
    }

    let profile = profile_path(app, &account_id)?;
    let url_str = resolved_url.as_str().to_string();
    let url = WebviewUrl::External(resolved_url);
    let load_app = app.clone();
    let load_account_id = account_id.clone();
    let dl_app = app.clone();
    let dl_account_id = account_id.clone();
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
        .on_download(move |_webview, event| {
            let active_tool_id = {
                let state = dl_app.state::<WebviewManager>();
                state
                    .cached_sessions
                    .lock()
                    .ok()
                    .and_then(|cached| cached.get(&dl_account_id).map(|s| s.tool_id.clone()))
                    .unwrap_or_else(|| "default".to_string())
            };
            match event {
                DownloadEvent::Requested { url, destination } => {
                    // Preserve original destination path and file name untouched.
                    let key = format!("{}{}", url.origin().ascii_serialization(), url.path());
                    crate::download_manager::handle_download_requested(
                        &dl_app,
                        &dl_account_id,
                        &active_tool_id,
                        &key,
                        destination.as_path(),
                    );
                }
                DownloadEvent::Finished { url, path, success } => {
                    let key = format!("{}{}", url.origin().ascii_serialization(), url.path());
                    crate::download_manager::handle_download_finished(
                        &dl_app,
                        &dl_account_id,
                        &active_tool_id,
                        &key,
                        path.as_deref(),
                        success,
                    );
                }
                _ => {}
            }
            true
        })
        .on_page_load(move |webview, payload| {
            let state = load_app.state::<WebviewManager>();
            let ensure_visible = {
                let active = state
                    .active_account_id
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone());
                let visible = state.visible.lock().map(|guard| *guard).unwrap_or(false);
                should_ensure_visible_on_page_load(active.as_deref(), visible, &load_account_id)
            };
            if ensure_visible {
                let _ = webview.show();
            }
            let nav_update = if let Ok(mut cached) = state.cached_sessions.lock() {
                if let Some(session) = cached.get_mut(&load_account_id) {
                    match payload.event() {
                        PageLoadEvent::Started => {
                            session.is_loading = true;
                        }
                        PageLoadEvent::Finished => {
                            session.is_loading = false;
                            session.record_url(payload.url().as_str().to_string());
                        }
                    }
                    Some(session.to_nav_state())
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(nav_state) = nav_update {
                let _ = load_app.emit(NAV_STATE_EVENT, nav_state);
            }
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);

    let child_webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    child_webview
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    child_webview
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    child_webview.show().map_err(|e| e.to_string())?;
    let _ = child_webview.set_focus();

    *state
        .active_account_id
        .lock()
        .map_err(|_| "webview state unavailable")? = Some(account_id.clone());
    *state
        .visible
        .lock()
        .map_err(|_| "webview state unavailable")? = true;
    let nav_state = touch_session(
        &state,
        &account_id,
        normalized_tool.clone(),
        url_str.clone(),
    )?;
    drop(operation);

    Ok(WorkspaceSessionInfo {
        account_id,
        tool_id: normalized_tool,
        current_url: nav_state.current_url,
        is_visible: true,
        reused: false,
        can_go_back: nav_state.can_go_back,
        can_go_forward: nav_state.can_go_forward,
        is_loading: nav_state.is_loading,
    })
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

/// Temporarily hides or restores visibility of ONLY the currently active account's
/// WebView2 instance (e.g., while an in-app overlay dropdown is open) without ever
/// destroying, recreating, reloading, navigating, or affecting background account sessions.
pub fn set_visible<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    visible: bool,
) -> Result<(), String> {
    validate_account_id(&account_id)?;
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
        if visible {
            webview.show().map_err(|e| e.to_string())?;
            let _ = webview.set_focus();
        } else {
            webview.hide().map_err(|e| e.to_string())?;
        }
        *state
            .visible
            .lock()
            .map_err(|_| "webview state unavailable")? = visible;
    }
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

/// Lists all currently live (in-memory) Google Flow account sessions so the UI
/// can display running indicators without disturbing background WebViews.
pub fn list_sessions<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<WorkspaceSessionInfo>, String> {
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
    let visible = *state
        .visible
        .lock()
        .map_err(|_| "webview state unavailable")?;
    let cached = state
        .cached_sessions
        .lock()
        .map_err(|_| "webview state unavailable")?;

    let mut sessions: Vec<WorkspaceSessionInfo> = cached
        .values()
        .map(|entry| WorkspaceSessionInfo {
            account_id: entry.account_id.clone(),
            tool_id: entry.tool_id.clone(),
            current_url: entry.current_url(),
            is_visible: visible && active_account.as_deref() == Some(entry.account_id.as_str()),
            reused: true,
            can_go_back: entry.can_go_back(),
            can_go_forward: entry.can_go_forward(),
            is_loading: entry.is_loading,
        })
        .collect();
    sessions.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    Ok(sessions)
}

/// Navigates the currently active account's WebView back, forward, or reloads it
/// in-place without ever recreating, clearing, or interrupting other accounts' sessions.
pub fn navigate_action<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    action: String,
) -> Result<NavigationState, String> {
    validate_account_id(&account_id)?;
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
        return Err("target account session is not currently active".to_string());
    }
    let webview = app
        .get_webview(&webview_label(&account_id))
        .ok_or_else(|| "active WebView session not found".to_string())?;

    let nav_state = {
        let mut cached = state
            .cached_sessions
            .lock()
            .map_err(|_| "webview state unavailable")?;
        let session = cached
            .get_mut(&account_id)
            .ok_or_else(|| "session metadata unavailable".to_string())?;

        match action.as_str() {
            "back" => {
                if !session.can_go_back() {
                    return Err("cannot navigate back".to_string());
                }
                session.is_loading = true;
                webview
                    .eval("window.history.back()")
                    .map_err(|e| e.to_string())?;
            }
            "forward" => {
                if !session.can_go_forward() {
                    return Err("cannot navigate forward".to_string());
                }
                session.is_loading = true;
                webview
                    .eval("window.history.forward()")
                    .map_err(|e| e.to_string())?;
            }
            "reload" => {
                session.is_loading = true;
                webview.reload().map_err(|e| e.to_string())?;
            }
            _ => return Err("unsupported navigation action".to_string()),
        }
        session.to_nav_state()
    };

    let _ = webview.set_focus();
    let _ = app.emit(NAV_STATE_EVENT, nav_state.clone());
    Ok(nav_state)
}

/// Explicitly terminates and clears ONLY the specified account's WebView session
/// and isolated user-data profile directory (used for account logout or removal).
/// Never affects any other account's running session.
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
            .cached_sessions
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
    use super::{
        is_allowed_navigation_url, normalize_tool_id, resolve_target_flow_url, should_mark_hidden,
        should_navigate_existing_session, validate_account_id,
    };

    fn allowed(raw: &str) -> bool {
        url::Url::parse(raw)
            .map(|u| is_allowed_navigation_url(&u))
            .unwrap_or(false)
    }

    #[test]
    fn accepts_primary_flow_and_google_signin_hosts() {
        assert!(allowed("https://flow.google"));
        assert!(allowed("https://flow.google/fx/tools/flow"));
        assert!(allowed(
            "https://flow.google.com/shared/tool/91cce113-c49e-4021-81f3-0e2f3d2035c0"
        ));
        assert!(allowed("https://labs.google"));
        assert!(allowed("https://labs.google/fx"));
        assert!(allowed("https://accounts.google.com/ServiceLogin"));
        assert!(allowed("https://accounts.youtube.com/accounts/SetSID"));
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
        assert!(!allowed("https://accounts.google.com.evil.com"));
        assert!(!allowed("https://flow.google@evil.com"));
        assert!(!allowed("https://evil.com/flow.google"));
        assert!(!allowed("https://evil.com/?u=https://flow.google"));
    }

    #[test]
    fn rejects_unlisted_hosts() {
        assert!(!allowed("https://share.gemini.google/CwUs3ZQJlnrk"));
        assert!(!allowed("https://example.com"));
        assert!(!allowed("https://evil-google.com"));
    }

    #[test]
    fn accepts_google_onboarding_and_redirect_hosts() {
        assert!(allowed("https://www.google.com/"));
        assert!(allowed("https://consent.google.com/m"));
        assert!(allowed("https://gds.google.com/web/homeaddress"));
        assert!(allowed("https://myaccount.google.com/"));
    }

    #[test]
    fn tracks_navigation_history_back_and_forward_state() {
        let mut session = super::CachedSession::new(
            "acc-1".to_string(),
            "background".to_string(),
            "https://flow.google.com/shared/tool/91cce113-c49e-4021-81f3-0e2f3d2035c0".to_string(),
            1,
        );
        assert!(!session.can_go_back());
        assert!(!session.can_go_forward());

        session.record_url("https://accounts.google.com/ServiceLogin".to_string());
        assert!(session.can_go_back());
        assert!(!session.can_go_forward());

        // Simulating Back navigation
        session.record_url(
            "https://flow.google.com/shared/tool/91cce113-c49e-4021-81f3-0e2f3d2035c0".to_string(),
        );
        assert!(!session.can_go_back());
        assert!(session.can_go_forward());

        // Simulating Forward navigation
        session.record_url("https://accounts.google.com/ServiceLogin".to_string());
        assert!(session.can_go_back());
        assert!(!session.can_go_forward());
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
    fn ensures_visibility_on_page_load_only_for_active_visible_account() {
        assert!(super::should_ensure_visible_on_page_load(
            Some("acc-a"),
            true,
            "acc-a"
        ));
        assert!(!super::should_ensure_visible_on_page_load(
            Some("acc-a"),
            false,
            "acc-a"
        ));
        assert!(!super::should_ensure_visible_on_page_load(
            Some("acc-b"),
            true,
            "acc-a"
        ));
        assert!(!super::should_ensure_visible_on_page_load(
            None, true, "acc-a"
        ));
    }

    #[test]
    fn preserves_running_session_without_reloading_same_tool() {
        let bg_url = "https://flow.google.com/shared/tool/91cce113-c49e-4021-81f3-0e2f3d2035c0";
        let mascot_url = "https://flow.google.com/shared/tool/26646271-d332-4385-b06d-a6f2758e9c54";

        // Returning to same account + same tool -> do NOT reload
        assert!(!should_navigate_existing_session(
            Some("background"),
            Some(bg_url),
            "background",
            Some(bg_url),
        ));
        // Opening account workspace with no explicit target_url -> do NOT reload
        assert!(!should_navigate_existing_session(
            Some("background"),
            Some(bg_url),
            "default",
            None,
        ));
        // Switching same account to a different tool URL -> DO navigate
        assert!(should_navigate_existing_session(
            Some("background"),
            Some(bg_url),
            "mascot",
            Some(mascot_url),
        ));
    }

    #[test]
    fn validates_account_ids_and_tool_ids() {
        assert!(validate_account_id("abc-123_X").is_ok());
        assert!(validate_account_id("").is_err());
        assert!(validate_account_id("../evil").is_err());
        assert!(validate_account_id("a/b").is_err());
        assert!(validate_account_id(&"a".repeat(129)).is_err());

        assert_eq!(normalize_tool_id(Some("Background")), "background");
        assert_eq!(normalize_tool_id(Some("../bad")), "default");
        assert_eq!(normalize_tool_id(None), "default");
        assert!(resolve_target_flow_url(Some("https://example.com")).is_err());
    }
}
