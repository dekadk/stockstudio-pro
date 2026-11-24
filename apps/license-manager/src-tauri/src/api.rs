use std::fmt;
use std::time::Duration;

use chrono::DateTime;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use url::Url;
use zeroize::Zeroizing;

/// Explicit DTOs projected from the Admin API.
/// Sensitive database fields (key_hash, key_pepper_version, idempotency_key,
/// raw ip_hash) are NEVER defined on read DTOs and are stripped during
/// deserialization before reaching React.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminIdentityDto {
    pub id: String,
    pub name: String,
    pub key_prefix: String,
    pub role: String,
    pub permissions: Vec<String>,
    pub allowed_ips_configured: bool,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminMeResponse {
    pub ok: bool,
    pub admin: AdminIdentityDto,
    pub environment: String,
    pub signing_kid: String,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseEntitlementsDto {
    #[serde(default)]
    pub products: Vec<String>,
    #[serde(default)]
    pub features: Vec<String>,
    pub max_accounts: Option<i64>,
    pub updates_until: Option<String>,
    pub max_app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseSummaryDto {
    pub license_id: String,
    pub key_prefix: String,
    pub plan_code: String,
    pub plan_name: String,
    pub license_type: String,
    pub billing_interval: String,
    pub status: String,
    pub lifetime: bool,
    pub expires_at: Option<String>,
    pub current_period_start: Option<String>,
    pub current_period_end: Option<String>,
    pub grace_until: Option<String>,
    pub cancel_at_period_end: Option<bool>,
    pub device_limit: i64,
    pub devices_used: i64,
    pub entitlements: LicenseEntitlementsDto,
    pub customer_email: Option<String>,
    pub customer_name: Option<String>,
    pub external_customer_id: Option<String>,
    pub external_order_id: Option<String>,
    pub issued_at: Option<String>,
    pub activated_at: Option<String>,
    pub suspended_at: Option<String>,
    pub suspension_reason: Option<String>,
    pub revoked_at: Option<String>,
    pub revocation_reason: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginationDto {
    pub limit: u32,
    #[serde(default)]
    pub sort: Option<String>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminLicensesResponse {
    pub ok: bool,
    pub items: Vec<LicenseSummaryDto>,
    pub pagination: PaginationDto,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationSummaryDto {
    pub activation_id: String,
    pub device_id: String,
    pub device_name: Option<String>,
    pub app_version: Option<String>,
    pub status: String,
    pub activated_at: Option<String>,
    pub last_validated_at: Option<String>,
    pub deactivated_at: Option<String>,
    pub deactivated_by: Option<String>,
    pub deactivation_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BillingSubscriptionDto {
    pub id: Option<String>,
    pub provider: Option<String>,
    pub provider_status: Option<String>,
    pub current_period_start: Option<String>,
    pub current_period_end: Option<String>,
    pub last_payment_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminLicenseDetailResponse {
    pub ok: bool,
    pub license: LicenseSummaryDto,
    #[serde(default)]
    pub activations: Vec<ActivationSummaryDto>,
    pub billing_subscription: Option<BillingSubscriptionDto>,
    #[serde(default)]
    pub events: Vec<AuditEventDto>,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusBreakdownDto {
    pub pending_activation: i64,
    pub active: i64,
    pub past_due: i64,
    pub expired: i64,
    pub suspended: i64,
    pub revoked: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseTypeBreakdownDto {
    pub perpetual: i64,
    pub subscription: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BillingIntervalBreakdownDto {
    pub lifetime: i64,
    pub monthly: i64,
    pub yearly: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardStatsDto {
    pub total_licenses: i64,
    pub by_status: StatusBreakdownDto,
    pub by_license_type: LicenseTypeBreakdownDto,
    pub by_billing_interval: BillingIntervalBreakdownDto,
    pub active_device_activations: i64,
    pub expiring_within_7d: i64,
    pub issued_last_30d: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminStatsResponse {
    pub ok: bool,
    pub stats: DashboardStatsDto,
    pub environment: String,
    pub signing_kid: String,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEventDto {
    pub id: String,
    pub license_id: Option<String>,
    pub activation_id: Option<String>,
    pub device_id: Option<String>,
    pub event_type: String,
    pub actor_type: String,
    pub actor_id: Option<String>,
    pub previous_status: Option<String>,
    pub new_status: Option<String>,
    pub ip_hash_prefix: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub metadata_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminEventsResponse {
    pub ok: bool,
    pub items: Vec<AuditEventDto>,
    pub pagination: PaginationDto,
    pub server_time: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListLicensesParams {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
    pub sort: Option<String>,
    pub status: Option<String>,
    pub license_type: Option<String>,
    pub billing_interval: Option<String>,
    pub plan_code: Option<String>,
    pub product: Option<String>,
    pub q: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListEventsParams {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
    pub license_id: Option<String>,
    pub event_type: Option<String>,
    pub actor_type: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

// =============================================================================
// LM-04: License Issuance Request & Outcome Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateLicenseEntitlementsInput {
    pub products: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateLicensePayload {
    pub plan_code: String,
    pub plan_name: String,
    pub license_type: String,
    pub billing_interval: String,
    pub device_limit: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_period_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_period_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_customer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_order_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub entitlements: CreateLicenseEntitlementsInput,
}

#[derive(Deserialize)]
struct RawCreateLicenseResponse {
    ok: bool,
    license_key: String,
    license: LicenseSummaryDto,
    request_id: Option<String>,
    server_time: String,
}

pub enum CreateLicenseOutcome {
    Created {
        license_key: Zeroizing<String>,
        license: Box<LicenseSummaryDto>,
        request_id: Option<String>,
        server_time: String,
    },
    DuplicateConflict {
        license_id: Option<String>,
        key_prefix: Option<String>,
        message: String,
    },
    Uncertain {
        reason: String,
    },
    Rejected {
        status: u16,
        code: String,
        message: String,
    },
}

impl fmt::Debug for CreateLicenseOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Created { license, .. } => f
                .debug_struct("Created")
                .field("license_id", &license.license_id)
                .field("license_key", &"[REDACTED]")
                .finish(),
            Self::DuplicateConflict {
                license_id,
                key_prefix,
                message,
            } => f
                .debug_struct("DuplicateConflict")
                .field("license_id", license_id)
                .field("key_prefix", key_prefix)
                .field("message", message)
                .finish(),
            Self::Uncertain { reason } => {
                f.debug_struct("Uncertain").field("reason", reason).finish()
            }
            Self::Rejected {
                status,
                code,
                message,
            } => f
                .debug_struct("Rejected")
                .field("status", status)
                .field("code", code)
                .field("message", message)
                .finish(),
        }
    }
}

pub fn validate_create_license_payload(payload: &CreateLicensePayload) -> Result<(), String> {
    if payload.plan_code.trim().is_empty() || payload.plan_name.trim().is_empty() {
        return Err("INVALID_REQUEST: 'plan_code' and 'plan_name' are required.".to_string());
    }
    if !(1..=100).contains(&payload.device_limit) {
        return Err("INVALID_REQUEST: 'device_limit' must be an integer between 1 and 100.".to_string());
    }
    if payload.entitlements.products.is_empty() {
        return Err(
            "INVALID_REQUEST: At least one product entitlement ('desktop' or 'vectorizer_extension') is required."
                .to_string(),
        );
    }
    for product in &payload.entitlements.products {
        if product != "desktop" && product != "vectorizer_extension" {
            return Err(format!(
                "INVALID_REQUEST: Unsupported product entitlement '{product}'."
            ));
        }
    }

    if let Some(email) = payload.customer_email.as_deref().map(str::trim) {
        if !email.is_empty() && (!email.contains('@') || !email.contains('.')) {
            return Err("INVALID_REQUEST: 'customer_email' must be a valid email address.".to_string());
        }
    }

    match payload.license_type.as_str() {
        "perpetual" => {
            if payload.billing_interval != "lifetime" {
                return Err(
                    "INVALID_REQUEST: Perpetual licenses must use billing_interval 'lifetime'."
                        .to_string(),
                );
            }
            if payload.expires_at.is_some() {
                return Err(
                    "INVALID_REQUEST: Perpetual licenses cannot have an expires_at timestamp."
                        .to_string(),
                );
            }
        }
        "subscription" => {
            if payload.billing_interval != "monthly" && payload.billing_interval != "yearly" {
                return Err(
                    "INVALID_REQUEST: Subscription licenses must use billing_interval 'monthly' or 'yearly'."
                        .to_string(),
                );
            }
            let start_str = payload.current_period_start.as_deref().ok_or_else(|| {
                "INVALID_REQUEST: Subscription licenses require 'current_period_start'.".to_string()
            })?;
            let end_str = payload.current_period_end.as_deref().ok_or_else(|| {
                "INVALID_REQUEST: Subscription licenses require 'current_period_end'.".to_string()
            })?;
            let start_dt = DateTime::parse_from_rfc3339(start_str).map_err(|_| {
                "INVALID_REQUEST: 'current_period_start' must be a valid ISO-8601 timestamp."
                    .to_string()
            })?;
            let end_dt = DateTime::parse_from_rfc3339(end_str).map_err(|_| {
                "INVALID_REQUEST: 'current_period_end' must be a valid ISO-8601 timestamp."
                    .to_string()
            })?;
            if end_dt <= start_dt {
                return Err(
                    "INVALID_REQUEST: 'current_period_end' must be after 'current_period_start'."
                        .to_string(),
                );
            }
        }
        other => {
            return Err(format!(
                "INVALID_REQUEST: Unsupported license_type '{other}'."
            ));
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
struct ApiErrorEnvelope {
    error: Option<ApiErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorDetail {
    code: Option<String>,
    message: Option<String>,
    details: Option<serde_json::Value>,
}

pub struct AdminApiClient {
    http: reqwest::Client,
}

impl fmt::Debug for AdminApiClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdminApiClient")
            .field("tls", &"rustls-tls")
            .finish()
    }
}

impl AdminApiClient {
    pub fn new() -> Result<Self, String> {
        Self::with_timeout(Duration::from_secs(15))
    }

    pub fn with_timeout(timeout: Duration) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(Policy::none())
            .user_agent("StockStudioPro-LicenseManager/0.1.0")
            .build()
            .map_err(|e| format!("Failed to construct HTTP client: {e}"))?;
        Ok(Self { http })
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: Url,
        api_key: &str,
    ) -> Result<T, String> {
        let resp = self
            .http
            .get(url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .send()
            .await
            .map_err(|e| format!("NETWORK_ERROR: Unable to reach Admin API ({e})"))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| format!("NETWORK_ERROR: Failed reading response body ({e})"))?;

        if !status.is_success() {
            if let Ok(parsed) = serde_json::from_str::<ApiErrorEnvelope>(&body_text) {
                if let Some(err) = parsed.error {
                    let code = err.code.unwrap_or_else(|| format!("HTTP_{}", status.as_u16()));
                    let msg = err.message.unwrap_or_else(|| "Admin API request failed.".to_string());
                    return Err(format!("{code}: {msg}"));
                }
            }
            return Err(format!(
                "HTTP_{}: Admin API returned status {}.",
                status.as_u16(),
                status.as_u16()
            ));
        }

        serde_json::from_str::<T>(&body_text)
            .map_err(|e| format!("PARSE_ERROR: Unexpected Admin API response schema ({e})"))
    }

    pub async fn get_me(&self, base_url: &str, api_key: &str) -> Result<AdminMeResponse, String> {
        let url = Url::parse(&format!("{}/v1/admin/me", base_url.trim_end_matches('/')))
            .map_err(|e| format!("INVALID_URL: {e}"))?;
        self.get_json(url, api_key).await
    }

    pub async fn get_stats(
        &self,
        base_url: &str,
        api_key: &str,
    ) -> Result<AdminStatsResponse, String> {
        let url = Url::parse(&format!("{}/v1/admin/stats", base_url.trim_end_matches('/')))
            .map_err(|e| format!("INVALID_URL: {e}"))?;
        self.get_json(url, api_key).await
    }

    pub async fn list_licenses(
        &self,
        base_url: &str,
        api_key: &str,
        params: &ListLicensesParams,
    ) -> Result<AdminLicensesResponse, String> {
        let mut url = Url::parse(&format!(
            "{}/v1/admin/licenses",
            base_url.trim_end_matches('/')
        ))
        .map_err(|e| format!("INVALID_URL: {e}"))?;

        {
            let mut qp = url.query_pairs_mut();
            if let Some(limit) = params.limit {
                qp.append_pair("limit", &limit.clamp(1, 100).to_string());
            }
            if let Some(cursor) = params.cursor.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("cursor", cursor.trim());
            }
            if let Some(sort) = params.sort.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("sort", sort.trim());
            }
            if let Some(status) = params.status.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("status", status.trim());
            }
            if let Some(lt) = params.license_type.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("license_type", lt.trim());
            }
            if let Some(bi) = params
                .billing_interval
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                qp.append_pair("billing_interval", bi.trim());
            }
            if let Some(pc) = params.plan_code.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("plan_code", pc.trim());
            }
            if let Some(prod) = params.product.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("product", prod.trim());
            }
            if let Some(q) = params.q.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("q", q.trim());
            }
        }

        self.get_json(url, api_key).await
    }

    pub async fn get_license_detail(
        &self,
        base_url: &str,
        api_key: &str,
        license_id: &str,
    ) -> Result<AdminLicenseDetailResponse, String> {
        let trimmed = license_id.trim();
        if trimmed.len() < 4
            || trimmed.len() > 64
            || !trimmed
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("INVALID_REQUEST: Invalid license_id format.".to_string());
        }

        let url = Url::parse(&format!(
            "{}/v1/admin/licenses/{}",
            base_url.trim_end_matches('/'),
            trimmed
        ))
        .map_err(|e| format!("INVALID_URL: {e}"))?;
        self.get_json(url, api_key).await
    }

    pub async fn list_events(
        &self,
        base_url: &str,
        api_key: &str,
        params: &ListEventsParams,
    ) -> Result<AdminEventsResponse, String> {
        let mut url = Url::parse(&format!("{}/v1/admin/events", base_url.trim_end_matches('/')))
            .map_err(|e| format!("INVALID_URL: {e}"))?;

        {
            let mut qp = url.query_pairs_mut();
            if let Some(limit) = params.limit {
                qp.append_pair("limit", &limit.clamp(1, 100).to_string());
            }
            if let Some(cursor) = params.cursor.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("cursor", cursor.trim());
            }
            if let Some(lid) = params.license_id.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("license_id", lid.trim());
            }
            if let Some(et) = params.event_type.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("event_type", et.trim());
            }
            if let Some(at) = params.actor_type.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("actor_type", at.trim());
            }
            if let Some(from) = params.from.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("from", from.trim());
            }
            if let Some(to) = params.to.as_deref().filter(|s| !s.trim().is_empty()) {
                qp.append_pair("to", to.trim());
            }
        }

        self.get_json(url, api_key).await
    }

    /// Sends `POST /v1/admin/licenses` exactly ONCE with an `Idempotency-Key`.
    /// Never retries automatically on timeout or dropped connections; instead
    /// returns `CreateLicenseOutcome::Uncertain` so the operator inspects the
    /// registry/audit log before taking further action.
    pub async fn create_license(
        &self,
        base_url: &str,
        api_key: &str,
        idempotency_key: &str,
        payload: &CreateLicensePayload,
    ) -> CreateLicenseOutcome {
        if let Err(validation_err) = validate_create_license_payload(payload) {
            return CreateLicenseOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: validation_err,
            };
        }

        let url = match Url::parse(&format!(
            "{}/v1/admin/licenses",
            base_url.trim_end_matches('/')
        )) {
            Ok(u) => u,
            Err(e) => {
                return CreateLicenseOutcome::Rejected {
                    status: 400,
                    code: "INVALID_URL".to_string(),
                    message: format!("Invalid API URL: {e}"),
                }
            }
        };

        let send_result = self
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .header("Idempotency-Key", idempotency_key.trim())
            .json(payload)
            .send()
            .await;

        let resp = match send_result {
            Ok(r) => r,
            Err(e) => {
                let kind = if e.is_timeout() {
                    "Request timed out waiting for Admin API response"
                } else {
                    "Network connection interrupted during license issuance"
                };
                return CreateLicenseOutcome::Uncertain {
                    reason: format!(
                        "{kind}. Do NOT blindly re-submit: check License Registry and Events & Activity first to confirm whether the license was created."
                    ),
                };
            }
        };

        let status = resp.status();
        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(_) => {
                return CreateLicenseOutcome::Uncertain {
                    reason: format!(
                        "Connection dropped while reading HTTP {} response body. Check License Registry and Events & Activity before retrying.",
                        status.as_u16()
                    ),
                };
            }
        };

        if status.as_u16() == 409 {
            let parsed = serde_json::from_str::<ApiErrorEnvelope>(&body_text).ok();
            let err_detail = parsed.and_then(|e| e.error);
            let license_id = err_detail
                .as_ref()
                .and_then(|d| d.details.as_ref())
                .and_then(|v| v.get("license_id"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let key_prefix = err_detail
                .as_ref()
                .and_then(|d| d.details.as_ref())
                .and_then(|v| v.get("key_prefix"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let message = err_detail
                .and_then(|d| d.message)
                .unwrap_or_else(|| {
                    "A license was already created for this Idempotency-Key.".to_string()
                });
            return CreateLicenseOutcome::DuplicateConflict {
                license_id,
                key_prefix,
                message,
            };
        }

        if !status.is_success() {
            if let Ok(parsed) = serde_json::from_str::<ApiErrorEnvelope>(&body_text) {
                if let Some(err) = parsed.error {
                    return CreateLicenseOutcome::Rejected {
                        status: status.as_u16(),
                        code: err.code.unwrap_or_else(|| format!("HTTP_{}", status.as_u16())),
                        message: err
                            .message
                            .unwrap_or_else(|| "License issuance rejected by Admin API.".to_string()),
                    };
                }
            }
            return CreateLicenseOutcome::Rejected {
                status: status.as_u16(),
                code: format!("HTTP_{}", status.as_u16()),
                message: format!("Admin API returned HTTP {}.", status.as_u16()),
            };
        }

        match serde_json::from_str::<RawCreateLicenseResponse>(&body_text) {
            Ok(parsed) if parsed.ok && !parsed.license_key.trim().is_empty() => {
                CreateLicenseOutcome::Created {
                    license_key: Zeroizing::new(parsed.license_key),
                    license: Box::new(parsed.license),
                    request_id: parsed.request_id,
                    server_time: parsed.server_time,
                }
            }
            _ => CreateLicenseOutcome::Uncertain {
                reason: "Admin API returned 2xx but response payload was malformed. Check License Registry to verify whether the license was created.".to_string(),
            },
        }
    }

    /// Sends `POST /v1/admin/licenses/:license_id/revoke` once. Never silently retries on timeout.
    pub async fn revoke_license(
        &self,
        base_url: &str,
        api_key: &str,
        license_id: &str,
        confirm_key_prefix: &str,
        reason: &str,
    ) -> LifecycleMutationOutcome {
        if let Err(err) = validate_id_token(license_id, "license_id") {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: err,
            };
        }
        if confirm_key_prefix.trim().is_empty() {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "Confirmation key prefix is required.".to_string(),
            };
        }
        if reason.trim().is_empty() {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "A non-empty revocation reason is required.".to_string(),
            };
        }

        let url = match Url::parse(&format!(
            "{}/v1/admin/licenses/{}/revoke",
            base_url.trim_end_matches('/'),
            license_id.trim()
        )) {
            Ok(u) => u,
            Err(e) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_URL".to_string(),
                    message: format!("Invalid API URL: {e}"),
                }
            }
        };

        let body = serde_json::json!({
            "confirm_key_prefix": confirm_key_prefix.trim(),
            "reason": reason.trim(),
        });

        let send_result = self
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .json(&body)
            .send()
            .await;

        let resp = match send_result {
            Ok(r) => r,
            Err(e) => {
                let kind = if e.is_timeout() {
                    "Request timed out during license revocation"
                } else {
                    "Network connection interrupted during license revocation"
                };
                return LifecycleMutationOutcome::Uncertain {
                    reason: format!(
                        "{kind}. Do NOT blindly re-submit: refresh License Details and Events & Activity to confirm current status."
                    ),
                };
            }
        };

        let status = resp.status();
        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: format!(
                        "Connection dropped while reading HTTP {} revocation response. Refresh License Details before retrying.",
                        status.as_u16()
                    ),
                };
            }
        };

        if !status.is_success() {
            return parse_rejected_lifecycle_error(status.as_u16(), &body_text);
        }

        match serde_json::from_str::<serde_json::Value>(&body_text) {
            Ok(val) if val.get("ok").and_then(|v| v.as_bool()) == Some(true) => {
                let already = val
                    .get("already_revoked")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                LifecycleMutationOutcome::Completed {
                    already_applied: already,
                    message: if already {
                        Some("License was already revoked (idempotent confirmation).".to_string())
                    } else {
                        Some("License revoked permanently.".to_string())
                    },
                }
            }
            _ => LifecycleMutationOutcome::Uncertain {
                reason: "Admin API returned 2xx with unexpected revocation payload. Refresh License Details to verify.".to_string(),
            },
        }
    }

    /// Sends `DELETE /v1/admin/licenses/:license_id/devices/:activation_id` once. Never silently retries on timeout.
    pub async fn force_deactivate_device(
        &self,
        base_url: &str,
        api_key: &str,
        license_id: &str,
        activation_id: &str,
        confirm_key_prefix: &str,
        reason: &str,
    ) -> LifecycleMutationOutcome {
        if let Err(err) = validate_id_token(license_id, "license_id") {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: err,
            };
        }
        if let Err(err) = validate_id_token(activation_id, "activation_id") {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: err,
            };
        }
        if confirm_key_prefix.trim().is_empty() {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "Confirmation key prefix is required.".to_string(),
            };
        }
        if reason.trim().is_empty() {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "A non-empty deactivation reason is required.".to_string(),
            };
        }

        let url = match Url::parse(&format!(
            "{}/v1/admin/licenses/{}/devices/{}",
            base_url.trim_end_matches('/'),
            license_id.trim(),
            activation_id.trim()
        )) {
            Ok(u) => u,
            Err(e) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_URL".to_string(),
                    message: format!("Invalid API URL: {e}"),
                }
            }
        };

        let body = serde_json::json!({
            "confirm_key_prefix": confirm_key_prefix.trim(),
            "reason": reason.trim(),
        });

        let send_result = self
            .http
            .delete(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .json(&body)
            .send()
            .await;

        let resp = match send_result {
            Ok(r) => r,
            Err(e) => {
                let kind = if e.is_timeout() {
                    "Request timed out during device deactivation"
                } else {
                    "Network connection interrupted during device deactivation"
                };
                return LifecycleMutationOutcome::Uncertain {
                    reason: format!(
                        "{kind}. Do NOT blindly re-submit: refresh License Details to inspect device activation state."
                    ),
                };
            }
        };

        let status = resp.status();
        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: format!(
                        "Connection dropped while reading HTTP {} deactivation response. Refresh License Details before retrying.",
                        status.as_u16()
                    ),
                };
            }
        };

        if !status.is_success() {
            return parse_rejected_lifecycle_error(status.as_u16(), &body_text);
        }

        match serde_json::from_str::<serde_json::Value>(&body_text) {
            Ok(val) if val.get("ok").and_then(|v| v.as_bool()) == Some(true) => {
                let already = val
                    .get("already_deactivated")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                LifecycleMutationOutcome::Completed {
                    already_applied: already,
                    message: if already {
                        Some("Device activation was already deactivated (idempotent confirmation).".to_string())
                    } else {
                        Some("Device activation force-deactivated and slot released.".to_string())
                    },
                }
            }
            _ => LifecycleMutationOutcome::Uncertain {
                reason: "Admin API returned 2xx with unexpected deactivation payload. Refresh License Details to verify.".to_string(),
            },
        }
    }

    /// Sends `PATCH /v1/admin/licenses/:license_id` once to update device limit, customer info, notes, or products.
    pub async fn update_license(
        &self,
        base_url: &str,
        api_key: &str,
        license_id: &str,
        payload: &UpdateLicensePayload,
    ) -> LifecycleMutationOutcome {
        if let Err(err) = validate_id_token(license_id, "license_id") {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: err,
            };
        }
        if let Some(limit) = payload.device_limit {
            if !(1..=100).contains(&limit) {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_REQUEST".to_string(),
                    message: "'device_limit' must be an integer between 1 and 100.".to_string(),
                };
            }
        }
        if let Some(ref ent) = payload.entitlements {
            if ent.products.is_empty()
                || ent
                    .products
                    .iter()
                    .any(|p| p != "desktop" && p != "vectorizer_extension")
            {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_REQUEST".to_string(),
                    message: "Entitlements must contain at least one valid product ('desktop' or 'vectorizer_extension').".to_string(),
                };
            }
        }

        let url = match Url::parse(&format!(
            "{}/v1/admin/licenses/{}",
            base_url.trim_end_matches('/'),
            license_id.trim()
        )) {
            Ok(u) => u,
            Err(e) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_URL".to_string(),
                    message: format!("Invalid API URL: {e}"),
                }
            }
        };

        let resp = match self
            .http
            .patch(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .json(payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: format!(
                        "Network interrupted while updating license ({}). Refresh License Details before retrying.",
                        if e.is_timeout() { "timeout" } else { "connection error" }
                    ),
                };
            }
        };

        let status = resp.status();
        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: "Connection dropped while reading update response. Refresh License Details.".to_string(),
                };
            }
        };
        if !status.is_success() {
            return parse_rejected_lifecycle_error(status.as_u16(), &body_text);
        }
        LifecycleMutationOutcome::Completed {
            already_applied: false,
            message: Some("License metadata and entitlements updated.".to_string()),
        }
    }

    /// Sends `POST /v1/admin/licenses/:license_id/suspend` once.
    pub async fn suspend_license(
        &self,
        base_url: &str,
        api_key: &str,
        license_id: &str,
        reason: &str,
    ) -> LifecycleMutationOutcome {
        if let Err(err) = validate_id_token(license_id, "license_id") {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: err,
            };
        }
        if reason.trim().is_empty() {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "A non-empty suspension reason is required.".to_string(),
            };
        }
        let url = match Url::parse(&format!(
            "{}/v1/admin/licenses/{}/suspend",
            base_url.trim_end_matches('/'),
            license_id.trim()
        )) {
            Ok(u) => u,
            Err(e) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_URL".to_string(),
                    message: format!("Invalid API URL: {e}"),
                }
            }
        };

        let resp = match self
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .json(&serde_json::json!({ "reason": reason.trim() }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: "Network interrupted during license suspension. Refresh License Details before retrying.".to_string(),
                };
            }
        };

        let status = resp.status();
        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: "Connection dropped while reading suspend response.".to_string(),
                };
            }
        };
        if !status.is_success() {
            return parse_rejected_lifecycle_error(status.as_u16(), &body_text);
        }
        LifecycleMutationOutcome::Completed {
            already_applied: false,
            message: Some("License suspended.".to_string()),
        }
    }

    /// Sends `POST /v1/admin/licenses/:license_id/reinstate` once.
    pub async fn reinstate_license(
        &self,
        base_url: &str,
        api_key: &str,
        license_id: &str,
        reason: &str,
    ) -> LifecycleMutationOutcome {
        if let Err(err) = validate_id_token(license_id, "license_id") {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: err,
            };
        }
        if reason.trim().is_empty() {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "A non-empty reinstatement reason is required.".to_string(),
            };
        }
        let url = match Url::parse(&format!(
            "{}/v1/admin/licenses/{}/reinstate",
            base_url.trim_end_matches('/'),
            license_id.trim()
        )) {
            Ok(u) => u,
            Err(e) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_URL".to_string(),
                    message: format!("Invalid API URL: {e}"),
                }
            }
        };

        let resp = match self
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .json(&serde_json::json!({ "reason": reason.trim() }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: "Network interrupted during license reinstatement. Refresh License Details before retrying.".to_string(),
                };
            }
        };

        let status = resp.status();
        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: "Connection dropped while reading reinstate response.".to_string(),
                };
            }
        };
        if !status.is_success() {
            return parse_rejected_lifecycle_error(status.as_u16(), &body_text);
        }
        LifecycleMutationOutcome::Completed {
            already_applied: false,
            message: Some("License reinstated.".to_string()),
        }
    }

    /// Sends `POST /v1/admin/licenses/:license_id/renew` once for subscription licenses.
    pub async fn renew_subscription(
        &self,
        base_url: &str,
        api_key: &str,
        license_id: &str,
        payload: &RenewSubscriptionPayload,
    ) -> LifecycleMutationOutcome {
        if let Err(err) = validate_id_token(license_id, "license_id") {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: err,
            };
        }
        if payload.external_payment_id.trim().is_empty() {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "'external_payment_id' is required for subscription renewal.".to_string(),
            };
        }
        let s = match DateTime::parse_from_rfc3339(payload.new_period_start.trim()) {
            Ok(dt) => dt,
            Err(_) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_REQUEST".to_string(),
                    message: "'new_period_start' must be a valid ISO-8601 timestamp.".to_string(),
                }
            }
        };
        let e = match DateTime::parse_from_rfc3339(payload.new_period_end.trim()) {
            Ok(dt) => dt,
            Err(_) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_REQUEST".to_string(),
                    message: "'new_period_end' must be a valid ISO-8601 timestamp.".to_string(),
                }
            }
        };
        if e <= s {
            return LifecycleMutationOutcome::Rejected {
                status: 400,
                code: "INVALID_REQUEST".to_string(),
                message: "'new_period_end' must be after 'new_period_start'.".to_string(),
            };
        }

        let url = match Url::parse(&format!(
            "{}/v1/admin/licenses/{}/renew",
            base_url.trim_end_matches('/'),
            license_id.trim()
        )) {
            Ok(u) => u,
            Err(err) => {
                return LifecycleMutationOutcome::Rejected {
                    status: 400,
                    code: "INVALID_URL".to_string(),
                    message: format!("Invalid API URL: {err}"),
                }
            }
        };

        let resp = match self
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", api_key.trim()))
            .json(payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: "Network interrupted during subscription renewal. Refresh License Details before retrying.".to_string(),
                };
            }
        };

        let status = resp.status();
        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(_) => {
                return LifecycleMutationOutcome::Uncertain {
                    reason: "Connection dropped while reading renewal response.".to_string(),
                };
            }
        };
        if !status.is_success() {
            return parse_rejected_lifecycle_error(status.as_u16(), &body_text);
        }
        let replay = serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|v| v.get("idempotent_replay").and_then(|b| b.as_bool()))
            .unwrap_or(false);
        LifecycleMutationOutcome::Completed {
            already_applied: replay,
            message: Some(if replay {
                "Payment event was already applied (idempotent replay).".to_string()
            } else {
                "Subscription period renewed.".to_string()
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateLicensePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entitlements: Option<CreateLicenseEntitlementsInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenewSubscriptionPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billing_provider: Option<String>,
    pub external_payment_id: String,
    pub new_period_start: String,
    pub new_period_end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug)]
pub enum LifecycleMutationOutcome {
    Completed {
        already_applied: bool,
        message: Option<String>,
    },
    Uncertain {
        reason: String,
    },
    Rejected {
        status: u16,
        code: String,
        message: String,
    },
}

pub fn validate_id_token(value: &str, field_name: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.len() < 4
        || trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!("INVALID_REQUEST: Invalid '{field_name}' format."));
    }
    Ok(())
}

