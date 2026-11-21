use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use keyring::Entry;
use stockstudio_license_core::{
    compute_device_fingerprint, ensure_device_id, evaluate_offline_lease, read_state_file,
    resolve_verifying_keys, sanitize_device_name, DeviceIdentity, LicenseCoreError,
    ProductEntitlement, SecretStore, KEYRING_SERVICE, PRODUCT_VECTORIZER_EXTENSION,
};

use crate::framing::{read_frame, write_frame, FramingError};
use crate::protocol::{NativeRequest, NativeResponse, COMMAND_GET_LICENSE_STATUS};

/// Windows Credential Manager store reusing the exact Desktop service (`StockStudioPro`)
/// for the current logged-in Windows user.
pub struct KeyringSecretStore;

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

/// Resolves `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json`
/// for the current Windows user without depending on Tauri.
pub fn default_desktop_state_path() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Ok(override_path) = std::env::var("STOCKSTUDIO_NMH_STATE_PATH") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let local_app_data = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("XDG_DATA_HOME"))
        .map_err(|_| {
            "Unable to resolve current user local application data directory".to_string()
        })?;
    Ok(PathBuf::from(local_app_data)
        .join("com.stockstudiopro.desktop")
        .join("license-state.json"))
}

/// Reads Windows `MachineGuid` identically to StockStudio Pro Desktop so the
/// computed `device_fingerprint` matches the existing Desktop activation slot.
pub fn read_machine_guid() -> String {
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

pub fn resolve_device_identity(
    secrets: &dyn SecretStore,
    state_path: &Path,
    machine_guid: &str,
) -> Result<DeviceIdentity, LicenseCoreError> {
    let device_id = ensure_device_id(secrets, state_path)?;
    let arch = std::env::consts::ARCH;
    let device_fingerprint = compute_device_fingerprint(machine_guid, arch);
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

pub struct HostContext<'a> {
    pub state_path: &'a Path,
    pub verifying_keys: &'a [(Option<String>, String)],
    pub secrets: &'a dyn SecretStore,
    pub machine_guid: &'a str,
    pub now_utc: DateTime<Utc>,
}

/// Processes a single UTF-8 JSON request string and returns a correlated,
/// sanitized `NativeResponse`. Fails closed on any validation or crypto error.
pub fn handle_request_json(raw_json: &str, ctx: &HostContext<'_>) -> NativeResponse {
    let req: NativeRequest = match serde_json::from_str(raw_json) {
        Ok(r) => r,
        Err(_) => {
            return NativeResponse::denied("", "error", "MALFORMED_JSON");
        }
    };

    if !NativeRequest::is_valid_request_id(&req.request_id) {
        return NativeResponse::denied("", "error", "INVALID_REQUEST_ID");
    }
    let request_id = req.request_id.trim().to_string();

    if req.command.trim() != COMMAND_GET_LICENSE_STATUS {
        return NativeResponse::denied(request_id, "error", "UNSUPPORTED_COMMAND");
    }

    if req.product.trim() != PRODUCT_VECTORIZER_EXTENSION {
        return NativeResponse::denied(request_id, "error", "UNSUPPORTED_PRODUCT");
    }

    // Read persisted Desktop license state (fail closed on missing or corrupted state)
    let saved_state = match read_state_file(ctx.state_path) {
        Ok(Some(state)) => state,
        Ok(None) => {
            return NativeResponse::denied(request_id, "not_activated", "NOT_ACTIVATED");
        }
        Err(err) => {
            return NativeResponse::denied(request_id, "error", err.code());
        }
    };

    let identity = match resolve_device_identity(ctx.secrets, ctx.state_path, ctx.machine_guid) {
        Ok(id) => id,
        Err(err) => {
            return NativeResponse::denied(request_id, "error", err.code());
        }
    };

    // Recompute authorization strictly via stockstudio-license-core
    let evaluated = match evaluate_offline_lease(
        &saved_state,
        ctx.verifying_keys,
        &identity,
        ctx.secrets,
        ctx.now_utc,
    ) {
        Ok(state) => state,
        Err(err) => {
            return NativeResponse::denied(request_id, "unauthorized", err.code());
        }
    };

    let mut products = evaluated.entitlements.products.clone();
    if evaluated
        .entitlements
        .is_product_entitled(ProductEntitlement::Desktop)
        && !products.iter().any(|p| p.eq_ignore_ascii_case("desktop"))
    {
        products.push("desktop".to_string());
    }
    let entitled = evaluated
        .entitlements
        .is_product_entitled(ProductEntitlement::VectorizerExtension);
    if entitled
        && !products
            .iter()
            .any(|p| p.eq_ignore_ascii_case(PRODUCT_VECTORIZER_EXTENSION))
    {
        products.push(PRODUCT_VECTORIZER_EXTENSION.to_string());
    }

    if !entitled {
        return NativeResponse {
            request_id,
            authorized: false,
            license_status: evaluated.status,
            plan_name: Some(evaluated.plan),
            expires_at: evaluated.expires_at,
            offline_grace_until: Some(evaluated.offline_grace_until),
            products,
            error_code: Some(LicenseCoreError::ProductNotEntitled.code().to_string()),
        };
    }

    NativeResponse {
        request_id,
        authorized: true,
        license_status: evaluated.status,
        plan_name: Some(evaluated.plan),
        expires_at: evaluated.expires_at,
        offline_grace_until: Some(evaluated.offline_grace_until),
        products,
        error_code: None,
    }
}

/// Runs one request/response exchange over framed Native Messaging streams.
pub fn run_once<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    ctx: &HostContext<'_>,
) -> Result<NativeResponse, FramingError> {
    let raw_json = read_frame(reader)?;
    let response = handle_request_json(&raw_json, ctx);
    let encoded = serde_json::to_vec(&response).map_err(|e| FramingError::Io(e.to_string()))?;
    write_frame(writer, &encoded)?;
    Ok(response)
}

/// Builds a production `HostContext` backed by Windows Credential Manager and
/// Desktop's `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json`.
pub fn run_stdio_host() -> Result<(), String> {
    let state_path = default_desktop_state_path()?;
    let verifying_keys = resolve_verifying_keys();
    let machine_guid = read_machine_guid();
    let secrets = KeyringSecretStore;

    let ctx = HostContext {
        state_path: &state_path,
        verifying_keys: &verifying_keys,
        secrets: &secrets,
        machine_guid: &machine_guid,
        now_utc: Utc::now(),
    };

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    run_once(&mut reader, &mut writer, &ctx)
        .map(|_| ())
        .map_err(|e| e.to_string())
}
