use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL};
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::error::{map_error_code_to_user_message, LicenseCoreError};
use crate::models::{
    DeviceIdentity, ExtensionAuthVerdict, LicenseState, ProductEntitlement, SignedLeasePayload,
};
use crate::storage::{read_clock_anchor, record_clock_anchor, SecretStore};
use crate::{
    CLOCK_ROLLBACK_TOLERANCE_SECONDS, EXPECTED_ISSUER, OFFLINE_GRACE_MAX_SECONDS, PRODUCT_ID,
};

pub fn parse_rfc3339(ts: &str) -> Result<DateTime<Utc>, LicenseCoreError> {
    DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| LicenseCoreError::InvalidTimestamp)
}

/// Verifies an Ed25519 signed lease token (`v1.<base64url_payload>.<base64url_sig>`)
/// strictly against the configured public verifying keys.
/// NEVER accepts an unsigned, invalidly signed, or unknown-`kid` lease.
pub fn verify_signed_lease_token(
    lease_token: &str,
    verifying_keys: &[(Option<String>, String)],
    expected_device_id: &str,
    expected_fingerprint: &str,
) -> Result<SignedLeasePayload, LicenseCoreError> {
    if verifying_keys.is_empty() {
        return Err(LicenseCoreError::VerificationKeyNotConfigured);
    }

    let parts: Vec<&str> = lease_token.split('.').collect();
    if parts.len() != 3 || parts[0] != "v1" {
        return Err(LicenseCoreError::InvalidLeaseFormat);
    }

    let encoded_payload = parts[1];
    let encoded_sig = parts[2];

    let payload_bytes = BASE64_URL
        .decode(encoded_payload)
        .map_err(|_| LicenseCoreError::InvalidLeasePayload)?;
    let sig_bytes = BASE64_URL
        .decode(encoded_sig)
        .map_err(|_| LicenseCoreError::InvalidLeaseSignature)?;

    let signature =
        Signature::from_slice(&sig_bytes).map_err(|_| LicenseCoreError::InvalidLeaseSignature)?;

    let payload: SignedLeasePayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| LicenseCoreError::MalformedLeasePayload)?;

    if payload.ver != 1 || payload.iss != EXPECTED_ISSUER || payload.aud != PRODUCT_ID {
        return Err(LicenseCoreError::InvalidLeaseClaims);
    }

    if payload.device_id.to_lowercase() != expected_device_id.to_lowercase()
        || payload.device_fingerprint.to_lowercase() != expected_fingerprint.to_lowercase()
    {
        return Err(LicenseCoreError::DeviceMismatch);
    }

    let signing_input = format!("v1.{encoded_payload}");
    let mut matched_any_kid = false;
    let mut verified = false;

    for (maybe_kid, pub_b64) in verifying_keys {
        if let Some(kid) = maybe_kid {
            if kid != &payload.kid {
                continue;
            }
        }
        matched_any_kid = true;
        let raw_key = match BASE64_STANDARD.decode(pub_b64.trim()) {
            Ok(bytes) if bytes.len() == 32 => bytes,
            _ => continue,
        };
        let key_array: [u8; 32] = match raw_key.try_into() {
            Ok(arr) => arr,
            Err(_) => continue,
        };
        let verifying_key = match VerifyingKey::from_bytes(&key_array) {
            Ok(vk) => vk,
            Err(_) => continue,
        };
        if verifying_key
            .verify(signing_input.as_bytes(), &signature)
            .is_ok()
        {
            verified = true;
            break;
        }
    }

    if !matched_any_kid {
        return Err(LicenseCoreError::UnknownSigningKeyId);
    }
    if !verified {
        return Err(LicenseCoreError::InvalidLeaseSignature);
    }

    Ok(payload)
}

