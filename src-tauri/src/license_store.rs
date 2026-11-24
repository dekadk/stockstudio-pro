use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use stockstudio_license_core::{
    clear_license_credentials_preserving_device_id, compute_device_fingerprint, ensure_device_id,
    evaluate_offline_lease, is_terminal_error_code, lease_to_license_state,
    map_error_code_to_user_message, parse_rfc3339, read_state_file, record_clock_anchor,
    resolve_api_base_url, resolve_verifying_keys, sanitize_device_name, verify_signed_lease_token,
    write_state_file_atomic, DeactivateLicenseResponse, DeviceIdentity, LicenseDeviceInfo,
    LicenseDevicesResponse, LicenseState, SecretStore, KEYRING_ACTIVATION_TOKEN,
    KEYRING_LICENSE_KEY, KEYRING_SERVICE, PRODUCT_ID,
};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};
use uuid::Uuid;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const HTTP_TIMEOUT_SECONDS: u64 = 8;

#[derive(Clone, Debug, Deserialize)]
struct ApiLicenseSummary {
    #[serde(default)]
    key_prefix: String,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiActivateResponse {
    ok: bool,
    #[allow(dead_code)]
    activation_id: String,
    activation_token: String,
    license: ApiLicenseSummary,
    lease_token: String,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiValidateResponse {
    ok: bool,
    #[allow(dead_code)]
    activation_id: String,
    license: ApiLicenseSummary,
    lease_token: String,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiDeactivateResponse {
    ok: bool,
    deactivated_activation_id: String,
    already_deactivated: bool,
    license_id: String,
    device_limit: u32,
    devices_used: u32,
    deactivated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiDevicesResponse {
    ok: bool,
    license_id: String,
    key_prefix: String,
    license_type: String,
    billing_interval: String,
    status: String,
    device_limit: u32,
    devices_used: u32,
    devices: Vec<LicenseDeviceInfo>,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiErrorEnvelope {
    #[allow(dead_code)]
    ok: Option<bool>,
    error: Option<ApiErrorDetail>,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiErrorDetail {
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Clone, Debug)]
struct LicenseClientConfig {
    api_base_url: String,
    verifying_keys: Vec<(Option<String>, String)>,
    http_timeout: Duration,
}

struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
        let entry = Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(val) => Ok(Some(val)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }

    fn delete_secret(&self, account: &str) -> Result<(), String> {
        let entry = Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ApiCallFailure {
    Terminal { code: String, message: String },
    ClientError { code: String, message: String },
    Transient(String),
}

fn default_client_config() -> Result<LicenseClientConfig, String> {
    Ok(LicenseClientConfig {
        api_base_url: resolve_api_base_url().map_err(|e| e.to_string())?,
        verifying_keys: resolve_verifying_keys(),
        http_timeout: Duration::from_secs(HTTP_TIMEOUT_SECONDS),
    })
}

fn state_file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve("license-state.json", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}

/// Reads the Windows MachineGuid from registry (`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`)
/// without requiring elevated privileges, falling back to hostname + OS arch if unavailable.
fn read_machine_guid() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if let Ok(output) = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if line.contains("MachineGuid") {
                        if let Some(val) = line.split_whitespace().last() {
                            if !val.trim().is_empty() {
                                return val.trim().to_string();
                            }
                        }
                    }
                }
            }
        }
    }

    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".to_string());
    format!("fallback-{host}-{}", std::env::consts::ARCH)
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn resolve_device_identity(
    secrets: &dyn SecretStore,
    state_path: &Path,
) -> Result<DeviceIdentity, String> {
    let device_id = ensure_device_id(secrets, state_path).map_err(|e| e.to_string())?;
    let arch = std::env::consts::ARCH;
    let machine_guid = read_machine_guid();
    let device_fingerprint = compute_device_fingerprint(&machine_guid, arch);
    let raw_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok();

    Ok(DeviceIdentity {
        device_id,
        device_fingerprint,
        device_name: sanitize_device_name(raw_name),
        platform: current_platform(),
        os_version: std::env::consts::OS.to_string(),
        arch,
    })
}

fn build_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(format!(
            "StockStudioPro/{APP_VERSION} ({}; {})",
            current_platform(),
            std::env::consts::ARCH
        ))
        .build()
        .map_err(|e| e.to_string())
}

fn apply_standard_headers(
    builder: reqwest::RequestBuilder,
    now_utc: DateTime<Utc>,
) -> reqwest::RequestBuilder {
    builder
        .header("Accept", "application/json")
        .header("X-Client-Product", PRODUCT_ID)
        .header("X-Client-Version", APP_VERSION)
        .header("X-Request-Timestamp", now_utc.timestamp().to_string())
        .header("X-Request-Nonce", Uuid::new_v4().to_string())
}

async fn parse_error_response(response: reqwest::Response) -> ApiCallFailure {
    let status = response.status();
    let envelope = response.json::<ApiErrorEnvelope>().await.ok();

    if status.as_u16() >= 500 {
        return ApiCallFailure::Transient("Server Unavailable".to_string());
    }

    if let Some(detail) = envelope.and_then(|e| e.error) {
        let user_msg = map_error_code_to_user_message(&detail.code, &detail.message);
        if is_terminal_error_code(&detail.code) {
            return ApiCallFailure::Terminal {
                code: detail.code,
                message: user_msg,
            };
        }
        return ApiCallFailure::ClientError {
            code: detail.code,
            message: user_msg,
        };
    }

    ApiCallFailure::ClientError {
        code: format!("HTTP_{}", status.as_u16()),
        message: "Unexpected Server Response".to_string(),
    }
}

async fn activate_license_internal(
    config: &LicenseClientConfig,
    secrets: &dyn SecretStore,
    state_path: &Path,
    license_key: &str,
    now_utc: DateTime<Utc>,
) -> Result<LicenseState, String> {
    let trimmed_key = license_key.trim().to_uppercase();
    if trimmed_key.is_empty() {
        return Err("Invalid License".to_string());
    }

    let identity = resolve_device_identity(secrets, state_path)?;
    let client = build_http_client(config.http_timeout)?;
    let url = format!("{}/v1/licenses/activate", config.api_base_url);

    let body = serde_json::json!({
        "license_key": trimmed_key,
        "device": {
            "device_id": identity.device_id,
            "device_fingerprint": identity.device_fingerprint,
            "device_name": identity.device_name,
            "platform": identity.platform,
            "os_version": identity.os_version,
            "arch": identity.arch,
            "app_version": APP_VERSION,
        }
    });

    let response = apply_standard_headers(client.post(url), now_utc)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Server Unavailable".to_string())?;

    if !response.status().is_success() {
        return match parse_error_response(response).await {
            ApiCallFailure::Terminal { message, .. }
            | ApiCallFailure::ClientError { message, .. }
            | ApiCallFailure::Transient(message) => Err(message),
        };
    }

    let payload: ApiActivateResponse = response
        .json()
        .await
        .map_err(|_| "Unexpected Server Response".to_string())?;

    if !payload.ok {
        return Err("Unexpected Server Response".to_string());
    }

    let verified_lease = verify_signed_lease_token(
        &payload.lease_token,
        &config.verifying_keys,
        &identity.device_id,
        &identity.device_fingerprint,
    )
    .map_err(|e| e.to_string())?;

    secrets.set_secret(KEYRING_LICENSE_KEY, &trimmed_key)?;
    secrets.set_secret(KEYRING_ACTIVATION_TOKEN, &payload.activation_token)?;
    record_clock_anchor(secrets, now_utc);
    if let Ok(server_iat) = parse_rfc3339(&verified_lease.iat) {
        record_clock_anchor(secrets, server_iat);
    }

    let new_state = lease_to_license_state(
        &verified_lease,
        &payload.license.key_prefix,
        &payload.lease_token,
        false,
    );
    write_state_file_atomic(state_path, &new_state).map_err(|e| e.to_string())?;
    Ok(new_state)
}

async fn validate_license_internal(
    config: &LicenseClientConfig,
    secrets: &dyn SecretStore,
    state_path: &Path,
    now_utc: DateTime<Utc>,
) -> Result<LicenseState, String> {
    let identity = resolve_device_identity(secrets, state_path)?;
    let saved_state = read_state_file(state_path).ok().flatten();
    let activation_token = secrets.get_secret(KEYRING_ACTIVATION_TOKEN)?;

    let Some(token) = activation_token.filter(|t| !t.trim().is_empty()) else {
        return Err("Invalid License".to_string());
    };

    let client = build_http_client(config.http_timeout)?;
    let url = format!("{}/v1/licenses/validate", config.api_base_url);

    let body = serde_json::json!({
        "activation_id": saved_state.as_ref().map(|s| s.activation_id.as_str()).unwrap_or(""),
        "device": {
            "device_id": identity.device_id,
            "device_fingerprint": identity.device_fingerprint,
            "device_name": identity.device_name,
            "platform": identity.platform,
            "os_version": identity.os_version,
            "arch": identity.arch,
            "app_version": APP_VERSION,
        }
    });

    let send_result = apply_standard_headers(client.post(url), now_utc)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await;

    match send_result {
        Ok(response) if response.status().is_success() => {
            let payload: ApiValidateResponse = response
                .json()
                .await
                .map_err(|_| "Unexpected Server Response".to_string())?;
            if !payload.ok {
                return Err("Unexpected Server Response".to_string());
            }

            let verified_lease = verify_signed_lease_token(
                &payload.lease_token,
                &config.verifying_keys,
                &identity.device_id,
                &identity.device_fingerprint,
            )
            .map_err(|e| e.to_string())?;

            record_clock_anchor(secrets, now_utc);
            if let Ok(server_iat) = parse_rfc3339(&verified_lease.iat) {
                record_clock_anchor(secrets, server_iat);
            }

            let new_state = lease_to_license_state(
                &verified_lease,
                &payload.license.key_prefix,
                &payload.lease_token,
                false,
            );
            write_state_file_atomic(state_path, &new_state).map_err(|e| e.to_string())?;
            Ok(new_state)
        }
        Ok(response) => match parse_error_response(response).await {
            ApiCallFailure::Terminal { message, .. } => {
                let _ = clear_license_credentials_preserving_device_id(secrets, state_path);
                Err(message)
            }
            ApiCallFailure::ClientError { message, .. } => Err(message),
            ApiCallFailure::Transient(transient_msg) => {
                if let Some(local) = saved_state.as_ref() {
                    return evaluate_offline_lease(
                        local,
                        &config.verifying_keys,
                        &identity,
                        secrets,
                        now_utc,
                    )
                    .map_err(|e| e.to_string());
                }
                Err(transient_msg)
            }
        },
        Err(_) => {
            if let Some(local) = saved_state.as_ref() {
                return evaluate_offline_lease(
                    local,
                    &config.verifying_keys,
                    &identity,
                    secrets,
                    now_utc,
                )
                .map_err(|e| e.to_string());
            }
            Err("Server Unavailable".to_string())
        }
    }
}

async fn deactivate_license_internal(
    config: &LicenseClientConfig,
    secrets: &dyn SecretStore,
    state_path: &Path,
    target_activation_id: Option<String>,
    license_key_override: Option<String>,
    reason: Option<String>,
    now_utc: DateTime<Utc>,
) -> Result<DeactivateLicenseResponse, String> {
    let identity = resolve_device_identity(secrets, state_path)?;
    let saved_state = read_state_file(state_path).ok().flatten();
    let activation_token = secrets.get_secret(KEYRING_ACTIVATION_TOKEN)?;
    let saved_license_key = secrets.get_secret(KEYRING_LICENSE_KEY)?;

    let client = build_http_client(config.http_timeout)?;
    let url = format!("{}/v1/licenses/deactivate", config.api_base_url);

    let mut req_builder = apply_standard_headers(client.post(url), now_utc);
    let mut payload_map = serde_json::Map::new();
    payload_map.insert(
        "device_id".to_string(),
        serde_json::Value::String(identity.device_id.clone()),
    );
    if let Some(target_id) = target_activation_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        payload_map.insert(
            "target_activation_id".to_string(),
            serde_json::Value::String(target_id.to_string()),
        );
    }
    if let Some(r) = reason.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        payload_map.insert(
            "reason".to_string(),
            serde_json::Value::String(r.to_string()),
        );
    }

    if let Some(override_key) = license_key_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        payload_map.insert(
            "license_key".to_string(),
            serde_json::Value::String(override_key.to_uppercase()),
        );
    } else if let Some(token) = activation_token.as_deref().filter(|t| !t.trim().is_empty()) {
        req_builder = req_builder.bearer_auth(token);
    } else if let Some(saved_key) = saved_license_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        payload_map.insert(
            "license_key".to_string(),
            serde_json::Value::String(saved_key.to_uppercase()),
        );
    } else {
        return Err("License Session Expired. Please reactivate.".to_string());
    }

    let response = req_builder
        .json(&serde_json::Value::Object(payload_map))
        .send()
        .await
        .map_err(|_| "Server Unavailable".to_string())?;

    if !response.status().is_success() {
        return match parse_error_response(response).await {
            ApiCallFailure::Terminal { message, .. }
            | ApiCallFailure::ClientError { message, .. }
            | ApiCallFailure::Transient(message) => Err(message),
        };
    }

    let parsed: ApiDeactivateResponse = response
        .json()
        .await
        .map_err(|_| "Unexpected Server Response".to_string())?;

    if !parsed.ok {
        return Err("Unexpected Server Response".to_string());
    }

    let current_activation_id = saved_state.as_ref().map(|s| s.activation_id.as_str());
    if target_activation_id.is_none()
        || current_activation_id == Some(parsed.deactivated_activation_id.as_str())
    {
        let _ = clear_license_credentials_preserving_device_id(secrets, state_path);
    }

    Ok(DeactivateLicenseResponse {
        deactivated_activation_id: parsed.deactivated_activation_id,
        already_deactivated: parsed.already_deactivated,
        license_id: parsed.license_id,
        device_limit: parsed.device_limit,
        devices_used: parsed.devices_used,
        deactivated_at: parsed.deactivated_at,
    })
}

