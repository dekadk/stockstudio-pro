use serde::{Deserialize, Serialize};

pub const NATIVE_HOST_NAME: &str = "com.stockstudiopro.license";
pub const NATIVE_HOST_DESCRIPTION: &str = "StockStudio Pro Unified License Verification Host";
pub const NATIVE_HOST_REGISTRY_SUBKEY: &str =
    r"Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeHostManifest {
    pub name: String,
    pub description: String,
    pub path: String,
    #[serde(rename = "type")]
    pub host_type: String,
    pub allowed_origins: Vec<String>,
}

/// Validates a Chrome Extension ID: exactly 32 lowercase characters in `a..=p`.
/// Rejects wildcards, placeholders, uppercase letters, and malformed IDs.
pub fn is_valid_chrome_extension_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 32 && bytes.iter().all(|b| matches!(b, b'a'..=b'p'))
}

/// Builds a strictly validated Chrome Native Messaging Host manifest for
/// `com.stockstudiopro.license` bound to a single exact Chrome Extension ID.
pub fn build_host_manifest(
    executable_path: &str,
    extension_id: &str,
) -> Result<NativeHostManifest, String> {
    let trimmed_path = executable_path.trim();
    if trimmed_path.is_empty() {
        return Err("Native messaging host executable path cannot be empty.".to_string());
    }
    let trimmed_id = extension_id.trim();
    if !is_valid_chrome_extension_id(trimmed_id) {
        return Err(
            "Chrome Extension ID must be exactly 32 lowercase characters in the range a-p (no wildcards or placeholders)."
                .to_string(),
        );
    }

    Ok(NativeHostManifest {
        name: NATIVE_HOST_NAME.to_string(),
        description: NATIVE_HOST_DESCRIPTION.to_string(),
        path: trimmed_path.to_string(),
        host_type: "stdio".to_string(),
        allowed_origins: vec![format!("chrome-extension://{trimmed_id}/")],
    })
}

pub fn build_host_manifest_json(
    executable_path: &str,
    extension_id: &str,
) -> Result<String, String> {
    let manifest = build_host_manifest(executable_path, extension_id)?;
    serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())
}
