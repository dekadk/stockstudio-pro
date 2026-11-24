use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::api::{
    validate_create_license_payload, validate_id_token, AdminApiClient, AdminEventsResponse,
    AdminLicenseDetailResponse, AdminLicensesResponse, AdminMeResponse, AdminStatsResponse,
    CreateLicenseOutcome, CreateLicensePayload, LicenseSummaryDto, LifecycleMutationOutcome,
    ListEventsParams, ListLicensesParams, RenewSubscriptionPayload, UpdateLicensePayload,
};
use crate::clipboard::{
    copy_secret_with_auto_clear, SystemClipboard, DEFAULT_CLIPBOARD_CLEAR_SECS,
};
use crate::security::{AppSecurityState, Environment, SessionStatusDto};
use crate::vault::{write_and_verify_vault_file, VaultSecretPayload};

pub struct OneTimeKeyRecord {
    pub environment: Environment,
    pub api_url: String,
    pub license_id: String,
    pub key_prefix: String,
    pub license_key: Zeroizing<String>,
    pub issued_at: String,
}

pub struct IssuanceRuntimeState {
    in_flight_keys: HashSet<String>,
    uncertain_keys: HashSet<String>,
    in_flight_lifecycle_ops: HashSet<String>,
    uncertain_lifecycle_ops: HashSet<String>,
    one_time_key: Option<OneTimeKeyRecord>,
}

impl Default for IssuanceRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

impl IssuanceRuntimeState {
    pub fn new() -> Self {
        Self {
            in_flight_keys: HashSet::new(),
            uncertain_keys: HashSet::new(),
            in_flight_lifecycle_ops: HashSet::new(),
            uncertain_lifecycle_ops: HashSet::new(),
            one_time_key: None,
        }
    }

    pub fn wipe_one_time_key(&mut self) {
        self.one_time_key = None;
    }

    pub fn begin_lifecycle_op(&mut self, op_key: &str) -> Result<(), String> {
        if self.in_flight_lifecycle_ops.contains(op_key) {
            return Err(
                "DUPLICATE_IN_FLIGHT: This lifecycle operation is already in progress. Please wait."
                    .to_string(),
            );
        }
        if self.uncertain_lifecycle_ops.contains(op_key) {
            return Err(
                "UNCERTAIN_OUTCOME_LOCKED: A previous attempt for this operation timed out or dropped. Refresh License Details before retrying."
                    .to_string(),
            );
        }
        self.in_flight_lifecycle_ops.insert(op_key.to_string());
        Ok(())
    }

    pub fn finish_lifecycle_op(&mut self, op_key: &str, uncertain: bool) {
        self.in_flight_lifecycle_ops.remove(op_key);
        if uncertain {
            self.uncertain_lifecycle_ops.insert(op_key.to_string());
        }
    }
}