async fn list_license_devices_internal(
    config: &LicenseClientConfig,
    secrets: &dyn SecretStore,
    state_path: &Path,
    license_key_override: Option<String>,
    now_utc: DateTime<Utc>,
) -> Result<LicenseDevicesResponse, String> {
    let identity = resolve_device_identity(secrets, state_path)?;
    let activation_token = secrets.get_secret(KEYRING_ACTIVATION_TOKEN)?;
    let saved_license_key = secrets.get_secret(KEYRING_LICENSE_KEY)?;

    let client = build_http_client(config.http_timeout)?;
    let url = format!(
        "{}/v1/licenses/devices?device_id={}",
        config.api_base_url, identity.device_id
    );

    let mut req_builder = apply_standard_headers(client.get(url), now_utc);
    if let Some(override_key) = license_key_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        req_builder = req_builder.header("X-License-Key", override_key.to_uppercase());
    } else if let Some(token) = activation_token.as_deref().filter(|t| !t.trim().is_empty()) {
        req_builder = req_builder.bearer_auth(token);
    } else if let Some(saved_key) = saved_license_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        req_builder = req_builder.header("X-License-Key", saved_key.to_uppercase());
    } else {
        return Err("License Session Expired. Please reactivate.".to_string());
    }

    let response = req_builder
        .send()
        .await
        .map_err(|_| "Server Unavailable".to_string())?;

    if !response.status().is_success() {
        return match parse_error_response(response).await {
            ApiCallFailure::Terminal { message, .. }
            | ApiCallFailure::ClientError { message, .. }
            | ApiCallFailure::Transient(message) => Err(message),
        };
    }

    let parsed: ApiDevicesResponse = response
        .json()
        .await
        .map_err(|_| "Unexpected Server Response".to_string())?;

    if !parsed.ok {
        return Err("Unexpected Server Response".to_string());
    }

    Ok(LicenseDevicesResponse {
        license_id: parsed.license_id,
        key_prefix: parsed.key_prefix,
        license_type: parsed.license_type,
        billing_interval: parsed.billing_interval,
        status: parsed.status,
        device_limit: parsed.device_limit,
        devices_used: parsed.devices_used,
        devices: parsed.devices,
    })
}