fn parse_rejected_lifecycle_error(status: u16, body_text: &str) -> LifecycleMutationOutcome {
    if let Ok(parsed) = serde_json::from_str::<ApiErrorEnvelope>(body_text) {
        if let Some(err) = parsed.error {
            return LifecycleMutationOutcome::Rejected {
                status,
                code: err.code.unwrap_or_else(|| format!("HTTP_{status}")),
                message: err
                    .message
                    .unwrap_or_else(|| "Admin lifecycle operation rejected.".to_string()),
            };
        }
    }
    LifecycleMutationOutcome::Rejected {
        status,
        code: format!("HTTP_{status}"),
        message: format!("Admin API returned HTTP {status}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn spawn_mock_server(
        status_line: &'static str,
        response_body: String,
        delay_ms: u64,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = socket.read(&mut buf).await.unwrap();
            let req_text = String::from_utf8_lossy(&buf[..n]).to_string();
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            let resp = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            let _ = socket.write_all(resp.as_bytes()).await;
            req_text
        });
        (format!("http://{addr}"), handle)
    }

    fn lifetime_payload() -> CreateLicensePayload {
        CreateLicensePayload {
            plan_code: "lifetime".to_string(),
            plan_name: "Lifetime Pro".to_string(),
            license_type: "perpetual".to_string(),
            billing_interval: "lifetime".to_string(),
            device_limit: 2,
            current_period_start: None,
            current_period_end: None,
            expires_at: None,
            customer_email: Some("buyer@example.com".to_string()),
            customer_name: Some("Buyer".to_string()),
            external_customer_id: None,
            external_order_id: None,
            notes: Some("LM-04 test".to_string()),
            entitlements: CreateLicenseEntitlementsInput {
                products: vec!["desktop".to_string(), "vectorizer_extension".to_string()],
            },
        }
    }

    #[test]
    fn validates_device_limits_entitlements_and_subscription_dates() {
        let mut bad_limit = lifetime_payload();
        bad_limit.device_limit = 0;
        assert!(validate_create_license_payload(&bad_limit).is_err());

        bad_limit.device_limit = 101;
        assert!(validate_create_license_payload(&bad_limit).is_err());

        let mut no_products = lifetime_payload();
        no_products.entitlements.products.clear();
        assert!(validate_create_license_payload(&no_products).is_err());

        let monthly = CreateLicensePayload {
            plan_code: "pro_monthly".to_string(),
            plan_name: "Pro Monthly".to_string(),
            license_type: "subscription".to_string(),
            billing_interval: "monthly".to_string(),
            device_limit: 1,
            current_period_start: Some("2026-11-23T00:00:00Z".to_string()),
            current_period_end: Some("2026-12-23T00:00:00Z".to_string()),
            expires_at: Some("2026-12-23T00:00:00Z".to_string()),
            customer_email: Some("sub@example.com".to_string()),
            customer_name: None,
            external_customer_id: None,
            external_order_id: None,
            notes: None,
            entitlements: CreateLicenseEntitlementsInput {
                products: vec!["desktop".to_string()],
            },
        };
        assert!(validate_create_license_payload(&monthly).is_ok());

        let yearly = CreateLicensePayload {
            plan_code: "pro_yearly".to_string(),
            plan_name: "Pro Yearly".to_string(),
            billing_interval: "yearly".to_string(),
            current_period_end: Some("2027-11-23T00:00:00Z".to_string()),
            expires_at: Some("2027-11-23T00:00:00Z".to_string()),
            ..monthly
        };
        assert!(validate_create_license_payload(&yearly).is_ok());
    }

    #[tokio::test]
    async fn attaches_bearer_in_rust_and_strips_sensitive_fields() {
        let body = r#"{
            "ok": true,
            "items": [{
                "license_id": "lic_01TEST1234",
                "key_prefix": "SSPRO-ABCD",
                "key_hash": "SHOULD_BE_STRIPPED",
                "license_key": "SSPRO-ABCD-1111-2222-3333",
                "plan_code": "lifetime",
                "plan_name": "Lifetime Pro",
                "license_type": "perpetual",
                "billing_interval": "lifetime",
                "status": "active",
                "lifetime": true,
                "expires_at": null,
                "device_limit": 2,
                "devices_used": 0,
                "entitlements": { "products": ["desktop", "vectorizer_extension"], "features": [] },
                "customer_email": "owner@example.com",
                "created_at": "2026-11-23T14:00:00Z",
                "updated_at": "2026-11-23T14:00:00Z"
            }],
            "pagination": { "limit": 25, "sort": "created_desc", "has_more": false, "next_cursor": null },
            "server_time": "2026-11-23T15:00:00Z"
        }"#
        .to_string();

        let (base_url, handle) = spawn_mock_server("200 OK", body, 0).await;
        let client = AdminApiClient::new().unwrap();
        let res = client
            .list_licenses(&base_url, "ssadm_01MOCKKEY", &ListLicensesParams::default())
            .await
            .unwrap();

        let captured_req = handle.await.unwrap();
        assert!(captured_req.to_lowercase().contains("authorization: bearer ssadm_01mockkey"));

        let serialized = serde_json::to_string(&res).unwrap();
        assert!(!serialized.contains("SHOULD_BE_STRIPPED"));
        assert!(!serialized.contains("SSPRO-ABCD-1111-2222-3333"));
        assert!(!serialized.contains("key_hash"));
        assert!(!serialized.contains("license_key"));
        assert_eq!(res.items[0].license_id, "lic_01TEST1234");
    }

    #[tokio::test]
    async fn create_license_sends_idempotency_key_and_redacts_debug() {
        let body = r#"{
            "ok": true,
            "license_key": "SSPRO-NEW1-AAAA-BBBB-CCCC",
            "license": {
                "license_id": "lic_01CREATED1",
                "key_prefix": "SSPRO-NEW1",
                "plan_code": "lifetime",
                "plan_name": "Lifetime Pro",
                "license_type": "perpetual",
                "billing_interval": "lifetime",
                "status": "pending_activation",
                "lifetime": true,
                "expires_at": null,
                "device_limit": 2,
                "devices_used": 0,
                "entitlements": { "products": ["desktop", "vectorizer_extension"], "features": [] },
                "customer_email": "buyer@example.com",
                "created_at": "2026-11-23T16:00:00Z"
            },
            "request_id": "req_01TEST",
            "server_time": "2026-11-23T16:00:00Z"
        }"#
        .to_string();

        let (base_url, handle) = spawn_mock_server("201 Created", body, 0).await;
        let client = AdminApiClient::new().unwrap();
        let outcome = client
            .create_license(&base_url, "ssadm_01ADMIN", "idem-12345", &lifetime_payload())
            .await;

        let req_text = handle.await.unwrap();
        assert!(req_text.to_lowercase().contains("idempotency-key: idem-12345"));
        let dbg = format!("{outcome:?}");
        assert!(!dbg.contains("SSPRO-NEW1-AAAA-BBBB-CCCC"));
        assert!(dbg.contains("[REDACTED]"));

        match outcome {
            CreateLicenseOutcome::Created {
                license_key,
                license,
                ..
            } => {
                assert_eq!(*license_key, "SSPRO-NEW1-AAAA-BBBB-CCCC");
                assert_eq!(license.license_id, "lic_01CREATED1");
            }
            other => panic!("Expected Created, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn handles_409_duplicate_and_403_unauthorized_and_timeout_uncertain() {
        // 409 Conflict
        let conflict_body = r#"{
            "ok": false,
            "error": {
                "code": "IDEMPOTENCY_CONFLICT",
                "message": "Already issued",
                "details": { "license_id": "lic_01EXISTING", "key_prefix": "SSPRO-EXST" }
            }
        }"#
        .to_string();
        let (url_409, h1) = spawn_mock_server("409 Conflict", conflict_body, 0).await;
        let client = AdminApiClient::new().unwrap();
        let res_409 = client
            .create_license(&url_409, "ssadm_01ADMIN", "idem-dup", &lifetime_payload())
            .await;
        let _ = h1.await;
        assert!(matches!(
            res_409,
            CreateLicenseOutcome::DuplicateConflict {
                license_id: Some(ref id),
                ..
            } if id == "lic_01EXISTING"
        ));

        // 403 Forbidden
        let forbid_body = r#"{
            "ok": false,
            "error": { "code": "FORBIDDEN", "message": "Role read_only cannot issue licenses" }
        }"#
        .to_string();
        let (url_403, h2) = spawn_mock_server("403 Forbidden", forbid_body, 0).await;
        let res_403 = client
            .create_license(&url_403, "ssadm_01READONLY", "idem-403", &lifetime_payload())
            .await;
        let _ = h2.await;
        assert!(matches!(
            res_403,
            CreateLicenseOutcome::Rejected { status: 403, .. }
        ));

        // Timeout -> Uncertain (never retried!)
        let (url_timeout, _h3) = spawn_mock_server("201 Created", "{}".to_string(), 300).await;
        let fast_client = AdminApiClient::with_timeout(Duration::from_millis(80)).unwrap();
        let res_timeout = fast_client
            .create_license(&url_timeout, "ssadm_01ADMIN", "idem-slow", &lifetime_payload())
            .await;
        assert!(matches!(res_timeout, CreateLicenseOutcome::Uncertain { .. }));
    }

    #[tokio::test]
    async fn rejects_path_traversal_in_license_id() {
        let client = AdminApiClient::new().unwrap();
        let err = client
            .get_license_detail("https://example.com", "ssadm_01TEST", "../admin/me")
            .await
            .unwrap_err();
        assert!(err.contains("INVALID_REQUEST"));
    }

    #[tokio::test]
    async fn revoke_license_handles_success_idempotent_unauthorized_invalid_and_timeout() {
        let client = AdminApiClient::new().unwrap();

        // Empty reason / prefix rejected locally before HTTP
        assert!(matches!(
            client
                .revoke_license("https://example.com", "ssadm_01", "lic_01TEST", "", "valid")
                .await,
            LifecycleMutationOutcome::Rejected { status: 400, .. }
        ));
        assert!(matches!(
            client
                .revoke_license("https://example.com", "ssadm_01", "lic_01TEST", "SSPRO-AAAA", "   ")
                .await,
            LifecycleMutationOutcome::Rejected { status: 400, .. }
        ));

        // 200 OK revocation
        let ok_body = r#"{"ok":true,"already_revoked":false,"server_time":"2026-11-23T16:00:00Z"}"#.to_string();
        let (url_ok, h_ok) = spawn_mock_server("200 OK", ok_body, 0).await;
        let res_ok = client
            .revoke_license(&url_ok, "ssadm_01ADMIN", "lic_01REV", "SSPRO-REV1", "Chargeback")
            .await;
        let req_ok = h_ok.await.unwrap();
        assert!(req_ok.contains("/v1/admin/licenses/lic_01REV/revoke"));
        assert!(req_ok.contains("SSPRO-REV1"));
        assert!(matches!(
            res_ok,
            LifecycleMutationOutcome::Completed {
                already_applied: false,
                ..
            }
        ));

        // 200 OK already_revoked idempotency
        let dup_body = r#"{"ok":true,"already_revoked":true,"server_time":"2026-11-23T16:00:00Z"}"#.to_string();
        let (url_dup, h_dup) = spawn_mock_server("200 OK", dup_body, 0).await;
        let res_dup = client
            .revoke_license(&url_dup, "ssadm_01ADMIN", "lic_01REV", "SSPRO-REV1", "Retry")
            .await;
        let _ = h_dup.await;
        assert!(matches!(
            res_dup,
            LifecycleMutationOutcome::Completed {
                already_applied: true,
                ..
            }
        ));

        // 403 Unauthorized
        let err_403 = r#"{"ok":false,"error":{"code":"FORBIDDEN","message":"Missing licenses:revoke"}}"#.to_string();
        let (url_403, h_403) = spawn_mock_server("403 Forbidden", err_403, 0).await;
        let res_403 = client
            .revoke_license(&url_403, "ssadm_01RO", "lic_01REV", "SSPRO-REV1", "Attempt")
            .await;
        let _ = h_403.await;
        assert!(matches!(
            res_403,
            LifecycleMutationOutcome::Rejected { status: 403, .. }
        ));

        // Timeout -> Uncertain
        let (url_slow, _h_slow) = spawn_mock_server("200 OK", "{}".to_string(), 300).await;
        let fast = AdminApiClient::with_timeout(Duration::from_millis(80)).unwrap();
        let res_slow = fast
            .revoke_license(&url_slow, "ssadm_01ADMIN", "lic_01REV", "SSPRO-REV1", "Timeout")
            .await;
        assert!(matches!(res_slow, LifecycleMutationOutcome::Uncertain { .. }));
    }

    #[tokio::test]
    async fn force_deactivate_handles_success_repeated_404_invalid_id_and_timeout() {
        let client = AdminApiClient::new().unwrap();

        // Invalid activation ID rejected locally
        assert!(matches!(
            client
                .force_deactivate_device(
                    "https://example.com",
                    "ssadm_01",
                    "lic_01TEST",
                    "../bad",
                    "SSPRO-AAAA",
                    "Lost laptop"
                )
                .await,
            LifecycleMutationOutcome::Rejected { status: 400, .. }
        ));

        // 200 OK deactivation
        let ok_body = r#"{"ok":true,"already_deactivated":false,"devices_used":0}"#.to_string();
        let (url_ok, h_ok) = spawn_mock_server("200 OK", ok_body, 0).await;
        let res_ok = client
            .force_deactivate_device(
                &url_ok,
                "ssadm_01ADMIN",
                "lic_01DEV",
                "act_01DEV1",
                "SSPRO-DEV1",
                "Lost laptop",
            )
            .await;
        let req_ok = h_ok.await.unwrap();
        assert!(req_ok.starts_with("DELETE /v1/admin/licenses/lic_01DEV/devices/act_01DEV1"));
        assert!(matches!(
            res_ok,
            LifecycleMutationOutcome::Completed {
                already_applied: false,
                ..
            }
        ));

        // 200 OK repeated deactivation
        let rep_body = r#"{"ok":true,"already_deactivated":true,"devices_used":0}"#.to_string();
        let (url_rep, h_rep) = spawn_mock_server("200 OK", rep_body, 0).await;
        let res_rep = client
            .force_deactivate_device(
                &url_rep,
                "ssadm_01ADMIN",
                "lic_01DEV",
                "act_01DEV1",
                "SSPRO-DEV1",
                "Lost laptop",
            )
            .await;
        let _ = h_rep.await;
        assert!(matches!(
            res_rep,
            LifecycleMutationOutcome::Completed {
                already_applied: true,
                ..
            }
        ));

        // 404 Device does not belong to license
        let nf_body = r#"{"ok":false,"error":{"code":"ACTIVATION_NOT_FOUND","message":"Not on license"}}"#.to_string();
        let (url_404, h_404) = spawn_mock_server("404 Not Found", nf_body, 0).await;
        let res_404 = client
            .force_deactivate_device(
                &url_404,
                "ssadm_01ADMIN",
                "lic_01DEV",
                "act_01OTHER",
                "SSPRO-DEV1",
                "Wrong device",
            )
            .await;
        let _ = h_404.await;
        assert!(matches!(
            res_404,
            LifecycleMutationOutcome::Rejected { status: 404, .. }
        ));

        // Timeout -> Uncertain
        let (url_slow, _h_slow) = spawn_mock_server("200 OK", "{}".to_string(), 300).await;
        let fast = AdminApiClient::with_timeout(Duration::from_millis(80)).unwrap();
        let res_slow = fast
            .force_deactivate_device(
                &url_slow,
                "ssadm_01ADMIN",
                "lic_01DEV",
                "act_01DEV1",
                "SSPRO-DEV1",
                "Timeout",
            )
            .await;
        assert!(matches!(res_slow, LifecycleMutationOutcome::Uncertain { .. }));
    }
}
