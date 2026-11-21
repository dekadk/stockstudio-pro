use serde::{Deserialize, Serialize};

use crate::{PRODUCT_DESKTOP, PRODUCT_VECTORIZER_EXTENSION};

/// Ecosystem product identifiers authorized under a unified StockStudio Pro license.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductEntitlement {
    Desktop,
    VectorizerExtension,
}

impl ProductEntitlement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => PRODUCT_DESKTOP,
            Self::VectorizerExtension => PRODUCT_VECTORIZER_EXTENSION,
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            PRODUCT_DESKTOP => Some(Self::Desktop),
            PRODUCT_VECTORIZER_EXTENSION => Some(Self::VectorizerExtension),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicenseEntitlements {
    #[serde(default)]
    pub products: Vec<String>,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub max_accounts: Option<u32>,
    #[serde(default)]
    pub updates_until: Option<String>,
    #[serde(default)]
    pub max_app_version: Option<String>,
}

impl LicenseEntitlements {
    /// Checks whether this entitlement set authorizes a specific product.
    ///
    /// Backward-compatibility invariant:
    /// - Existing StockStudio Pro licenses issued before `products` existed
    ///   have an empty `products` array and remain authorized for `desktop`.
    /// - `vectorizer_extension` is NEVER silently granted to legacy licenses
    ///   unless explicitly present in `products` or `features`.
    pub fn is_product_entitled(&self, product: ProductEntitlement) -> bool {
        let target = product.as_str();
        if self
            .products
            .iter()
            .any(|p| p.trim().eq_ignore_ascii_case(target))
        {
            return true;
        }
        match product {
            ProductEntitlement::Desktop => self.products.is_empty(),
            ProductEntitlement::VectorizerExtension => self
                .features
                .iter()
                .any(|f| f.trim().eq_ignore_ascii_case(target)),
        }
    }
}

/// Backward-compatible LicenseState consumed by `src/App.tsx`, extended with
/// StockStudio Pro v0.2.0 dual-model (perpetual & subscription) and lease metadata.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicenseState {
    // Existing fields consumed by src/App.tsx
    pub plan: String,
    pub status: String,
    pub expires_at: Option<String>,
    pub lifetime: bool,
    pub last_validated_at: String,
    pub device_id: String,

    // Extended StockStudio Pro v0.2.0 fields
    #[serde(default)]
    pub license_id: String,
    #[serde(default)]
    pub activation_id: String,
    #[serde(default)]
    pub key_prefix: String,
    #[serde(default)]
    pub license_type: String,
    #[serde(default)]
    pub billing_interval: String,
    #[serde(default)]
    pub current_period_start: Option<String>,
    #[serde(default)]
    pub current_period_end: Option<String>,
    #[serde(default)]
    pub cancel_at_period_end: bool,
    #[serde(default)]
    pub device_limit: u32,
    #[serde(default)]
    pub devices_used: u32,
    #[serde(default)]
    pub offline_grace_until: String,
    #[serde(default)]
    pub is_offline_grace: bool,
    #[serde(default)]
    pub entitlements: LicenseEntitlements,
    #[serde(default)]
    pub lease_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicenseDeviceInfo {
    pub activation_id: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    #[serde(default)]
    pub os_version: Option<String>,
    #[serde(default)]
    pub app_version: String,
    pub status: String,
    #[serde(default)]
    pub is_current_device: bool,
    pub activated_at: String,
    pub last_validated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicenseDevicesResponse {
    pub license_id: String,
    pub key_prefix: String,
    pub license_type: String,
    pub billing_interval: String,
    pub status: String,
    pub device_limit: u32,
    pub devices_used: u32,
    pub devices: Vec<LicenseDeviceInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeactivateLicenseResponse {
    pub deactivated_activation_id: String,
    pub already_deactivated: bool,
    pub license_id: String,
    pub device_limit: u32,
    pub devices_used: u32,
    pub deactivated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SignedLeasePayload {
    pub ver: u8,
    pub kid: String,
    pub jti: String,
    pub iss: String,
    pub aud: String,
    pub iat: String,
    pub exp: String,
    pub offline_grace_until: String,
    pub license_id: String,
    pub activation_id: String,
    pub device_id: String,
    pub device_fingerprint: String,
    pub plan_code: String,
    pub plan_name: String,
    pub license_type: String,
    pub billing_interval: String,
    pub status: String,
    pub lifetime: bool,
    pub expires_at: Option<String>,
    pub current_period_start: Option<String>,
    pub current_period_end: Option<String>,
    #[serde(default)]
    pub cancel_at_period_end: bool,
    pub device_limit: u32,
    pub devices_used: u32,
    #[serde(default)]
    pub entitlements: LicenseEntitlements,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_fingerprint: String,
    pub device_name: String,
    pub platform: &'static str,
    pub os_version: String,
    pub arch: &'static str,
}

/// Minimal, sanitized authorization verdict intended for untrusted companion
/// clients (such as a future Chrome Extension via Native Messaging).
///
/// Security invariant: NEVER contains `license_key`, `activation_token`,
/// `device_fingerprint`, `lease_token`, private keys, or peppers.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionAuthVerdict {
    pub authorized: bool,
    pub product: String,
    pub license_status: String,
    pub license_type: Option<String>,
    pub plan_name: Option<String>,
    pub expires_at: Option<String>,
    pub offline_grace_until: Option<String>,
    pub is_offline_grace: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}