fn get_verified_license_state_internal(
    verifying_keys: &[(Option<String>, String)],
    secrets: &dyn SecretStore,
    state_path: &Path,
) -> Result<Option<LicenseState>, String> {
    let Some(saved) = read_state_file(state_path).ok().flatten() else {
        return Ok(None);
    };
    if saved.lease_token.trim().is_empty() {
        return Ok(None);
    }
    let identity = resolve_device_identity(secrets, state_path)?;
    match verify_signed_lease_token(
        &saved.lease_token,
        verifying_keys,
        &identity.device_id,
        &identity.device_fingerprint,
    ) {
        Ok(lease) => Ok(Some(lease_to_license_state(
            &lease,
            &saved.key_prefix,
            &saved.lease_token,
            saved.is_offline_grace,
        ))),
        Err(_) => Ok(None),
    }
}

// =============================================================================
// Public Tauri IPC Commands (Preserved 100% Backward-Compatible)
// =============================================================================

#[tauri::command]
pub fn get_device_id<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let path = state_file_path(&app)?;
    ensure_device_id(&KeyringSecretStore, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_license_state<R: Runtime>(app: AppHandle<R>) -> Result<Option<LicenseState>, String> {
    let path = state_file_path(&app)?;
    let keys = resolve_verifying_keys();
    get_verified_license_state_internal(&keys, &KeyringSecretStore, &path)
}

#[tauri::command]
pub async fn activate_license<R: Runtime>(
    app: AppHandle<R>,
    license_key: String,
) -> Result<LicenseState, String> {
    let path = state_file_path(&app)?;
    let config = default_client_config()?;
    activate_license_internal(
        &config,
        &KeyringSecretStore,
        &path,
        &license_key,
        Utc::now(),
    )
    .await
}

#[tauri::command]
pub async fn validate_license<R: Runtime>(app: AppHandle<R>) -> Result<LicenseState, String> {
    let path = state_file_path(&app)?;
    let config = default_client_config()?;
    validate_license_internal(&config, &KeyringSecretStore, &path, Utc::now()).await
}

#[tauri::command]
pub async fn deactivate_license<R: Runtime>(
    app: AppHandle<R>,
    target_activation_id: Option<String>,
    license_key: Option<String>,
    reason: Option<String>,
) -> Result<DeactivateLicenseResponse, String> {
    let path = state_file_path(&app)?;
    let config = default_client_config()?;
    deactivate_license_internal(
        &config,
        &KeyringSecretStore,
        &path,
        target_activation_id,
        license_key,
        reason,
        Utc::now(),
    )
    .await
}

#[tauri::command]
pub async fn list_license_devices<R: Runtime>(
    app: AppHandle<R>,
    license_key: Option<String>,
) -> Result<LicenseDevicesResponse, String> {
    let path = state_file_path(&app)?;
    let config = default_client_config()?;
    list_license_devices_internal(&config, &KeyringSecretStore, &path, license_key, Utc::now())
        .await
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudioToolRemote {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub url: String,
    pub badge: String,
    #[serde(default = "default_tool_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i64,
}

fn default_tool_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
struct ApiStudioToolsResponse {
    #[allow(dead_code)]
    ok: bool,
    #[serde(default)]
    tools: Vec<StudioToolRemote>,
}

fn tools_cache_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve("studio-tools-cache.json", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}

fn read_tools_cache(cache_path: &Path) -> Option<Vec<StudioToolRemote>> {
    let raw = std::fs::read_to_string(cache_path).ok()?;
    let parsed: Vec<StudioToolRemote> = serde_json::from_str(&raw).ok()?;
    Some(filter_safe_tools(parsed))
}

fn write_tools_cache_atomic(cache_path: &Path, tools: &[StudioToolRemote]) {
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(tools) {
        let tmp = cache_path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, cache_path);
        }
    }
}

