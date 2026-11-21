//! Shared, platform-independent licensing core for StockStudio Pro Desktop
//! and future local companion clients (such as `stockstudio-nmh.exe`).
//!
//! This crate intentionally excludes Tauri, WebView, HTTP transport, and OS
//! credential vault implementations so both Desktop and Native Messaging Host
//! enforce identical Ed25519 verification, offline grace, clock rollback, and
//! entitlement evaluation rules.

pub mod config;
pub mod error;
pub mod models;
pub mod storage;
pub mod verify;

pub const KEYRING_SERVICE: &str = "StockStudioPro";
pub const KEYRING_DEVICE_ID: &str = "device-id";
pub const KEYRING_LICENSE_KEY: &str = "license-key";
pub const KEYRING_ACTIVATION_TOKEN: &str = "activation-token";
pub const KEYRING_CLOCK_ANCHOR: &str = "clock-anchor";

pub const PRODUCT_ID: &str = "com.stockstudiopro.desktop";
pub const PRODUCT_DESKTOP: &str = "desktop";
pub const PRODUCT_VECTORIZER_EXTENSION: &str = "vectorizer_extension";
pub const EXPECTED_ISSUER: &str = "stockstudiopro-license-server";

pub const CLOCK_ROLLBACK_TOLERANCE_SECONDS: i64 = 300; // 5 minutes
pub const OFFLINE_GRACE_MAX_SECONDS: i64 = 7 * 24 * 60 * 60; // 7 days

pub use config::{
    resolve_api_base_url, resolve_api_base_url_for_mode, resolve_verifying_keys,
    resolve_verifying_keys_for_mode, validate_api_base_url,
};
pub use error::{is_terminal_error_code, map_error_code_to_user_message, LicenseCoreError};
pub use models::{
    DeactivateLicenseResponse, DeviceIdentity, ExtensionAuthVerdict, LicenseDeviceInfo,
    LicenseDevicesResponse, LicenseEntitlements, LicenseState, ProductEntitlement,
    SignedLeasePayload,
};
pub use storage::{
    clear_license_credentials_preserving_device_id, compute_device_fingerprint, ensure_device_id,
    read_clock_anchor, read_state_file, record_clock_anchor, remove_state_file,
    sanitize_device_name, write_state_file_atomic, SecretStore,
};
pub use verify::{
    evaluate_offline_lease, evaluate_product_verdict, lease_to_license_state, parse_rfc3339,
    verify_signed_lease_token,
};