/// Evaluates an already-signed local lease for offline grace period (max 7 days)
/// with 5-minute clock rollback tolerance and subscription expiration cap.
pub fn evaluate_offline_lease(
    saved_state: &LicenseState,
    verifying_keys: &[(Option<String>, String)],
    identity: &DeviceIdentity,
    secrets: &dyn SecretStore,
    now_utc: DateTime<Utc>,
) -> Result<LicenseState, LicenseCoreError> {
    if saved_state.lease_token.trim().is_empty() {
        return Err(LicenseCoreError::OfflineGraceUnavailable);
    }

    let lease = verify_signed_lease_token(
        &saved_state.lease_token,
        verifying_keys,
        &identity.device_id,
        &identity.device_fingerprint,
    )?;

    if lease.status != "active" && lease.status != "past_due" {
        return Err(LicenseCoreError::LicenseInactive(
            map_error_code_to_user_message(&lease.status, "License Inactive"),
        ));
    }

    let issued_at = parse_rfc3339(&lease.iat)?;
    let lease_exp = parse_rfc3339(&lease.exp)?;
    let now_ts = now_utc.timestamp();

    // Clock rollback check against lease.iat (5-minute tolerance)
    if now_ts + CLOCK_ROLLBACK_TOLERANCE_SECONDS < issued_at.timestamp() {
        return Err(LicenseCoreError::ClockRollbackDetected);
    }

    // Clock rollback check against Credential Manager clock-anchor (5-minute tolerance)
    if let Some(anchor_ts) = read_clock_anchor(secrets) {
        if now_ts + CLOCK_ROLLBACK_TOLERANCE_SECONDS < anchor_ts {
            return Err(LicenseCoreError::ClockRollbackDetected);
        }
    }

    // Enforce hard 7-day ceiling on offline grace period regardless of lease claim
    let max_allowed_exp = issued_at.timestamp() + OFFLINE_GRACE_MAX_SECONDS;
    let effective_exp = lease_exp.timestamp().min(max_allowed_exp);
    if now_ts > effective_exp {
        return Err(LicenseCoreError::OfflineGraceExpired);
    }

    // For subscription licenses, never exceed expires_at
    if lease.license_type == "subscription" {
        if let Some(exp_str) = &lease.expires_at {
            let sub_exp = parse_rfc3339(exp_str)?;
            if now_ts >= sub_exp.timestamp() {
                return Err(LicenseCoreError::LicenseExpired);
            }
        }
    }

    record_clock_anchor(secrets, now_utc);

    Ok(lease_to_license_state(
        &lease,
        &saved_state.key_prefix,
        &saved_state.lease_token,
        true,
    ))
}

pub fn lease_to_license_state(
    lease: &SignedLeasePayload,
    key_prefix: &str,
    lease_token: &str,
    is_offline_grace: bool,
) -> LicenseState {
    LicenseState {
        plan: if !lease.plan_name.is_empty() {
            lease.plan_name.clone()
        } else {
            lease.plan_code.clone()
        },
        status: lease.status.clone(),
        expires_at: lease.expires_at.clone(),
        lifetime: lease.lifetime || lease.license_type == "perpetual",
        last_validated_at: lease.iat.clone(),
        device_id: lease.device_id.clone(),
        license_id: lease.license_id.clone(),
        activation_id: lease.activation_id.clone(),
        key_prefix: key_prefix.to_string(),
        license_type: lease.license_type.clone(),
        billing_interval: lease.billing_interval.clone(),
        current_period_start: lease.current_period_start.clone(),
        current_period_end: lease.current_period_end.clone(),
        cancel_at_period_end: lease.cancel_at_period_end,
        device_limit: lease.device_limit,
        devices_used: lease.devices_used,
        offline_grace_until: lease.offline_grace_until.clone(),
        is_offline_grace,
        entitlements: lease.entitlements.clone(),
        lease_token: lease_token.to_string(),
    }
}

/// Evaluates local license state for a specific ecosystem product and returns a
/// sanitized `ExtensionAuthVerdict` containing zero sensitive credentials.
pub fn evaluate_product_verdict(
    saved_state: Option<&LicenseState>,
    verifying_keys: &[(Option<String>, String)],
    identity: &DeviceIdentity,
    secrets: &dyn SecretStore,
    product: ProductEntitlement,
    now_utc: DateTime<Utc>,
) -> ExtensionAuthVerdict {
    let Some(saved) = saved_state else {
        return ExtensionAuthVerdict {
            authorized: false,
            product: product.as_str().to_string(),
            license_status: "not_activated".to_string(),
            license_type: None,
            plan_name: None,
            expires_at: None,
            offline_grace_until: None,
            is_offline_grace: false,
            error_code: Some("NOT_ACTIVATED".to_string()),
            error_message: Some("License is not activated on this device.".to_string()),
        };
    };

    match evaluate_offline_lease(saved, verifying_keys, identity, secrets, now_utc) {
        Ok(state) => {
            if !state.entitlements.is_product_entitled(product) {
                return ExtensionAuthVerdict {
                    authorized: false,
                    product: product.as_str().to_string(),
                    license_status: state.status,
                    license_type: Some(state.license_type),
                    plan_name: Some(state.plan),
                    expires_at: state.expires_at,
                    offline_grace_until: Some(state.offline_grace_until),
                    is_offline_grace: state.is_offline_grace,
                    error_code: Some(LicenseCoreError::ProductNotEntitled.code().to_string()),
                    error_message: Some(LicenseCoreError::ProductNotEntitled.to_string()),
                };
            }
            ExtensionAuthVerdict {
                authorized: true,
                product: product.as_str().to_string(),
                license_status: state.status,
                license_type: Some(state.license_type),
                plan_name: Some(state.plan),
                expires_at: state.expires_at,
                offline_grace_until: Some(state.offline_grace_until),
                is_offline_grace: state.is_offline_grace,
                error_code: None,
                error_message: None,
            }
        }
        Err(err) => ExtensionAuthVerdict {
            authorized: false,
            product: product.as_str().to_string(),
            license_status: "unauthorized".to_string(),
            license_type: None,
            plan_name: None,
            expires_at: None,
            offline_grace_until: None,
            is_offline_grace: false,
            error_code: Some(err.code().to_string()),
            error_message: Some(err.to_string()),
        },
    }
}
