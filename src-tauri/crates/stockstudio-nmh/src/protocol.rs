use serde::{Deserialize, Serialize};

pub const COMMAND_GET_LICENSE_STATUS: &str = "get_license_status";
const MAX_REQUEST_ID_LEN: usize = 128;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct NativeRequest {
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub product: String,
}

impl NativeRequest {
    pub fn is_valid_request_id(id: &str) -> bool {
        let trimmed = id.trim();
        !trimmed.is_empty()
            && trimmed.len() <= MAX_REQUEST_ID_LEN
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }
}

/// Sanitized authorization verdict returned to the Chrome Extension.
///
/// Security invariant: NEVER includes `license_key`, `activation_token`,
/// `lease_token`, `device_fingerprint`, Credential Manager contents,
/// private keys, or admin credentials.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeResponse {
    pub request_id: String,
    pub authorized: bool,
    pub license_status: String,
    pub plan_name: Option<String>,
    pub expires_at: Option<String>,
    pub offline_grace_until: Option<String>,
    pub products: Vec<String>,
    pub error_code: Option<String>,
}

impl NativeResponse {
    pub fn denied(
        request_id: impl Into<String>,
        license_status: impl Into<String>,
        error_code: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            authorized: false,
            license_status: license_status.into(),
            plan_name: None,
            expires_at: None,
            offline_grace_until: None,
            products: Vec::new(),
            error_code: Some(error_code.into()),
        }
    }
}
