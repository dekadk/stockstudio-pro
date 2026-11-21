use std::fmt;

/// Typed licensing error returned by `stockstudio-license-core`.
/// `Display` intentionally preserves the exact user-facing error strings
/// expected by StockStudio Pro Desktop (`src/App.tsx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LicenseCoreError {
    ApiNotConfigured,
    InvalidApiUrl,
    UnsupportedApiUrl,
    ApiRequiresHttps,
    VerificationKeyNotConfigured,
    InvalidLeaseFormat,
    InvalidLeasePayload,
    InvalidLeaseSignature,
    MalformedLeasePayload,
    InvalidLeaseClaims,
    UnknownSigningKeyId,
    DeviceMismatch,
    InvalidTimestamp,
    OfflineGraceUnavailable,
    OfflineGraceExpired,
    ClockRollbackDetected,
    LicenseExpired,
    LicenseInactive(String),
    ProductNotEntitled,
    CorruptedPersistedState(String),
    StorageIo(String),
    SecretStore(String),
}

impl LicenseCoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ApiNotConfigured => "API_NOT_CONFIGURED",
            Self::InvalidApiUrl => "INVALID_API_URL",
            Self::UnsupportedApiUrl => "UNSUPPORTED_API_URL",
            Self::ApiRequiresHttps => "API_REQUIRES_HTTPS",
            Self::VerificationKeyNotConfigured => "VERIFICATION_KEY_NOT_CONFIGURED",
            Self::InvalidLeaseFormat => "INVALID_LEASE_FORMAT",
            Self::InvalidLeasePayload => "INVALID_LEASE_PAYLOAD",
            Self::InvalidLeaseSignature => "INVALID_SIGNATURE",
            Self::MalformedLeasePayload => "MALFORMED_LEASE_PAYLOAD",
            Self::InvalidLeaseClaims => "INVALID_LEASE_CLAIMS",
            Self::UnknownSigningKeyId => "UNKNOWN_SIGNING_KEY_ID",
            Self::DeviceMismatch => "DEVICE_MISMATCH",
            Self::InvalidTimestamp => "INVALID_TIMESTAMP",
            Self::OfflineGraceUnavailable => "OFFLINE_GRACE_UNAVAILABLE",
            Self::OfflineGraceExpired => "OFFLINE_GRACE_EXPIRED",
            Self::ClockRollbackDetected => "CLOCK_ROLLBACK_DETECTED",
            Self::LicenseExpired => "LICENSE_EXPIRED",
            Self::LicenseInactive(_) => "LICENSE_INACTIVE",
            Self::ProductNotEntitled => "PRODUCT_NOT_ENTITLED",
            Self::CorruptedPersistedState(_) => "CORRUPTED_PERSISTED_STATE",
            Self::StorageIo(_) => "STORAGE_IO_ERROR",
            Self::SecretStore(_) => "SECRET_STORE_ERROR",
        }
    }
}

impl fmt::Display for LicenseCoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ApiNotConfigured => write!(f, "License API Not Configured"),
            Self::InvalidApiUrl => write!(f, "Invalid License API URL"),
            Self::UnsupportedApiUrl => write!(f, "Unsupported License API URL"),
            Self::ApiRequiresHttps => write!(f, "License API requires HTTPS"),
            Self::VerificationKeyNotConfigured => {
                write!(f, "License Verification Key Not Configured")
            }
            Self::InvalidLeaseFormat => write!(f, "Invalid License Lease Format"),
            Self::InvalidLeasePayload => write!(f, "Invalid License Lease Payload"),
            Self::InvalidLeaseSignature => write!(f, "Invalid License Signature"),
            Self::MalformedLeasePayload => write!(f, "Malformed License Lease Payload"),
            Self::InvalidLeaseClaims => write!(f, "Invalid License Lease Claims"),
            Self::UnknownSigningKeyId => write!(f, "Invalid License Signature"),
            Self::DeviceMismatch => write!(f, "Device Mismatch"),
            Self::InvalidTimestamp => write!(f, "Invalid License Timestamp"),
            Self::OfflineGraceUnavailable => write!(f, "Offline Grace Unavailable"),
            Self::OfflineGraceExpired => write!(f, "Offline Grace Period Expired"),
            Self::ClockRollbackDetected => write!(f, "System Clock Rollback Detected"),
            Self::LicenseExpired => write!(f, "License Expired"),
            Self::LicenseInactive(msg) => write!(f, "{msg}"),
            Self::ProductNotEntitled => write!(f, "Product Not Entitled"),
            Self::CorruptedPersistedState(detail) => {
                write!(f, "Corrupted License State: {detail}")
            }
            Self::StorageIo(detail) => write!(f, "{detail}"),
            Self::SecretStore(detail) => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for LicenseCoreError {}

pub fn is_terminal_error_code(code: &str) -> bool {
    matches!(
        code,
        "LICENSE_REVOKED"
            | "LICENSE_SUSPENDED"
            | "LICENSE_EXPIRED"
            | "ACTIVATION_REVOKED"
            | "DEVICE_MISMATCH"
            | "INVALID_LICENSE_KEY"
            | "UNAUTHORIZED_TOKEN"
    )
}

pub fn map_error_code_to_user_message(code: &str, fallback_msg: &str) -> String {
    match code {
        "INVALID_LICENSE_KEY" => "Invalid License".to_string(),
        "LICENSE_REVOKED" => "License Revoked".to_string(),
        "LICENSE_SUSPENDED" => "License Suspended".to_string(),
        "LICENSE_EXPIRED" => "License Expired".to_string(),
        "ACTIVATION_REVOKED" => "Device Activation Revoked".to_string(),
        "DEVICE_MISMATCH" => "Device Mismatch".to_string(),
        "DEVICE_LIMIT_REACHED" => "Device Limit Reached".to_string(),
        "CLOCK_SKEW_TOO_LARGE" => "System Clock Skew Too Large".to_string(),
        "RATE_LIMITED" => "Too Many Attempts. Please try again later.".to_string(),
        "UNAUTHORIZED_TOKEN" => "License Session Expired. Please reactivate.".to_string(),
        "PRODUCT_MISMATCH" => "Product Mismatch".to_string(),
        _ if !fallback_msg.trim().is_empty() => fallback_msg.trim().to_string(),
        _ => "Unexpected Server Response".to_string(),
    }
}