/// Enforces that the active Rust session environment strictly matches the UI's
/// expected target environment before any mutation is executed.
pub fn enforce_environment_match(
    active_env: Environment,
    expected_env: Environment,
) -> Result<(), String> {
    if active_env != expected_env {
        return Err(format!(
            "ENVIRONMENT_MISMATCH: Active session is '{}' but operation targeted '{}'. Aborted.",
            active_env.as_str(),
            expected_env.as_str()
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct UpdateLicenseCommandInput {
    pub expected_environment: Environment,
    pub license_id: String,
    pub payload: UpdateLicensePayload,
}

#[derive(Debug, Deserialize)]
pub struct ReasonMutationCommandInput {
    pub expected_environment: Environment,
    pub license_id: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct RenewSubscriptionCommandInput {
    pub expected_environment: Environment,
    pub license_id: String,
    pub payload: RenewSubscriptionPayload,
}

#[derive(Debug, Deserialize)]
pub struct RevokeLicenseCommandInput {
    pub expected_environment: Environment,
    pub license_id: String,
    pub expected_key_prefix: String,
    pub confirm_key_prefix: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct ForceDeactivateDeviceCommandInput {
    pub expected_environment: Environment,
    pub license_id: String,
    pub activation_id: String,
    pub expected_key_prefix: String,
    pub confirm_key_prefix: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct LifecycleMutationResultDto {
    pub outcome: String, // "completed" | "uncertain" | "rejected"
    pub already_applied: bool,
    pub audit_event_verified: bool,
    pub detail: Option<AdminLicenseDetailResponse>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IssueLicenseCommandInput {
    pub expected_environment: Environment,
    pub idempotency_key: String,
    pub payload: CreateLicensePayload,
}

#[derive(Debug, Serialize)]
pub struct IssueLicenseResultDto {
    pub outcome: String, // "created" | "duplicate_conflict" | "uncertain" | "rejected"
    pub license: Option<LicenseSummaryDto>,
    /// Returned ONLY once on `outcome == "created"` for immediate one-time handoff modal.
    pub one_time_license_key: Option<String>,
    pub audit_event_verified: bool,
    pub existing_license_id: Option<String>,
    pub existing_key_prefix: Option<String>,
    pub idempotency_key: String,
    pub message: Option<String>,
}

#[tauri::command]
pub fn get_session_status(
    security: State<'_, Mutex<AppSecurityState>>,
) -> Result<SessionStatusDto, String> {
    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
    Ok(guard.status())
}

#[tauri::command]
pub fn set_environment(
    environment: Environment,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
) -> Result<SessionStatusDto, String> {
    if let Ok(mut iss) = issuance.lock() {
        iss.wipe_one_time_key();
    }
    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
    guard.set_environment(environment);
    Ok(guard.status())
}

#[tauri::command]
pub fn set_idle_timeout(
    timeout_secs: u64,
    security: State<'_, Mutex<AppSecurityState>>,
) -> Result<SessionStatusDto, String> {
    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
    guard.set_idle_timeout_secs(timeout_secs)?;
    Ok(guard.status())
}

#[tauri::command]
pub async fn unlock_with_key(
    api_key: String,
    remember_in_keyring: bool,
    security: State<'_, Mutex<AppSecurityState>>,
    api: State<'_, AdminApiClient>,
) -> Result<SessionStatusDto, String> {
    let trimmed = Zeroizing::new(api_key.trim().to_string());
    if trimmed.is_empty() {
        return Err("INVALID_REQUEST: Admin API key cannot be empty.".to_string());
    }

    let env = {
        let guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        guard.environment()
    };

    let me = api.get_me(env.base_url(), &trimmed).await?;

    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;

    if remember_in_keyring {
        guard.store().set_key(env, &trimmed)?;
    }
    guard.unlock(trimmed, me);
    Ok(guard.status())
}

#[tauri::command]
pub async fn unlock_from_keyring(
    security: State<'_, Mutex<AppSecurityState>>,
    api: State<'_, AdminApiClient>,
) -> Result<SessionStatusDto, String> {
    let (env, stored_key) = {
        let guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        let env = guard.environment();
        let key = guard
            .store()
            .get_key(env)?
            .ok_or_else(|| "NO_STORED_KEY: No stored Admin API key found for this environment.".to_string())?;
        (env, key)
    };

    let me = api.get_me(env.base_url(), &stored_key).await?;

    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
    guard.unlock(stored_key, me);
    Ok(guard.status())
}

#[tauri::command]
pub fn lock_session(
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
) -> Result<SessionStatusDto, String> {
    if let Ok(mut iss) = issuance.lock() {
        iss.wipe_one_time_key();
    }
    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
    guard.lock();
    Ok(guard.status())
}

#[tauri::command]
pub fn forget_stored_credential(
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
) -> Result<SessionStatusDto, String> {
    if let Ok(mut iss) = issuance.lock() {
        iss.wipe_one_time_key();
    }
    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
    let env = guard.environment();
    guard.store().delete_key(env)?;
    guard.lock();
    Ok(guard.status())
}

#[tauri::command]
pub fn touch_activity(
    security: State<'_, Mutex<AppSecurityState>>,
) -> Result<SessionStatusDto, String> {
    let mut guard = security
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
    guard.touch();
    Ok(guard.status())
}

#[tauri::command]
pub async fn fetch_admin_me(
    security: State<'_, Mutex<AppSecurityState>>,
    api: State<'_, AdminApiClient>,
) -> Result<AdminMeResponse, String> {
    let (key, env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        guard.get_active_key_and_env()?
    };

    let me = match api.get_me(env.base_url(), &key).await {
        Ok(m) => m,
        Err(e) => {
            if let Ok(mut guard) = security.lock() {
                guard.lock_if_unauthorized(&e);
            }
            return Err(e);
        }
    };
    if let Ok(mut guard) = security.lock() {
        guard.update_profile(me.clone());
    }
    Ok(me)
}

#[tauri::command]
pub async fn fetch_dashboard_stats(
    security: State<'_, Mutex<AppSecurityState>>,
    api: State<'_, AdminApiClient>,
) -> Result<AdminStatsResponse, String> {
    let (key, env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        guard.get_active_key_and_env()?
    };

    let res = api.get_stats(env.base_url(), &key).await;
    if let Err(ref e) = res {
        if let Ok(mut guard) = security.lock() {
            guard.lock_if_unauthorized(e);
        }
    }
    res
}

#[tauri::command]
pub async fn fetch_licenses(
    params: Option<ListLicensesParams>,
    security: State<'_, Mutex<AppSecurityState>>,
    api: State<'_, AdminApiClient>,
) -> Result<AdminLicensesResponse, String> {
    let (key, env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        guard.get_active_key_and_env()?
    };

    let res = api
        .list_licenses(env.base_url(), &key, &params.unwrap_or_default())
        .await;
    if let Err(ref e) = res {
        if let Ok(mut guard) = security.lock() {
            guard.lock_if_unauthorized(e);
        }
    }
    res
}

#[tauri::command]
pub async fn fetch_license_details(
    license_id: String,
    security: State<'_, Mutex<AppSecurityState>>,
    api: State<'_, AdminApiClient>,
) -> Result<AdminLicenseDetailResponse, String> {
    let (key, env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        guard.get_active_key_and_env()?
    };

    let res = api
        .get_license_detail(env.base_url(), &key, &license_id)
        .await;
    if let Err(ref e) = res {
        if let Ok(mut guard) = security.lock() {
            guard.lock_if_unauthorized(e);
        }
    }
    res
}

#[tauri::command]
pub async fn fetch_events(
    params: Option<ListEventsParams>,
    security: State<'_, Mutex<AppSecurityState>>,
    api: State<'_, AdminApiClient>,
) -> Result<AdminEventsResponse, String> {
    let (key, env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        guard.get_active_key_and_env()?
    };

    let res = api
        .list_events(env.base_url(), &key, &params.unwrap_or_default())
        .await;
    if let Err(ref e) = res {
        if let Ok(mut guard) = security.lock() {
            guard.lock_if_unauthorized(e);
        }
    }
    res
}

// =============================================================================
// LM-04: Secure License Issuance & One-Time Key Handoff Commands
// =============================================================================

#[tauri::command]
pub async fn issue_license(
    input: IssueLicenseCommandInput,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
    api: State<'_, AdminApiClient>,
) -> Result<IssueLicenseResultDto, String> {
    let idem_key = input.idempotency_key.trim().to_string();
    if idem_key.len() < 8 || idem_key.len() > 128 {
        return Err("INVALID_REQUEST: A valid Idempotency-Key (8-128 chars) is required.".to_string());
    }

    validate_create_license_payload(&input.payload)?;

    let (key, active_env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        if !guard.has_permission("licenses:create") {
            return Err(
                "FORBIDDEN: Your authenticated administrator role does not have 'licenses:create' permission."
                    .to_string(),
            );
        }
        let (k, env) = guard.get_active_key_and_env()?;
        enforce_environment_match(env, input.expected_environment)?;
        (k, env)
    };

    {
        let mut iss = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        if iss.in_flight_keys.contains(&idem_key) {
            return Err(
                "DUPLICATE_IN_FLIGHT: This issuance request is already being submitted. Please wait."
                    .to_string(),
            );
        }
        if iss.uncertain_keys.contains(&idem_key) {
            return Ok(IssueLicenseResultDto {
                outcome: "uncertain".to_string(),
                license: None,
                one_time_license_key: None,
                audit_event_verified: false,
                existing_license_id: None,
                existing_key_prefix: None,
                idempotency_key: idem_key,
                message: Some(
                    "This Idempotency-Key previously ended in an uncertain network state. Never blindly re-submit: inspect License Registry and Events & Activity first."
                        .to_string(),
                ),
            });
        }
        iss.in_flight_keys.insert(idem_key.clone());
    }

    let outcome = api
        .create_license(active_env.base_url(), &key, &idem_key, &input.payload)
        .await;

    // Always clear in-flight marker
    if let Ok(mut iss) = issuance.lock() {
        iss.in_flight_keys.remove(&idem_key);
    }

    match outcome {
        CreateLicenseOutcome::Created {
            license_key,
            license,
            ..
        } => {
            // Immediately verify resulting metadata and `license.issued` audit event
            let mut verified_license = *license;
            let mut audit_event_verified = false;
            if let Ok(detail) = api
                .get_license_detail(active_env.base_url(), &key, &verified_license.license_id)
                .await
            {
                audit_event_verified = detail
                    .events
                    .iter()
                    .any(|ev| ev.event_type == "license.issued");
                verified_license = detail.license;
            }

            let key_for_handoff = (*license_key).clone();

            if let Ok(mut iss) = issuance.lock() {
                iss.one_time_key = Some(OneTimeKeyRecord {
                    environment: active_env,
                    api_url: active_env.base_url().to_string(),
                    license_id: verified_license.license_id.clone(),
                    key_prefix: verified_license.key_prefix.clone(),
                    license_key,
                    issued_at: verified_license.created_at.clone(),
                });
            }

            Ok(IssueLicenseResultDto {
                outcome: "created".to_string(),
                license: Some(verified_license),
                one_time_license_key: Some(key_for_handoff),
                audit_event_verified,
                existing_license_id: None,
                existing_key_prefix: None,
                idempotency_key: idem_key,
                message: None,
            })
        }
        CreateLicenseOutcome::DuplicateConflict {
            license_id,
            key_prefix,
            message,
        } => Ok(IssueLicenseResultDto {
            outcome: "duplicate_conflict".to_string(),
            license: None,
            one_time_license_key: None,
            audit_event_verified: false,
            existing_license_id: license_id,
            existing_key_prefix: key_prefix,
            idempotency_key: idem_key,
            message: Some(message),
        }),
        CreateLicenseOutcome::Uncertain { reason } => {
            if let Ok(mut iss) = issuance.lock() {
                iss.uncertain_keys.insert(idem_key.clone());
            }
            Ok(IssueLicenseResultDto {
                outcome: "uncertain".to_string(),
                license: None,
                one_time_license_key: None,
                audit_event_verified: false,
                existing_license_id: None,
                existing_key_prefix: None,
                idempotency_key: idem_key,
                message: Some(reason),
            })
        }
        CreateLicenseOutcome::Rejected { code, message, .. } => Ok(IssueLicenseResultDto {
            outcome: "rejected".to_string(),
            license: None,
            one_time_license_key: None,
            audit_event_verified: false,
            existing_license_id: None,
            existing_key_prefix: None,
            idempotency_key: idem_key,
            message: Some(format!("{code}: {message}")),
        }),
    }
}

#[tauri::command]
pub fn copy_one_time_key_to_clipboard(
    license_id: String,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
) -> Result<u64, String> {
    let secret = {
        let guard = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        match &guard.one_time_key {
            Some(rec) if rec.license_id == license_id => rec.license_key.clone(),
            _ => {
                return Err(
                    "NO_ACTIVE_KEY: The one-time license key is no longer available in memory."
                        .to_string(),
                )
            }
        }
    };

    copy_secret_with_auto_clear(
        Arc::new(SystemClipboard),
        secret,
        Duration::from_secs(DEFAULT_CLIPBOARD_CLEAR_SECS),
    )?;
    Ok(DEFAULT_CLIPBOARD_CLEAR_SECS)
}

#[tauri::command]
pub fn export_one_time_key_vault(
    license_id: String,
    target_path: String,
    passphrase: String,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
) -> Result<String, String> {
    let pass = Zeroizing::new(passphrase);
    let payload = {
        let guard = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        match &guard.one_time_key {
            Some(rec) if rec.license_id == license_id => VaultSecretPayload {
                environment: rec.environment.as_str().to_string(),
                api_url: rec.api_url.clone(),
                license_id: rec.license_id.clone(),
                key_prefix: rec.key_prefix.clone(),
                license_key: (*rec.license_key).clone(),
                issued_at: rec.issued_at.clone(),
            },
            _ => {
                return Err(
                    "NO_ACTIVE_KEY: The one-time license key is no longer available in memory."
                        .to_string(),
                )
            }
        }
    };

    let path = PathBuf::from(target_path.trim());
    write_and_verify_vault_file(&path, &payload, &pass)
}

#[tauri::command]
pub fn dismiss_one_time_key(
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
) -> Result<(), String> {
    let mut guard = issuance
        .lock()
        .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
    guard.wipe_one_time_key();
    Ok(())
}

// =============================================================================
// LM-05: Secure License Revocation & Force Device Deactivation Commands
// =============================================================================

#[tauri::command]
pub async fn revoke_license(
    input: RevokeLicenseCommandInput,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
    api: State<'_, AdminApiClient>,
) -> Result<LifecycleMutationResultDto, String> {
    validate_id_token(&input.license_id, "license_id")?;
    let expected_prefix = input.expected_key_prefix.trim().to_uppercase();
    let confirm_prefix = input.confirm_key_prefix.trim().to_uppercase();
    if expected_prefix.is_empty() || confirm_prefix != expected_prefix {
        return Err(
            "INVALID_REQUEST: Confirmation license prefix does not match the target license."
                .to_string(),
        );
    }
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() > 500 {
        return Err(
            "INVALID_REQUEST: A non-empty revocation reason (1-500 chars) is required.".to_string(),
        );
    }

    let (key, active_env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        if !guard.has_permission("licenses:revoke") {
            return Err(
                "FORBIDDEN: Your authenticated administrator role does not have 'licenses:revoke' permission."
                    .to_string(),
            );
        }
        let (k, env) = guard.get_active_key_and_env()?;
        enforce_environment_match(env, input.expected_environment)?;
        (k, env)
    };

    let op_key = format!("revoke:{}", input.license_id.trim());
    {
        let mut iss = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        iss.begin_lifecycle_op(&op_key)?;
    }

    let outcome = api
        .revoke_license(
            active_env.base_url(),
            &key,
            &input.license_id,
            &confirm_prefix,
            reason,
        )
        .await;

    let is_uncertain = matches!(outcome, LifecycleMutationOutcome::Uncertain { .. });
    if let Ok(mut iss) = issuance.lock() {
        iss.finish_lifecycle_op(&op_key, is_uncertain);
    }

    match outcome {
        LifecycleMutationOutcome::Completed {
            already_applied,
            message,
        } => {
            // Authoritative post-mutation read to verify status & audit event
            let detail = api
                .get_license_detail(active_env.base_url(), &key, &input.license_id)
                .await
                .ok();
            let audit_event_verified = detail
                .as_ref()
                .map(|d| d.events.iter().any(|ev| ev.event_type == "license.revoked"))
                .unwrap_or(false);

            Ok(LifecycleMutationResultDto {
                outcome: "completed".to_string(),
                already_applied,
                audit_event_verified,
                detail,
                message,
            })
        }
        LifecycleMutationOutcome::Uncertain { reason } => Ok(LifecycleMutationResultDto {
            outcome: "uncertain".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(reason),
        }),
        LifecycleMutationOutcome::Rejected { code, message, .. } => {
            Ok(LifecycleMutationResultDto {
                outcome: "rejected".to_string(),
                already_applied: false,
                audit_event_verified: false,
                detail: None,
                message: Some(format!("{code}: {message}")),
            })
        }
    }
}

#[tauri::command]
pub async fn force_deactivate_device(
    input: ForceDeactivateDeviceCommandInput,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
    api: State<'_, AdminApiClient>,
) -> Result<LifecycleMutationResultDto, String> {
    validate_id_token(&input.license_id, "license_id")?;
    validate_id_token(&input.activation_id, "activation_id")?;
    let expected_prefix = input.expected_key_prefix.trim().to_uppercase();
    let confirm_prefix = input.confirm_key_prefix.trim().to_uppercase();
    if expected_prefix.is_empty() || confirm_prefix != expected_prefix {
        return Err(
            "INVALID_REQUEST: Confirmation license prefix does not match the target license."
                .to_string(),
        );
    }
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() > 500 {
        return Err(
            "INVALID_REQUEST: A non-empty deactivation reason (1-500 chars) is required."
                .to_string(),
        );
    }

    let (key, active_env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        if !guard.has_permission("devices:deactivate") {
            return Err(
                "FORBIDDEN: Your authenticated administrator role does not have 'devices:deactivate' permission."
                    .to_string(),
            );
        }
        let (k, env) = guard.get_active_key_and_env()?;
        enforce_environment_match(env, input.expected_environment)?;
        (k, env)
    };

    let op_key = format!(
        "deactivate:{}:{}",
        input.license_id.trim(),
        input.activation_id.trim()
    );
    {
        let mut iss = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        iss.begin_lifecycle_op(&op_key)?;
    }

    let outcome = api
        .force_deactivate_device(
            active_env.base_url(),
            &key,
            &input.license_id,
            &input.activation_id,
            &confirm_prefix,
            reason,
        )
        .await;

    let is_uncertain = matches!(outcome, LifecycleMutationOutcome::Uncertain { .. });
    if let Ok(mut iss) = issuance.lock() {
        iss.finish_lifecycle_op(&op_key, is_uncertain);
    }

    match outcome {
        LifecycleMutationOutcome::Completed {
            already_applied,
            message,
        } => {
            let detail = api
                .get_license_detail(active_env.base_url(), &key, &input.license_id)
                .await
                .ok();
            let audit_event_verified = detail
                .as_ref()
                .map(|d| {
                    d.events
                        .iter()
                        .any(|ev| ev.event_type == "license.deactivated")
                })
                .unwrap_or(false);

            Ok(LifecycleMutationResultDto {
                outcome: "completed".to_string(),
                already_applied,
                audit_event_verified,
                detail,
                message,
            })
        }
        LifecycleMutationOutcome::Uncertain { reason } => Ok(LifecycleMutationResultDto {
            outcome: "uncertain".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(reason),
        }),
        LifecycleMutationOutcome::Rejected { code, message, .. } => {
            Ok(LifecycleMutationResultDto {
                outcome: "rejected".to_string(),
                already_applied: false,
                audit_event_verified: false,
                detail: None,
                message: Some(format!("{code}: {message}")),
            })
        }
    }
}

#[tauri::command]
pub async fn update_license(
    input: UpdateLicenseCommandInput,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
    api: State<'_, AdminApiClient>,
) -> Result<LifecycleMutationResultDto, String> {
    validate_id_token(&input.license_id, "license_id")?;
    let (key, active_env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        if !guard.has_permission("licenses:update") {
            return Err("FORBIDDEN: Missing 'licenses:update' permission.".to_string());
        }
        let (k, env) = guard.get_active_key_and_env()?;
        enforce_environment_match(env, input.expected_environment)?;
        (k, env)
    };

    let op_key = format!("update:{}", input.license_id.trim());
    {
        let mut iss = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        iss.begin_lifecycle_op(&op_key)?;
    }

    let outcome = api
        .update_license(active_env.base_url(), &key, &input.license_id, &input.payload)
        .await;

    let is_uncertain = matches!(outcome, LifecycleMutationOutcome::Uncertain { .. });
    if let Ok(mut iss) = issuance.lock() {
        iss.finish_lifecycle_op(&op_key, is_uncertain);
    }

    match outcome {
        LifecycleMutationOutcome::Completed {
            already_applied,
            message,
        } => {
            let detail = api
                .get_license_detail(active_env.base_url(), &key, &input.license_id)
                .await
                .ok();
            let audit_event_verified = detail
                .as_ref()
                .map(|d| d.events.iter().any(|ev| ev.event_type == "license.updated"))
                .unwrap_or(false);
            Ok(LifecycleMutationResultDto {
                outcome: "completed".to_string(),
                already_applied,
                audit_event_verified,
                detail,
                message,
            })
        }
        LifecycleMutationOutcome::Uncertain { reason } => Ok(LifecycleMutationResultDto {
            outcome: "uncertain".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(reason),
        }),
        LifecycleMutationOutcome::Rejected { code, message, .. } => Ok(LifecycleMutationResultDto {
            outcome: "rejected".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(format!("{code}: {message}")),
        }),
    }
}

#[tauri::command]
pub async fn suspend_license(
    input: ReasonMutationCommandInput,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
    api: State<'_, AdminApiClient>,
) -> Result<LifecycleMutationResultDto, String> {
    validate_id_token(&input.license_id, "license_id")?;
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() > 500 {
        return Err("INVALID_REQUEST: A non-empty suspension reason is required.".to_string());
    }
    let (key, active_env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        if !guard.has_permission("licenses:suspend") {
            return Err("FORBIDDEN: Missing 'licenses:suspend' permission.".to_string());
        }
        let (k, env) = guard.get_active_key_and_env()?;
        enforce_environment_match(env, input.expected_environment)?;
        (k, env)
    };

    let op_key = format!("suspend:{}", input.license_id.trim());
    {
        let mut iss = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        iss.begin_lifecycle_op(&op_key)?;
    }

    let outcome = api
        .suspend_license(active_env.base_url(), &key, &input.license_id, reason)
        .await;

    let is_uncertain = matches!(outcome, LifecycleMutationOutcome::Uncertain { .. });
    if let Ok(mut iss) = issuance.lock() {
        iss.finish_lifecycle_op(&op_key, is_uncertain);
    }

    match outcome {
        LifecycleMutationOutcome::Completed {
            already_applied,
            message,
        } => {
            let detail = api
                .get_license_detail(active_env.base_url(), &key, &input.license_id)
                .await
                .ok();
            let audit_event_verified = detail
                .as_ref()
                .map(|d| d.events.iter().any(|ev| ev.event_type == "license.suspended"))
                .unwrap_or(false);
            Ok(LifecycleMutationResultDto {
                outcome: "completed".to_string(),
                already_applied,
                audit_event_verified,
                detail,
                message,
            })
        }
        LifecycleMutationOutcome::Uncertain { reason } => Ok(LifecycleMutationResultDto {
            outcome: "uncertain".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(reason),
        }),
        LifecycleMutationOutcome::Rejected { code, message, .. } => Ok(LifecycleMutationResultDto {
            outcome: "rejected".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(format!("{code}: {message}")),
        }),
    }
}

#[tauri::command]
pub async fn reinstate_license(
    input: ReasonMutationCommandInput,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
    api: State<'_, AdminApiClient>,
) -> Result<LifecycleMutationResultDto, String> {
    validate_id_token(&input.license_id, "license_id")?;
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() > 500 {
        return Err("INVALID_REQUEST: A non-empty reinstatement reason is required.".to_string());
    }
    let (key, active_env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        if !guard.has_permission("licenses:reinstate") {
            return Err("FORBIDDEN: Missing 'licenses:reinstate' permission.".to_string());
        }
        let (k, env) = guard.get_active_key_and_env()?;
        enforce_environment_match(env, input.expected_environment)?;
        (k, env)
    };

    let op_key = format!("reinstate:{}", input.license_id.trim());
    {
        let mut iss = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        iss.begin_lifecycle_op(&op_key)?;
    }

    let outcome = api
        .reinstate_license(active_env.base_url(), &key, &input.license_id, reason)
        .await;

    let is_uncertain = matches!(outcome, LifecycleMutationOutcome::Uncertain { .. });
    if let Ok(mut iss) = issuance.lock() {
        iss.finish_lifecycle_op(&op_key, is_uncertain);
    }

    match outcome {
        LifecycleMutationOutcome::Completed {
            already_applied,
            message,
        } => {
            let detail = api
                .get_license_detail(active_env.base_url(), &key, &input.license_id)
                .await
                .ok();
            let audit_event_verified = detail
                .as_ref()
                .map(|d| {
                    d.events
                        .iter()
                        .any(|ev| ev.event_type == "license.reinstated")
                })
                .unwrap_or(false);
            Ok(LifecycleMutationResultDto {
                outcome: "completed".to_string(),
                already_applied,
                audit_event_verified,
                detail,
                message,
            })
        }
        LifecycleMutationOutcome::Uncertain { reason } => Ok(LifecycleMutationResultDto {
            outcome: "uncertain".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(reason),
        }),
        LifecycleMutationOutcome::Rejected { code, message, .. } => Ok(LifecycleMutationResultDto {
            outcome: "rejected".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(format!("{code}: {message}")),
        }),
    }
}

#[tauri::command]
pub async fn renew_subscription(
    input: RenewSubscriptionCommandInput,
    security: State<'_, Mutex<AppSecurityState>>,
    issuance: State<'_, Mutex<IssuanceRuntimeState>>,
    api: State<'_, AdminApiClient>,
) -> Result<LifecycleMutationResultDto, String> {
    validate_id_token(&input.license_id, "license_id")?;
    let (key, active_env) = {
        let mut guard = security
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Security state lock poisoned.".to_string())?;
        if !guard.has_permission("licenses:renew") {
            return Err("FORBIDDEN: Missing 'licenses:renew' permission.".to_string());
        }
        let (k, env) = guard.get_active_key_and_env()?;
        enforce_environment_match(env, input.expected_environment)?;
        (k, env)
    };

    let op_key = format!(
        "renew:{}:{}",
        input.license_id.trim(),
        input.payload.external_payment_id.trim()
    );
    {
        let mut iss = issuance
            .lock()
            .map_err(|_| "INTERNAL_ERROR: Issuance state lock poisoned.".to_string())?;
        iss.begin_lifecycle_op(&op_key)?;
    }

    let outcome = api
        .renew_subscription(active_env.base_url(), &key, &input.license_id, &input.payload)
        .await;

    let is_uncertain = matches!(outcome, LifecycleMutationOutcome::Uncertain { .. });
    if let Ok(mut iss) = issuance.lock() {
        iss.finish_lifecycle_op(&op_key, is_uncertain);
    }

    match outcome {
        LifecycleMutationOutcome::Completed {
            already_applied,
            message,
        } => {
            let detail = api
                .get_license_detail(active_env.base_url(), &key, &input.license_id)
                .await
                .ok();
            let audit_event_verified = detail
                .as_ref()
                .map(|d| d.events.iter().any(|ev| ev.event_type == "license.renewed"))
                .unwrap_or(false);
            Ok(LifecycleMutationResultDto {
                outcome: "completed".to_string(),
                already_applied,
                audit_event_verified,
                detail,
                message,
            })
        }
        LifecycleMutationOutcome::Uncertain { reason } => Ok(LifecycleMutationResultDto {
            outcome: "uncertain".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(reason),
        }),
        LifecycleMutationOutcome::Rejected { code, message, .. } => Ok(LifecycleMutationResultDto {
            outcome: "rejected".to_string(),
            already_applied: false,
            audit_event_verified: false,
            detail: None,
            message: Some(format!("{code}: {message}")),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_environment_match_for_staging_and_production() {
        assert!(enforce_environment_match(Environment::Staging, Environment::Staging).is_ok());
        assert!(
            enforce_environment_match(Environment::Production, Environment::Production).is_ok()
        );

        let mismatch =
            enforce_environment_match(Environment::Staging, Environment::Production).unwrap_err();
        assert!(mismatch.contains("ENVIRONMENT_MISMATCH"));
    }

    #[test]
    fn guards_duplicate_in_flight_and_uncertain_lifecycle_operations() {
        let mut state = IssuanceRuntimeState::new();
        assert!(state.begin_lifecycle_op("revoke:lic_01TEST").is_ok());

        // Duplicate while in flight
        let dup_err = state.begin_lifecycle_op("revoke:lic_01TEST").unwrap_err();
        assert!(dup_err.contains("DUPLICATE_IN_FLIGHT"));

        // Finish as uncertain -> subsequent retry blocked
        state.finish_lifecycle_op("revoke:lic_01TEST", true);
        let unc_err = state.begin_lifecycle_op("revoke:lic_01TEST").unwrap_err();
        assert!(unc_err.contains("UNCERTAIN_OUTCOME_LOCKED"));
    }
}