fn filter_safe_tools(tools: Vec<StudioToolRemote>) -> Vec<StudioToolRemote> {
    tools
        .into_iter()
        .filter(|tool| {
            let id_ok = !tool.id.trim().is_empty() && tool.id.len() <= 64;
            let name_ok = !tool.name.trim().is_empty();
            let url_ok = url::Url::parse(tool.url.trim())
                .map(|parsed| crate::webview_manager::is_allowed_navigation_url(&parsed))
                .unwrap_or(false);
            id_ok && name_ok && url_ok && tool.enabled
        })
        .collect()
}

#[tauri::command]
pub async fn fetch_studio_tools<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<StudioToolRemote>, String> {
    let cache_path = tools_cache_path(&app)?;
    let config = match default_client_config() {
        Ok(cfg) => cfg,
        Err(err) => {
            if let Some(cached) = read_tools_cache(&cache_path) {
                return Ok(cached);
            }
            return Err(err);
        }
    };

    let activation_token = KeyringSecretStore
        .get_secret(KEYRING_ACTIVATION_TOKEN)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let Some(token) = activation_token else {
        if let Some(cached) = read_tools_cache(&cache_path) {
            return Ok(cached);
        }
        return Err("No active license session".to_string());
    };

    let endpoint = format!("{}/v1/tools", config.api_base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(config.http_timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {token}"))
        .header("X-Product-Id", PRODUCT_ID)
        .header("X-App-Version", APP_VERSION)
        .header("Accept", "application/json")
        .send()
        .await;

    match response {
        Ok(resp) if resp.status().is_success() => {
            let body = resp
                .json::<ApiStudioToolsResponse>()
                .await
                .map_err(|e| e.to_string())?;
            let safe_tools = filter_safe_tools(body.tools);
            write_tools_cache_atomic(&cache_path, &safe_tools);
            Ok(safe_tools)
        }
        Ok(resp) => {
            if let Some(cached) = read_tools_cache(&cache_path) {
                return Ok(cached);
            }
            Err(format!(
                "Failed to fetch studio tools (HTTP {})",
                resp.status().as_u16()
            ))
        }
        Err(err) => {
            if let Some(cached) = read_tools_cache(&cache_path) {
                return Ok(cached);
            }
            Err(format!("Unable to reach studio tools server: {err}"))
        }
    }
}

#[tauri::command]
pub fn clear_license_state<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = state_file_path(&app)?;
    clear_license_credentials_preserving_device_id(&KeyringSecretStore, &path)
        .map_err(|e| e.to_string())
}

// =============================================================================
// Unit & Mock-HTTP Integration Tests (Preserved from Desktop Baseline)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::{
        STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL,
    };
    use base64::Engine;
    use chrono::TimeZone;
    use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use stockstudio_license_core::{
        resolve_api_base_url_for_mode, resolve_verifying_keys_for_mode, validate_api_base_url,
        LicenseCoreError, EXPECTED_ISSUER, KEYRING_DEVICE_ID,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct InMemorySecretStore {
        map: Mutex<HashMap<String, String>>,
    }

    impl SecretStore for InMemorySecretStore {
        fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.map.lock().unwrap().get(account).cloned())
        }
        fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
            self.map
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn delete_secret(&self, account: &str) -> Result<(), String> {
            self.map.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn test_temp_state_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "stockstudio-license-test-{}-{}",
            name,
            Uuid::new_v4()
        ));
        let _ = fs::create_dir_all(&dir);
        dir.join("license-state.json")
    }

    fn make_test_signing_key() -> (SigningKey, String) {
        let seed: [u8; 32] = [42u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pub_b64 = BASE64_STANDARD.encode(signing_key.verifying_key().as_bytes());
        (signing_key, pub_b64)
    }

    fn sign_test_lease_json(signing_key: &SigningKey, payload: &serde_json::Value) -> String {
        let encoded_payload = BASE64_URL.encode(serde_json::to_vec(payload).unwrap());
        let signing_input = format!("v1.{encoded_payload}");
        let sig = signing_key.sign(signing_input.as_bytes());
        let encoded_sig = BASE64_URL.encode(sig.to_bytes());
        format!("v1.{encoded_payload}.{encoded_sig}")
    }

    fn sample_lease_json(
        identity: &DeviceIdentity,
        license_type: &str,
        billing_interval: &str,
        status: &str,
        iat: &str,
        exp: &str,
        expires_at: Option<&str>,
    ) -> serde_json::Value {
        let is_perpetual = license_type == "perpetual";
        serde_json::json!({
            "ver": 1,
            "kid": "sspro-ed25519-test-01",
            "jti": "lse_01TEST00000000000000000000",
            "iss": EXPECTED_ISSUER,
            "aud": PRODUCT_ID,
            "iat": iat,
            "exp": exp,
            "offline_grace_until": exp,
            "license_id": "lic_01TEST00000000000000000000",
            "activation_id": "act_01TEST00000000000000000000",
            "device_id": identity.device_id,
            "device_fingerprint": identity.device_fingerprint,
            "plan_code": if is_perpetual { "lifetime" } else { "pro_monthly" },
            "plan_name": if is_perpetual { "Lifetime" } else { "30 Days" },
            "license_type": license_type,
            "billing_interval": billing_interval,
            "status": status,
            "lifetime": is_perpetual,
            "expires_at": expires_at,
            "current_period_start": if is_perpetual { serde_json::Value::Null } else { serde_json::json!(iat) },
            "current_period_end": expires_at,
            "cancel_at_period_end": false,
            "device_limit": 2,
            "devices_used": 1,
            "entitlements": {
                "features": ["google_flow_workspace", "multi_account_manager"],
                "max_accounts": null,
                "updates_until": null,
                "max_app_version": null
            }
        })
    }

    async fn spawn_mock_http_server(responses: Vec<(u16, String)>, delay_ms: u64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let queue = Arc::new(Mutex::new(
            responses
                .into_iter()
                .collect::<std::collections::VecDeque<_>>(),
        ));

        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let next = queue.lock().unwrap().pop_front();
                if let Some((status, body)) = next {
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    if delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }
                    let resp = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.shutdown().await;
                } else {
                    break;
                }
            }
        });

        format!("http://127.0.0.1:{}", addr.port())
    }

    #[tokio::test]
    async fn activates_perpetual_license_verifies_ed25519_and_persists_credentials() {
        let (signing_key, pub_b64) = make_test_signing_key();
        let secrets = InMemorySecretStore::default();
        let state_path = test_temp_state_path("perpetual");
        let identity = resolve_device_identity(&secrets, &state_path).unwrap();

        let now = Utc.with_ymd_and_hms(2026, 11, 20, 16, 0, 0).unwrap();
        let lease_json = sample_lease_json(
            &identity,
            "perpetual",
            "lifetime",
            "active",
            "2026-11-20T16:00:00Z",
            "2026-11-27T16:00:00Z",
            None,
        );
        let lease_token = sign_test_lease_json(&signing_key, &lease_json);

        let body = serde_json::json!({
            "ok": true,
            "activation_id": "act_01TEST00000000000000000000",
            "activation_token": "ssact_test_token_123",
            "license": { "key_prefix": "SSPRO-7K9M" },
            "lease_token": lease_token
        })
        .to_string();

        let base_url = spawn_mock_http_server(vec![(200, body)], 0).await;
        let config = LicenseClientConfig {
            api_base_url: base_url,
            verifying_keys: vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64.clone())],
            http_timeout: Duration::from_secs(5),
        };

        let state = activate_license_internal(
            &config,
            &secrets,
            &state_path,
            "SSPRO-7K9M-4P2Q-8R6T-3W5Y",
            now,
        )
        .await
        .expect("perpetual activation should succeed");

        assert_eq!(state.plan, "Lifetime");
        assert_eq!(state.license_type, "perpetual");
        assert_eq!(state.billing_interval, "lifetime");
        assert!(state.lifetime);
        assert_eq!(state.expires_at, None);
        assert_eq!(state.device_limit, 2);
        assert_eq!(state.devices_used, 1);
        assert!(!state.is_offline_grace);
        assert_eq!(
            secrets
                .get_secret(KEYRING_ACTIVATION_TOKEN)
                .unwrap()
                .as_deref(),
            Some("ssact_test_token_123")
        );

        let read_back =
            get_verified_license_state_internal(&config.verifying_keys, &secrets, &state_path)
                .unwrap()
                .expect("verified state must exist");
        assert_eq!(read_back.plan, "Lifetime");
        assert_eq!(read_back.device_id, identity.device_id);
    }

    #[tokio::test]
    async fn activates_subscription_license_and_tracks_period_and_expiry() {
        let (signing_key, pub_b64) = make_test_signing_key();
        let secrets = InMemorySecretStore::default();
        let state_path = test_temp_state_path("subscription");
        let identity = resolve_device_identity(&secrets, &state_path).unwrap();

        let now = Utc.with_ymd_and_hms(2026, 11, 20, 16, 0, 0).unwrap();
        let lease_json = sample_lease_json(
            &identity,
            "subscription",
            "monthly",
            "active",
            "2026-11-20T16:00:00Z",
            "2026-11-27T16:00:00Z",
            Some("2026-12-20T16:00:00Z"),
        );
        let lease_token = sign_test_lease_json(&signing_key, &lease_json);

        let body = serde_json::json!({
            "ok": true,
            "activation_id": "act_01TEST00000000000000000000",
            "activation_token": "ssact_sub_token_123",
            "license": { "key_prefix": "SSPRO-9B4C" },
            "lease_token": lease_token
        })
        .to_string();

        let base_url = spawn_mock_http_server(vec![(200, body)], 0).await;
        let config = LicenseClientConfig {
            api_base_url: base_url,
            verifying_keys: vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64)],
            http_timeout: Duration::from_secs(5),
        };

        let state = activate_license_internal(
            &config,
            &secrets,
            &state_path,
            "SSPRO-9B4C-1111-2222-3333",
            now,
        )
        .await
        .expect("subscription activation should succeed");

        assert_eq!(state.plan, "30 Days");
        assert_eq!(state.license_type, "subscription");
        assert_eq!(state.billing_interval, "monthly");
        assert!(!state.lifetime);
        assert_eq!(state.expires_at.as_deref(), Some("2026-12-20T16:00:00Z"));
        assert_eq!(
            state.current_period_end.as_deref(),
            Some("2026-12-20T16:00:00Z")
        );
    }

    #[tokio::test]
    async fn handles_expired_suspended_revoked_and_device_limit_errors() {
        let (_, pub_b64) = make_test_signing_key();
        let secrets = InMemorySecretStore::default();
        let state_path = test_temp_state_path("errors");
        let now = Utc.with_ymd_and_hms(2026, 11, 20, 16, 0, 0).unwrap();

        let err_cases = vec![
            (403, "LICENSE_EXPIRED", "License Expired"),
            (403, "LICENSE_SUSPENDED", "License Suspended"),
            (403, "LICENSE_REVOKED", "License Revoked"),
            (409, "DEVICE_LIMIT_REACHED", "Device Limit Reached"),
        ];

        let responses: Vec<(u16, String)> = err_cases
            .iter()
            .map(|(status, code, _)| {
                (
                    *status,
                    serde_json::json!({
                        "ok": false,
                        "error": { "code": code, "message": "server message" }
                    })
                    .to_string(),
                )
            })
            .collect();

        let base_url = spawn_mock_http_server(responses, 0).await;
        let config = LicenseClientConfig {
            api_base_url: base_url,
            verifying_keys: vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64)],
            http_timeout: Duration::from_secs(5),
        };

        for (_, _, expected_msg) in err_cases {
            let err = activate_license_internal(
                &config,
                &secrets,
                &state_path,
                "SSPRO-7K9M-4P2Q-8R6T-3W5Y",
                now,
            )
            .await
            .expect_err("error case must fail");
            assert_eq!(err, expected_msg);
        }
    }

    #[tokio::test]
    async fn lists_devices_and_deactivates_preserving_device_id() {
        let (signing_key, pub_b64) = make_test_signing_key();
        let secrets = InMemorySecretStore::default();
        let state_path = test_temp_state_path("deactivate");
        let identity = resolve_device_identity(&secrets, &state_path).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 11, 20, 16, 0, 0).unwrap();

        let lease_json = sample_lease_json(
            &identity,
            "perpetual",
            "lifetime",
            "active",
            "2026-11-20T16:00:00Z",
            "2026-11-27T16:00:00Z",
            None,
        );
        let lease_token = sign_test_lease_json(&signing_key, &lease_json);
        secrets
            .set_secret(KEYRING_ACTIVATION_TOKEN, "ssact_active_token")
            .unwrap();
        write_state_file_atomic(
            &state_path,
            &LicenseState {
                activation_id: "act_01TEST00000000000000000000".to_string(),
                device_id: identity.device_id.clone(),
                lease_token,
                ..Default::default()
            },
        )
        .unwrap();

        let devices_body = serde_json::json!({
            "ok": true,
            "license_id": "lic_01TEST",
            "key_prefix": "SSPRO-7K9M",
            "license_type": "perpetual",
            "billing_interval": "lifetime",
            "status": "active",
            "device_limit": 2,
            "devices_used": 1,
            "devices": [{
                "activation_id": "act_01TEST00000000000000000000",
                "device_id": identity.device_id,
                "device_name": "STUDIO-PC",
                "platform": "windows",
                "os_version": "10.0.26200",
                "app_version": "0.2.0",
                "status": "active",
                "is_current_device": true,
                "activated_at": "2026-11-20T16:00:00Z",
                "last_validated_at": "2026-11-20T16:00:00Z"
            }]
        })
        .to_string();

        let deactivate_body = serde_json::json!({
            "ok": true,
            "deactivated_activation_id": "act_01TEST00000000000000000000",
            "already_deactivated": false,
            "license_id": "lic_01TEST",
            "device_limit": 2,
            "devices_used": 0,
            "deactivated_at": "2026-11-20T16:30:00Z"
        })
        .to_string();

        let base_url =
            spawn_mock_http_server(vec![(200, devices_body), (200, deactivate_body)], 0).await;
        let config = LicenseClientConfig {
            api_base_url: base_url,
            verifying_keys: vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64)],
            http_timeout: Duration::from_secs(5),
        };

        let list = list_license_devices_internal(&config, &secrets, &state_path, None, now)
            .await
            .expect("list devices must succeed");
        assert_eq!(list.devices.len(), 1);
        assert!(list.devices[0].is_current_device);

        let deact = deactivate_license_internal(
            &config,
            &secrets,
            &state_path,
            None,
            None,
            Some("user_switch".to_string()),
            now,
        )
        .await
        .expect("deactivation must succeed");
        assert_eq!(deact.devices_used, 0);
        assert!(secrets
            .get_secret(KEYRING_ACTIVATION_TOKEN)
            .unwrap()
            .is_none());
        assert_eq!(
            secrets.get_secret(KEYRING_DEVICE_ID).unwrap().as_deref(),
            Some(identity.device_id.as_str())
        );
    }

    #[test]
    fn rejects_invalid_signature_tampered_lease_expired_lease_and_clock_rollback() {
        let (signing_key, pub_b64) = make_test_signing_key();
        let secrets = InMemorySecretStore::default();
        let state_path = test_temp_state_path("lease-security");
        let identity = resolve_device_identity(&secrets, &state_path).unwrap();
        let verifying_keys = vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64)];

        let lease_json = sample_lease_json(
            &identity,
            "perpetual",
            "lifetime",
            "active",
            "2026-11-20T16:00:00Z",
            "2026-11-27T16:00:00Z",
            None,
        );
        let valid_token = sign_test_lease_json(&signing_key, &lease_json);

        let saved = LicenseState {
            key_prefix: "SSPRO-7K9M".to_string(),
            device_id: identity.device_id.clone(),
            lease_token: valid_token.clone(),
            ..Default::default()
        };
        let day3 = Utc.with_ymd_and_hms(2026, 11, 23, 16, 0, 0).unwrap();
        let grace_ok = evaluate_offline_lease(&saved, &verifying_keys, &identity, &secrets, day3)
            .expect("offline grace within 7 days must succeed");
        assert!(grace_ok.is_offline_grace);
        assert_eq!(grace_ok.status, "active");

        let parts: Vec<&str> = valid_token.split('.').collect();
        let tampered_payload = BASE64_URL.encode(
            serde_json::to_vec(&serde_json::json!({
                "ver": 1, "kid": "sspro-ed25519-test-01", "status": "active", "device_limit": 99
            }))
            .unwrap(),
        );
        let tampered_state = LicenseState {
            lease_token: format!("v1.{tampered_payload}.{}", parts[2]),
            ..saved.clone()
        };
        let sig_err =
            evaluate_offline_lease(&tampered_state, &verifying_keys, &identity, &secrets, day3)
                .expect_err("tampered lease must be rejected")
                .to_string();
        assert!(sig_err.contains("Malformed") || sig_err.contains("Invalid"));

        let rolled_back = Utc.with_ymd_and_hms(2026, 11, 22, 16, 0, 0).unwrap();
        let rollback_err =
            evaluate_offline_lease(&saved, &verifying_keys, &identity, &secrets, rolled_back)
                .expect_err("clock rollback must be rejected")
                .to_string();
        assert_eq!(rollback_err, "System Clock Rollback Detected");

        let day8 = Utc.with_ymd_and_hms(2026, 11, 28, 16, 0, 1).unwrap();
        let exp_err = evaluate_offline_lease(&saved, &verifying_keys, &identity, &secrets, day8)
            .expect_err("expired offline lease must be rejected")
            .to_string();
        assert_eq!(exp_err, "Offline Grace Period Expired");
    }

    #[tokio::test]
    async fn falls_back_to_offline_grace_on_5xx_and_timeout_but_revokes_on_403_terminal() {
        let (signing_key, pub_b64) = make_test_signing_key();
        let secrets = InMemorySecretStore::default();
        let state_path = test_temp_state_path("offline-fallback");
        let identity = resolve_device_identity(&secrets, &state_path).unwrap();

        let lease_json = sample_lease_json(
            &identity,
            "perpetual",
            "lifetime",
            "active",
            "2026-11-20T16:00:00Z",
            "2026-11-27T16:00:00Z",
            None,
        );
        let lease_token = sign_test_lease_json(&signing_key, &lease_json);
        secrets
            .set_secret(KEYRING_ACTIVATION_TOKEN, "ssact_valid_token")
            .unwrap();
        write_state_file_atomic(
            &state_path,
            &LicenseState {
                activation_id: "act_01TEST00000000000000000000".to_string(),
                key_prefix: "SSPRO-7K9M".to_string(),
                device_id: identity.device_id.clone(),
                lease_token,
                ..Default::default()
            },
        )
        .unwrap();

        let day2 = Utc.with_ymd_and_hms(2026, 11, 22, 16, 0, 0).unwrap();

        let base_503 = spawn_mock_http_server(
            vec![(
                503,
                serde_json::json!({ "ok": false, "error": { "code": "SERVICE_UNAVAILABLE" } })
                    .to_string(),
            )],
            0,
        )
        .await;
        let cfg_503 = LicenseClientConfig {
            api_base_url: base_503,
            verifying_keys: vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64.clone())],
            http_timeout: Duration::from_secs(2),
        };
        let state_503 = validate_license_internal(&cfg_503, &secrets, &state_path, day2)
            .await
            .expect("503 should use offline grace period");
        assert!(state_503.is_offline_grace);

        let base_timeout = spawn_mock_http_server(vec![(200, "{}".to_string())], 400).await;
        let cfg_timeout = LicenseClientConfig {
            api_base_url: base_timeout,
            verifying_keys: vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64.clone())],
            http_timeout: Duration::from_millis(80),
        };
        let state_timeout = validate_license_internal(&cfg_timeout, &secrets, &state_path, day2)
            .await
            .expect("timeout should use offline grace period");
        assert!(state_timeout.is_offline_grace);

        let base_revoked = spawn_mock_http_server(
            vec![(
                403,
                serde_json::json!({
                    "ok": false,
                    "error": { "code": "LICENSE_REVOKED", "message": "Revoked" }
                })
                .to_string(),
            )],
            0,
        )
        .await;
        let cfg_revoked = LicenseClientConfig {
            api_base_url: base_revoked,
            verifying_keys: vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64)],
            http_timeout: Duration::from_secs(2),
        };
        let err = validate_license_internal(&cfg_revoked, &secrets, &state_path, day2)
            .await
            .expect_err("403 LICENSE_REVOKED must fail immediately");
        assert_eq!(err, "License Revoked");
        assert!(secrets
            .get_secret(KEYRING_ACTIVATION_TOKEN)
            .unwrap()
            .is_none());
        assert!(!state_path.exists());
    }

    #[test]
    fn validates_api_url_and_rejects_legacy_flowpilot_or_insecure_remote_http() {
        assert!(validate_api_base_url("https://license.stockstudiopro.workers.dev").is_ok());
        assert!(validate_api_base_url("http://127.0.0.1:8787").is_ok());
        assert!(validate_api_base_url("http://remote.example.com").is_err());
        assert!(
            validate_api_base_url("https://flowpilot-license-server.frangga-snow.workers.dev")
                .is_err()
        );
    }

    #[test]
    fn isolates_development_staging_defaults_from_production_builds() {
        assert_eq!(
            resolve_api_base_url_for_mode(None, None, false),
            Err(LicenseCoreError::ApiNotConfigured)
        );
        let prod_keys = resolve_verifying_keys_for_mode(None, None, false);
        assert!(
            !prod_keys
                .iter()
                .any(|(kid, _)| kid.as_deref() == Some("sspro-ed25519-staging-01")),
            "production builds must never inherit staging verifying keys"
        );

        let dev_url = resolve_api_base_url_for_mode(None, None, true)
            .expect("dev mode should resolve staging API URL");
        assert_eq!(
            dev_url,
            "https://stockstudio-pro-license-api-staging.dekadk00.workers.dev"
        );
        let dev_keys = resolve_verifying_keys_for_mode(None, None, true);
        let staging_entry = dev_keys
            .iter()
            .find(|(kid, _)| kid.as_deref() == Some("sspro-ed25519-staging-01"))
            .expect("dev mode should embed staging public verifying key");
        let decoded = BASE64_STANDARD
            .decode(staging_entry.1.trim())
            .expect("embedded staging public key must be valid base64");
        assert_eq!(decoded.len(), 32, "Ed25519 verifying key must be 32 bytes");
        assert!(
            VerifyingKey::from_bytes(&decoded.try_into().unwrap()).is_ok(),
            "embedded staging public key must be a valid Ed25519 verifying key"
        );

        let override_url = resolve_api_base_url_for_mode(
            Some("https://license.stockstudiopro.example".to_string()),
            None,
            false,
        )
        .expect("explicit HTTPS URL should be accepted");
        assert_eq!(override_url, "https://license.stockstudiopro.example");
    }
}
