// =============================================================================
// StockStudio Pro License API (v0.2.0) — Type Definitions & Domain Contracts
// =============================================================================

export interface Env {
  DB: D1Database;

  // Public environment variables (from wrangler.toml [vars])
  ENVIRONMENT?: string;
  PRODUCT_ID?: string;
  ISSUER?: string;
  DEFAULT_DEVICE_LIMIT?: string;
  LEASE_TTL_DAYS?: string;
  MAX_CLOCK_SKEW_SECONDS?: string;
  LICENSE_KEY_PEPPER_VERSION?: string;
  LICENSE_SIGNING_KID?: string;

  // Server-side secrets (from Cloudflare Secrets / .dev.vars)
  LICENSE_KEY_PEPPER: string;
  ADMIN_TOKEN_PEPPER: string;
  IP_HASH_SALT: string;
  LICENSE_SIGNING_PRIVATE_KEY_JWK: string;
  LICENSE_SIGNING_PUBLIC_KEY_BASE64?: string;
  BILLING_WEBHOOK_SECRETS_JSON?: string;
}

export type ProductEntitlementId = "desktop" | "vectorizer_extension";
export const SUPPORTED_PRODUCT_ENTITLEMENTS: readonly ProductEntitlementId[] = [
  "desktop",
  "vectorizer_extension",
] as const;

export type LicenseType = "perpetual" | "subscription";
export type BillingInterval = "lifetime" | "monthly" | "yearly";
export type LicenseStatus =
  | "pending_activation"
  | "active"
  | "past_due"
  | "expired"
  | "suspended"
  | "revoked";
export type ActivationStatus = "active" | "deactivated" | "revoked" | "expired";
export type AdminRole = "super_admin" | "support_admin" | "billing_system" | "read_only";
export type PlatformType = "windows" | "macos" | "linux";

export type CanonicalBillingEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "subscription.created"
  | "subscription.renewed"
  | "subscription.canceled"
  | "payment.refunded"
  | "payment.chargeback";

export type LicenseEventType =
  | "license.issued"
  | "license.activated"
  | "license.rebound_on_reinstall"
  | "license.validated"
  | "license.validation_failed"
  | "license.device_limit_rejected"
  | "license.deactivated"
  | "license.expired"
  | "license.past_due"
  | "license.renewed"
  | "license.suspended"
  | "license.reinstated"
  | "license.revoked"
  | "license.updated";

export interface LicenseEntitlements {
  products?: ProductEntitlementId[];
  features: string[];
  max_accounts: number | null;
  updates_until: string | null;
  max_app_version: string | null;
}

export interface SignedLeasePayload {
  ver: 1;
  kid: string;
  jti: string;
  iss: string;
  aud: string;
  iat: string;
  exp: string;
  offline_grace_until: string;
  license_id: string;
  activation_id: string;
  device_id: string;
  device_fingerprint: string;
  plan_code: string;
  plan_name: string;
  license_type: LicenseType;
  billing_interval: BillingInterval;
  status: LicenseStatus;
  lifetime: boolean;
  expires_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  device_limit: number;
  devices_used: number;
  entitlements: LicenseEntitlements;
}

export interface LicenseRow {
  id: string;
  product_id: string;
  key_prefix: string;
  key_hash: string;
  key_pepper_version: number;
  plan_code: string;
  plan_name: string;
  license_type: LicenseType;
  billing_interval: BillingInterval;
  status: LicenseStatus;
  device_limit: number;
  active_devices_count: number;
  issued_at: string;
  activated_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  expires_at: string | null;
  grace_until: string | null;
  cancel_at_period_end: number;
  canceled_at: string | null;
  updates_until: string | null;
  max_app_version: string | null;
  entitlements_json: string;
  customer_email: string | null;
  customer_name: string | null;
  external_customer_id: string | null;
  external_order_id: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  notes: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivationRow {
  id: string;
  license_id: string;
  device_id: string;
  device_fingerprint: string;
  device_name_snapshot: string;
  app_version_snapshot: string;
  token_prefix: string;
  token_hash: string;
  status: ActivationStatus;
  last_lease_jti: string | null;
  last_lease_issued_at: string;
  last_lease_expires_at: string;
  activated_at: string;
  last_validated_at: string;
  last_seen_ip_hash: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  id: string;
  device_fingerprint: string;
  device_name: string;
  platform: PlatformType;
  os_version: string | null;
  arch: string | null;
  last_app_version: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
}

export interface AdminApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  role: AdminRole;
  status: "active" | "revoked";
  allowed_ips_json: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface BillingSubscriptionRow {
  id: string;
  license_id: string;
  provider: string;
  external_customer_id: string | null;
  external_subscription_id: string;
  external_plan_id: string | null;
  billing_interval: "monthly" | "yearly";
  provider_status: string;
  currency: string | null;
  unit_amount_minor: number | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: number;
  canceled_at: string | null;
  last_payment_event_id: string | null;
  last_payment_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingEventRow {
  id: string;
  provider: string;
  provider_event_id: string;
  canonical_event_type: CanonicalBillingEventType;
  license_id: string | null;
  billing_subscription_id: string | null;
  external_invoice_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  period_start_granted: string | null;
  period_end_granted: string | null;
  processing_status: "processed" | "ignored" | "failed";
  payload_sha256: string;
  error_message: string | null;
  occurred_at: string;
  processed_at: string;
}

export interface StudioToolRow {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  badge: string;
  icon: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface RequestContext {
  requestId: string;
  now: Date;
  nowIso: string;
  clientIp: string | null;
  ipHash: string;
  userAgent: string;
}
