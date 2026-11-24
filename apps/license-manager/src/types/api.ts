export type Environment = "staging" | "production";

export type AdminRole =
  | "super_admin"
  | "support_admin"
  | "billing_system"
  | "read_only";

export type LicenseStatus =
  | "pending_activation"
  | "active"
  | "past_due"
  | "expired"
  | "suspended"
  | "revoked";

export type LicenseType = "perpetual" | "subscription";
export type BillingInterval = "lifetime" | "monthly" | "yearly";
export type ProductCode = "desktop" | "vectorizer_extension";

export interface AdminIdentity {
  id: string;
  name: string;
  key_prefix: string;
  role: AdminRole;
  permissions: string[];
  allowed_ips_configured: boolean;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface AdminMeResponse {
  ok: boolean;
  admin: AdminIdentity;
  environment: string;
  signing_kid: string;
  server_time: string;
}

export interface SessionStatus {
  unlocked: boolean;
  environment: Environment;
  api_base_url: string;
  has_stored_credential: boolean;
  idle_timeout_secs: number;
  idle_remaining_secs: number;
  credential_service: string;
  admin_me: AdminMeResponse | null;
  locked_reason: string | null;
}

export interface LicenseEntitlements {
  products: string[];
  features: string[];
  max_accounts: number | null;
  updates_until: string | null;
  max_app_version: string | null;
}

export interface LicenseSummary {
  license_id: string;
  key_prefix: string;
  plan_code: string;
  plan_name: string;
  license_type: LicenseType;
  billing_interval: BillingInterval;
  status: LicenseStatus;
  lifetime: boolean;
  expires_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  grace_until: string | null;
  cancel_at_period_end: boolean | null;
  device_limit: number;
  devices_used: number;
  entitlements: LicenseEntitlements;
  customer_email: string | null;
  customer_name: string | null;
  external_customer_id: string | null;
  external_order_id: string | null;
  issued_at: string | null;
  activated_at: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaginationMeta {
  limit: number;
  sort?: string | null;
  has_more: boolean;
  next_cursor: string | null;
}

export interface AdminLicensesResponse {
  ok: boolean;
  items: LicenseSummary[];
  pagination: PaginationMeta;
  server_time: string;
}

export interface ActivationSummary {
  activation_id: string;
  device_id: string;
  device_name: string | null;
  app_version: string | null;
  status: string;
  activated_at: string | null;
  last_validated_at: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
}

export interface BillingSubscriptionSummary {
  id: string | null;
  provider: string | null;
  provider_status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  last_payment_at: string | null;
}

export interface AuditEventItem {
  id: string;
  license_id: string | null;
  activation_id: string | null;
  device_id: string | null;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  previous_status: string | null;
  new_status: string | null;
  ip_hash_prefix: string | null;
  metadata: Record<string, unknown>;
  metadata_json?: string | null;
  created_at: string;
}

export interface AdminLicenseDetailResponse {
  ok: boolean;
  license: LicenseSummary;
  activations: ActivationSummary[];
  billing_subscription: BillingSubscriptionSummary | null;
  events: AuditEventItem[];
  server_time: string;
}

export interface DashboardStats {
  total_licenses: number;
  by_status: {
    pending_activation: number;
    active: number;
    past_due: number;
    expired: number;
    suspended: number;
    revoked: number;
  };
  by_license_type: {
    perpetual: number;
    subscription: number;
  };
  by_billing_interval: {
    lifetime: number;
    monthly: number;
    yearly: number;
  };
  active_device_activations: number;
  expiring_within_7d: number;
  issued_last_30d: number;
}

export interface AdminStatsResponse {
  ok: boolean;
  stats: DashboardStats;
  environment: string;
  signing_kid: string;
  server_time: string;
}

export interface AdminEventsResponse {
  ok: boolean;
  items: AuditEventItem[];
  pagination: PaginationMeta;
  server_time: string;
}

export interface ListLicensesQuery {
  limit?: number;
  cursor?: string | null;
  sort?: "created_desc" | "created_asc";
  status?: string;
  license_type?: string;
  billing_interval?: string;
  plan_code?: string;
  product?: string;
  q?: string;
}

export interface ListEventsQuery {
  limit?: number;
  cursor?: string | null;
  license_id?: string;
  event_type?: string;
  actor_type?: string;
  from?: string;
  to?: string;
}

export interface CreateLicensePayload {
  plan_code: string;
  plan_name: string;
  license_type: LicenseType;
  billing_interval: BillingInterval;
  device_limit: number;
  current_period_start?: string;
  current_period_end?: string;
  expires_at?: string;
  customer_email?: string;
  customer_name?: string;
  external_customer_id?: string;
  external_order_id?: string;
  notes?: string;
  entitlements: {
    products: ProductCode[];
  };
}

export interface IssueLicenseCommandInput {
  expected_environment: Environment;
  idempotency_key: string;
  payload: CreateLicensePayload;
}

export type IssueLicenseOutcomeKind =
  | "created"
  | "duplicate_conflict"
  | "uncertain"
  | "rejected";

export interface IssueLicenseResult {
  outcome: IssueLicenseOutcomeKind;
  license: LicenseSummary | null;
  one_time_license_key: string | null;
  audit_event_verified: boolean;
  existing_license_id: string | null;
  existing_key_prefix: string | null;
  idempotency_key: string;
  message: string | null;
}

export interface RevokeLicenseCommandInput {
  expected_environment: Environment;
  license_id: string;
  expected_key_prefix: string;
  confirm_key_prefix: string;
  reason: string;
}

export interface ForceDeactivateDeviceCommandInput {
  expected_environment: Environment;
  license_id: string;
  activation_id: string;
  expected_key_prefix: string;
  confirm_key_prefix: string;
  reason: string;
}

export interface LifecycleMutationResult {
  outcome: "completed" | "uncertain" | "rejected";
  already_applied: boolean;
  audit_event_verified: boolean;
  detail: AdminLicenseDetailResponse | null;
  message: string | null;
}

export interface StudioToolItem {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  badge: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AdminStudioToolsResponse {
  ok: boolean;
  tools: StudioToolItem[];
  server_time: string;
}

export interface AdminStudioToolMutationResponse {
  ok: boolean;
  tool: StudioToolItem | null;
  server_time: string;
}

export interface AdminStudioToolDeleteResponse {
  ok: boolean;
  deleted_id: string;
  server_time: string;
}

export interface CreateStudioToolCommandInput {
  expected_environment: Environment;
  payload: {
    id?: string;
    name: string;
    category?: string;
    description?: string;
    url: string;
    badge?: string;
    enabled?: boolean;
    sort_order?: number;
  };
}

export interface UpdateStudioToolCommandInput {
  expected_environment: Environment;
  tool_id: string;
  payload: {
    name?: string;
    category?: string;
    description?: string;
    url?: string;
    badge?: string;
    enabled?: boolean;
    sort_order?: number;
  };
}

export interface DeleteStudioToolCommandInput {
  expected_environment: Environment;
  tool_id: string;
}

export interface UpdateLicenseCommandInput {
  expected_environment: Environment;
  license_id: string;
  payload: {
    device_limit?: number;
    customer_email?: string;
    customer_name?: string;
    notes?: string;
    entitlements?: {
      products: ProductCode[];
    };
  };
}

export interface ReasonMutationCommandInput {
  expected_environment: Environment;
  license_id: string;
  reason: string;
}

export interface RenewSubscriptionCommandInput {
  expected_environment: Environment;
  license_id: string;
  payload: {
    billing_provider?: string;
    external_payment_id: string;
    new_period_start: string;
    new_period_end: string;
    reason?: string;
  };
}
