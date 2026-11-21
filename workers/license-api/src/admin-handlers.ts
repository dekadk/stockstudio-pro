// =============================================================================
// StockStudio Pro License API (v0.2.0) — Admin & Provider-Independent Billing
// Endpoints:
//   - POST   /v1/admin/licenses
//   - GET    /v1/admin/licenses/:license_id
//   - PATCH  /v1/admin/licenses/:license_id
//   - POST   /v1/admin/licenses/:license_id/suspend
//   - POST   /v1/admin/licenses/:license_id/reinstate
//   - POST   /v1/admin/licenses/:license_id/revoke
//   - POST   /v1/admin/licenses/:license_id/renew
//   - DELETE /v1/admin/licenses/:license_id/devices/:activation_id
//   - POST   /v1/billing/webhooks/:provider
// =============================================================================

import {
  constantTimeEqual,
  generateLicenseKey,
  generatePrefixedId,
  hashAdminApiKey,
  hashLicenseKey,
  hmacSha256Hex,
  sha256Hex,
} from "./crypto";
import { ApiError, jsonResponse } from "./errors";
import {
  ActivationRow,
  AdminApiKeyRow,
  AdminRole,
  BillingEventRow,
  BillingInterval,
  BillingSubscriptionRow,
  CanonicalBillingEventType,
  Env,
  LicenseEntitlements,
  LicenseRow,
  LicenseType,
  RequestContext,
} from "./types";
import {
  canonicalizeIpAddress,
  formatLicenseSummary,
  getDefaultDeviceLimit,
  getExpectedProductId,
  parseEntitlements,
  parseJsonBody,
  prepareLicenseEventStatement,
  validateEntitlementsInput,
} from "./utils";

/**
 * Authenticates an Admin API request (`Authorization: Bearer ssadm_...`)
 * and verifies that the admin holds one of the allowed RBAC roles.
 */
export async function authenticateAdmin(
  request: Request,
  env: Env,
  ctx: RequestContext,
  allowedRoles: AdminRole[]
): Promise<AdminApiKeyRow> {
  const header = request.headers.get("Authorization")?.trim();
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Missing Bearer admin API key.",
    });
  }

  const rawToken = header.slice(7).trim();
  if (!rawToken.startsWith("ssadm_")) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Invalid admin API key format.",
    });
  }

  const keyHash = await hashAdminApiKey(env.ADMIN_TOKEN_PEPPER, rawToken);
  const adminKey = await env.DB.prepare(
    "SELECT * FROM admin_api_keys WHERE key_hash = ?1"
  )
    .bind(keyHash)
    .first<AdminApiKeyRow>();

  if (!adminKey || !constantTimeEqual(adminKey.key_hash, keyHash)) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Invalid admin API key.",
    });
  }

  if (adminKey.status !== "active") {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Admin API key has been revoked.",
    });
  }

  if (adminKey.expires_at) {
    const expMs = Date.parse(adminKey.expires_at);
    if (Number.isFinite(expMs) && ctx.now.getTime() >= expMs) {
      throw new ApiError({
        code: "UNAUTHORIZED_TOKEN",
        status: 401,
        message: "Admin API key has expired.",
      });
    }
  }

  if (!allowedRoles.includes(adminKey.role)) {
    throw new ApiError({
      code: "FORBIDDEN_ROLE",
      status: 403,
      message: `Admin role '${adminKey.role}' is not permitted to perform this operation.`,
    });
  }

  // Enforce optional IP allowlist when configured (null or empty array remains unrestricted)
  if (
    adminKey.allowed_ips_json !== null &&
    adminKey.allowed_ips_json.trim().length > 0
  ) {
    let parsedAllowedIps: unknown;
    try {
      parsedAllowedIps = JSON.parse(adminKey.allowed_ips_json);
    } catch {
      throw new ApiError({
        code: "FORBIDDEN_ROLE",
        status: 403,
        message: "Admin API key IP allowlist configuration is invalid.",
      });
    }

    if (!Array.isArray(parsedAllowedIps)) {
      throw new ApiError({
        code: "FORBIDDEN_ROLE",
        status: 403,
        message: "Admin API key IP allowlist configuration is invalid.",
      });
    }

    const canonicalAllowlist: string[] = [];
    for (const entry of parsedAllowedIps) {
      const canonical = canonicalizeIpAddress(entry);
      if (!canonical) {
        throw new ApiError({
          code: "FORBIDDEN_ROLE",
          status: 403,
          message: "Admin API key IP allowlist contains an invalid IP address.",
        });
      }
      canonicalAllowlist.push(canonical);
    }

    if (canonicalAllowlist.length > 0) {
      if (!ctx.clientIp || !canonicalAllowlist.includes(ctx.clientIp)) {
        throw new ApiError({
          code: "FORBIDDEN_ROLE",
          status: 403,
          message: "Admin API request IP is not in the configured allowlist.",
        });
      }
    }
  }

  await env.DB.prepare(
    "UPDATE admin_api_keys SET last_used_at = ?2 WHERE id = ?1"
  )
    .bind(adminKey.id, ctx.nowIso)
    .run();

  return adminKey;
}

function validateIsoTimestamp(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: `'${fieldName}' must be a valid ISO-8601 UTC timestamp string.`,
    });
  }
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: `'${fieldName}' is not a valid ISO-8601 timestamp.`,
    });
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * POST /v1/admin/licenses — Issue a new Perpetual or Subscription license.
 */
export async function handleAdminCreateLicense(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  const admin = await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "billing_system",
  ]);

  const idempotencyKey =
    request.headers.get("Idempotency-Key")?.trim() || null;

  if (idempotencyKey) {
    const existing = await env.DB.prepare(
      "SELECT * FROM licenses WHERE idempotency_key = ?1"
    )
      .bind(idempotencyKey)
      .first<LicenseRow>();

    if (existing) {
      throw new ApiError({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
        message:
          "A license has already been created with this Idempotency-Key. Plaintext license keys are returned only once at initial creation.",
        details: {
          license_id: existing.id,
          key_prefix: existing.key_prefix,
        },
      });
    }
  }

  const body = await parseJsonBody<{
    plan_code?: unknown;
    plan_name?: unknown;
    license_type?: unknown;
    billing_interval?: unknown;
    customer_email?: unknown;
    customer_name?: unknown;
    external_customer_id?: unknown;
    external_order_id?: unknown;
    external_subscription_id?: unknown;
    billing_provider?: unknown;
    device_limit?: unknown;
    current_period_start?: unknown;
    current_period_end?: unknown;
    expires_at?: unknown;
    entitlements?: unknown;
    notes?: unknown;
  }>(request);

  const planCode =
    typeof body.plan_code === "string" && body.plan_code.trim().length > 0
      ? body.plan_code.trim()
      : "";
  const planName =
    typeof body.plan_name === "string" && body.plan_name.trim().length > 0
      ? body.plan_name.trim()
      : "";

  if (!planCode || !planName) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'plan_code' and 'plan_name' are required.",
    });
  }

  const licenseType = body.license_type as LicenseType;
  if (licenseType !== "perpetual" && licenseType !== "subscription") {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'license_type' must be either 'perpetual' or 'subscription'.",
    });
  }

  const billingInterval = body.billing_interval as BillingInterval;
  let currentPeriodStart: string | null = null;
  let currentPeriodEnd: string | null = null;
  let expiresAt: string | null = null;

  if (licenseType === "perpetual") {
    if (billingInterval !== "lifetime") {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message:
          "Perpetual licenses must have 'billing_interval' set to 'lifetime'.",
      });
    }
    if (
      body.expires_at !== undefined &&
      body.expires_at !== null
    ) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "Perpetual licenses cannot have an 'expires_at' date.",
      });
    }
  } else {
    if (billingInterval !== "monthly" && billingInterval !== "yearly") {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message:
          "Subscription licenses must have 'billing_interval' set to 'monthly' or 'yearly'.",
      });
    }
    currentPeriodStart = validateIsoTimestamp(
      body.current_period_start,
      "current_period_start"
    );
    currentPeriodEnd = validateIsoTimestamp(
      body.current_period_end,
      "current_period_end"
    );
    expiresAt =
      body.expires_at !== undefined && body.expires_at !== null
        ? validateIsoTimestamp(body.expires_at, "expires_at")
        : currentPeriodEnd;

    if (Date.parse(currentPeriodEnd) <= Date.parse(currentPeriodStart)) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "'current_period_end' must be greater than 'current_period_start'.",
      });
    }
  }

  const defaultDeviceLimit = getDefaultDeviceLimit(env);
  const deviceLimit =
    body.device_limit !== undefined
      ? Number(body.device_limit)
      : defaultDeviceLimit;

  if (
    !Number.isInteger(deviceLimit) ||
    deviceLimit < 1 ||
    deviceLimit > 100
  ) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'device_limit' must be an integer between 1 and 100.",
    });
  }

  const entitlements: LicenseEntitlements = validateEntitlementsInput(
    body.entitlements
  );

  const licenseId = generatePrefixedId("lic", ctx.now.getTime());
  const { licenseKey, keyPrefix } = generateLicenseKey();
  const keyHash = await hashLicenseKey(env.LICENSE_KEY_PEPPER, licenseKey);
  const pepperVersion = Number.parseInt(
    env.LICENSE_KEY_PEPPER_VERSION ?? "1",
    10
  );

  const customerEmail =
    typeof body.customer_email === "string"
      ? body.customer_email.trim().toLowerCase()
      : null;
  const customerName =
    typeof body.customer_name === "string" ? body.customer_name.trim() : null;
  const externalCustomerId =
    typeof body.external_customer_id === "string"
      ? body.external_customer_id.trim()
      : null;
  const externalOrderId =
    typeof body.external_order_id === "string"
      ? body.external_order_id.trim()
      : null;
  const notes =
    typeof body.notes === "string" ? body.notes.trim() : null;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO licenses (
         id, product_id, key_prefix, key_hash, key_pepper_version,
         plan_code, plan_name, license_type, billing_interval,
         status, device_limit, active_devices_count,
         issued_at, current_period_start, current_period_end, expires_at,
         updates_until, max_app_version, entitlements_json,
         customer_email, customer_name, external_customer_id, external_order_id,
         notes, idempotency_key, created_by, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9,
         'pending_activation', ?10, 0,
         ?11, ?12, ?13, ?14,
         ?15, ?16, ?17,
         ?18, ?19, ?20, ?21,
         ?22, ?23, ?24, ?11, ?11
       )`
    ).bind(
      licenseId,
      getExpectedProductId(env),
      keyPrefix,
      keyHash,
      Number.isFinite(pepperVersion) ? pepperVersion : 1,
      planCode,
      planName,
      licenseType,
      billingInterval,
      deviceLimit,
      ctx.nowIso,
      currentPeriodStart,
      currentPeriodEnd,
      expiresAt,
      entitlements.updates_until,
      entitlements.max_app_version,
      JSON.stringify(entitlements),
      customerEmail,
      customerName,
      externalCustomerId,
      externalOrderId,
      notes,
      idempotencyKey,
      admin.id
    ),
  ];

  // If subscription has an external_subscription_id (or default internal subscription record), record it in billing_subscriptions
  if (licenseType === "subscription" && currentPeriodStart && currentPeriodEnd) {
    const subId = generatePrefixedId("sub", ctx.now.getTime());
    const provider =
      typeof body.billing_provider === "string" &&
      body.billing_provider.trim().length > 0
        ? body.billing_provider.trim()
        : "manual";
    const externalSubscriptionId =
      typeof body.external_subscription_id === "string" &&
      body.external_subscription_id.trim().length > 0
        ? body.external_subscription_id.trim()
        : `sub_ext_${licenseId}`;

    statements.push(
      env.DB.prepare(
        `INSERT INTO billing_subscriptions (
           id, license_id, provider, external_customer_id,
           external_subscription_id, external_plan_id, billing_interval,
           provider_status, current_period_start, current_period_end,
           cancel_at_period_end, created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4,
           ?5, ?6, ?7,
           'active', ?8, ?9,
           0, ?10, ?10
         )`
      ).bind(
        subId,
        licenseId,
        provider,
        externalCustomerId,
        externalSubscriptionId,
        planCode,
        billingInterval,
        currentPeriodStart,
        currentPeriodEnd,
        ctx.nowIso
      )
    );
  }

  statements.push(
    prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId,
      eventType: "license.issued",
      actorType: "admin",
      actorId: admin.id,
      previousStatus: null,
      newStatus: "pending_activation",
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: {
        plan_code: planCode,
        license_type: licenseType,
        billing_interval: billingInterval,
        device_limit: deviceLimit,
        expires_at: expiresAt,
      },
    })
  );

  await env.DB.batch(statements);

  return jsonResponse(
    {
      ok: true,
      license_key: licenseKey,
      license: {
        license_id: licenseId,
        key_prefix: keyPrefix,
        plan_code: planCode,
        plan_name: planName,
        license_type: licenseType,
        billing_interval: billingInterval,
        status: "pending_activation",
        lifetime: licenseType === "perpetual",
        expires_at: expiresAt,
        current_period_start: currentPeriodStart,
        current_period_end: currentPeriodEnd,
        device_limit: deviceLimit,
        devices_used: 0,
        entitlements,
        customer_email: customerEmail,
        created_at: ctx.nowIso,
      },
      request_id: ctx.requestId,
      server_time: ctx.nowIso,
    },
    201,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * GET /v1/admin/licenses/:license_id
 */
export async function handleAdminGetLicense(
  request: Request,
  env: Env,
  ctx: RequestContext,
  licenseId: string
): Promise<Response> {
  await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "support_admin",
    "billing_system",
    "read_only",
  ]);

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(licenseId)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: `License '${licenseId}' not found.`,
    });
  }

  const activationsResult = await env.DB.prepare(
    `SELECT
       a.id AS activation_id,
       a.device_id AS device_id,
       a.device_fingerprint AS device_fingerprint,
       a.device_name_snapshot AS device_name,
       a.app_version_snapshot AS app_version,
       a.status AS status,
       a.activated_at AS activated_at,
       a.last_validated_at AS last_validated_at,
       a.deactivated_at AS deactivated_at,
       a.deactivated_by AS deactivated_by,
       a.deactivation_reason AS deactivation_reason
     FROM activations a
     WHERE a.license_id = ?1
     ORDER BY a.activated_at DESC`
  )
    .bind(licenseId)
    .all();

  const billingSub = await env.DB.prepare(
    "SELECT * FROM billing_subscriptions WHERE license_id = ?1"
  )
    .bind(licenseId)
    .first<BillingSubscriptionRow>();

  const eventsResult = await env.DB.prepare(
    `SELECT id, event_type, actor_type, actor_id, previous_status, new_status, metadata_json, created_at
     FROM license_events
     WHERE license_id = ?1
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(licenseId)
    .all();

  return jsonResponse(
    {
      ok: true,
      license: {
        ...formatLicenseSummary(license),
        customer_email: license.customer_email,
        customer_name: license.customer_name,
        external_customer_id: license.external_customer_id,
        external_order_id: license.external_order_id,
        issued_at: license.issued_at,
        activated_at: license.activated_at,
        suspended_at: license.suspended_at,
        suspension_reason: license.suspension_reason,
        revoked_at: license.revoked_at,
        revocation_reason: license.revocation_reason,
        notes: license.notes,
        created_at: license.created_at,
        updated_at: license.updated_at,
      },
      billing_subscription: billingSub ?? null,
      activations: activationsResult.results ?? [],
      events: eventsResult.results ?? [],
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * PATCH /v1/admin/licenses/:license_id
 */
export async function handleAdminUpdateLicense(
  request: Request,
  env: Env,
  ctx: RequestContext,
  licenseId: string
): Promise<Response> {
  const admin = await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "support_admin",
  ]);

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(licenseId)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: `License '${licenseId}' not found.`,
    });
  }

  const body = await parseJsonBody<{
    device_limit?: unknown;
    customer_email?: unknown;
    customer_name?: unknown;
    notes?: unknown;
    entitlements?: unknown;
  }>(request);

  let newDeviceLimit = license.device_limit;
  if (body.device_limit !== undefined) {
    const parsed = Number(body.device_limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "'device_limit' must be an integer between 1 and 100.",
      });
    }
    if (parsed < license.active_devices_count) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: `Cannot set 'device_limit' (${parsed}) below current active devices count (${license.active_devices_count}). Deactivate excess devices first.`,
      });
    }
    newDeviceLimit = parsed;
  }

  const newCustomerEmail =
    body.customer_email !== undefined
      ? typeof body.customer_email === "string"
        ? body.customer_email.trim().toLowerCase()
        : null
      : license.customer_email;

  const newCustomerName =
    body.customer_name !== undefined
      ? typeof body.customer_name === "string"
        ? body.customer_name.trim()
        : null
      : license.customer_name;

  const newNotes =
    body.notes !== undefined
      ? typeof body.notes === "string"
        ? body.notes.trim()
        : null
      : license.notes;

  let newEntitlementsJson = license.entitlements_json;
  let newUpdatesUntil = license.updates_until;
  let newMaxAppVersion = license.max_app_version;
  if (body.entitlements !== undefined) {
    const validatedEntitlements = validateEntitlementsInput(
      body.entitlements,
      parseEntitlements(license)
    );
    newEntitlementsJson = JSON.stringify(validatedEntitlements);
    newUpdatesUntil = validatedEntitlements.updates_until;
    newMaxAppVersion = validatedEntitlements.max_app_version;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE licenses
       SET device_limit = ?2,
           customer_email = ?3,
           customer_name = ?4,
           notes = ?5,
           entitlements_json = ?6,
           updates_until = ?7,
           max_app_version = ?8,
           updated_at = ?9
       WHERE id = ?1`
    ).bind(
      licenseId,
      newDeviceLimit,
      newCustomerEmail,
      newCustomerName,
      newNotes,
      newEntitlementsJson,
      newUpdatesUntil,
      newMaxAppVersion,
      ctx.nowIso
    ),
    prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId,
      eventType: "license.updated",
      actorType: "admin",
      actorId: admin.id,
      previousStatus: license.status,
      newStatus: license.status,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: {
        previous_device_limit: license.device_limit,
        new_device_limit: newDeviceLimit,
      },
    }),
  ]);

  const updated =
    (await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<LicenseRow>()) ?? license;

  return jsonResponse(
    {
      ok: true,
      license: formatLicenseSummary(updated),
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/admin/licenses/:license_id/suspend
 */
export async function handleAdminSuspendLicense(
  request: Request,
  env: Env,
  ctx: RequestContext,
  licenseId: string
): Promise<Response> {
  const admin = await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "support_admin",
  ]);

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(licenseId)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: `License '${licenseId}' not found.`,
    });
  }

  if (license.status === "revoked") {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Cannot suspend a permanently revoked license.",
    });
  }

  const body = await parseJsonBody<{ reason?: unknown }>(request);
  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : "Administrative suspension";

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE licenses
       SET status = 'suspended',
           suspended_at = ?2,
           suspension_reason = ?3,
           updated_at = ?2
       WHERE id = ?1`
    ).bind(licenseId, ctx.nowIso, reason),
    prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId,
      eventType: "license.suspended",
      actorType: "admin",
      actorId: admin.id,
      previousStatus: license.status,
      newStatus: "suspended",
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: { reason },
    }),
  ]);

  const updated =
    (await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<LicenseRow>()) ?? license;

  return jsonResponse(
    {
      ok: true,
      license: formatLicenseSummary(updated),
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/admin/licenses/:license_id/reinstate
 */
export async function handleAdminReinstateLicense(
  request: Request,
  env: Env,
  ctx: RequestContext,
  licenseId: string
): Promise<Response> {
  const admin = await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "support_admin",
  ]);

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(licenseId)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: `License '${licenseId}' not found.`,
    });
  }

  if (license.status === "revoked") {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Cannot reinstate a permanently revoked license.",
    });
  }

  const body = await parseJsonBody<{ reason?: unknown }>(request);
  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : "Administrative reinstatement";

  const targetStatus =
    license.activated_at === null && license.active_devices_count === 0
      ? "pending_activation"
      : "active";

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE licenses
       SET status = ?2,
           suspended_at = NULL,
           suspension_reason = NULL,
           updated_at = ?3
       WHERE id = ?1`
    ).bind(licenseId, targetStatus, ctx.nowIso),
    prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId,
      eventType: "license.reinstated",
      actorType: "admin",
      actorId: admin.id,
      previousStatus: license.status,
      newStatus: targetStatus,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: { reason },
    }),
  ]);

  const updated =
    (await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<LicenseRow>()) ?? license;

  return jsonResponse(
    {
      ok: true,
      license: formatLicenseSummary(updated),
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/admin/licenses/:license_id/revoke
 */
export async function handleAdminRevokeLicense(
  request: Request,
  env: Env,
  ctx: RequestContext,
  licenseId: string
): Promise<Response> {
  const admin = await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "billing_system",
  ]);

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(licenseId)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: `License '${licenseId}' not found.`,
    });
  }

  const body = await parseJsonBody<{
    reason?: unknown;
    external_reference_id?: unknown;
  }>(request);

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : "Permanent administrative revocation";

  if (license.status === "revoked") {
    return jsonResponse(
      {
        ok: true,
        already_revoked: true,
        license: formatLicenseSummary(license),
        server_time: ctx.nowIso,
      },
      200,
      { "X-Request-Id": ctx.requestId }
    );
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE activations
       SET status = 'revoked',
           deactivated_at = ?2,
           deactivated_by = ?3,
           deactivation_reason = ?4,
           updated_at = ?2
       WHERE license_id = ?1 AND status = 'active'`
    ).bind(licenseId, ctx.nowIso, `admin:${admin.id}`, reason),
    env.DB.prepare(
      `UPDATE licenses
       SET status = 'revoked',
           active_devices_count = 0,
           revoked_at = ?2,
           revocation_reason = ?3,
           updated_at = ?2
       WHERE id = ?1`
    ).bind(licenseId, ctx.nowIso, reason),
    prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId,
      eventType: "license.revoked",
      actorType: "admin",
      actorId: admin.id,
      previousStatus: license.status,
      newStatus: "revoked",
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: {
        reason,
        external_reference_id:
          typeof body.external_reference_id === "string"
            ? body.external_reference_id
            : null,
      },
    }),
  ]);

  const updated =
    (await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<LicenseRow>()) ?? license;

  return jsonResponse(
    {
      ok: true,
      already_revoked: false,
      license: formatLicenseSummary(updated),
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/admin/licenses/:license_id/renew
 * Extends a subscription license period via an idempotent confirmed payment record.
 */
export async function handleAdminRenewSubscription(
  request: Request,
  env: Env,
  ctx: RequestContext,
  licenseId: string
): Promise<Response> {
  const admin = await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "billing_system",
  ]);

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(licenseId)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: `License '${licenseId}' not found.`,
    });
  }

  if (license.license_type !== "subscription") {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Only 'subscription' licenses can be renewed.",
    });
  }

  if (license.status === "revoked") {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Cannot renew a permanently revoked license.",
    });
  }

  const body = await parseJsonBody<{
    billing_provider?: unknown;
    external_payment_id?: unknown;
    amount_minor?: unknown;
    currency?: unknown;
    new_period_start?: unknown;
    new_period_end?: unknown;
    reason?: unknown;
  }>(request);

  const provider =
    typeof body.billing_provider === "string" &&
    body.billing_provider.trim().length > 0
      ? body.billing_provider.trim()
      : "manual_admin";

  const externalPaymentId =
    typeof body.external_payment_id === "string" &&
    body.external_payment_id.trim().length > 0
      ? body.external_payment_id.trim()
      : "";

  if (!externalPaymentId) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message:
        "'external_payment_id' is required to record a confirmed payment event.",
    });
  }

  const newPeriodStart = validateIsoTimestamp(
    body.new_period_start,
    "new_period_start"
  );
  const newPeriodEnd = validateIsoTimestamp(
    body.new_period_end,
    "new_period_end"
  );

  if (Date.parse(newPeriodEnd) <= Date.parse(newPeriodStart)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'new_period_end' must be greater than 'new_period_start'.",
    });
  }

  // Idempotency check in billing_events MUST come before comparing against current_period_end
  const existingEvent = await env.DB.prepare(
    "SELECT * FROM billing_events WHERE provider = ?1 AND provider_event_id = ?2"
  )
    .bind(provider, externalPaymentId)
    .first<BillingEventRow>();

  if (existingEvent) {
    return jsonResponse(
      {
        ok: true,
        idempotent_replay: true,
        billing_event_id: existingEvent.id,
        license: formatLicenseSummary(license),
        server_time: ctx.nowIso,
      },
      200,
      { "X-Request-Id": ctx.requestId }
    );
  }

  if (
    license.current_period_end &&
    Date.parse(newPeriodEnd) <= Date.parse(license.current_period_end)
  ) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message:
        "'new_period_end' must extend beyond the current subscription 'current_period_end'.",
    });
  }

  const billingSub = await env.DB.prepare(
    "SELECT * FROM billing_subscriptions WHERE license_id = ?1"
  )
    .bind(licenseId)
    .first<BillingSubscriptionRow>();

  const billingEventId = generatePrefixedId("bev", ctx.now.getTime());
  const payloadHash = await sha256Hex(JSON.stringify(body));
  const nextStatus =
    license.status === "expired" || license.status === "past_due"
      ? "active"
      : license.status;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO billing_events (
         id, provider, provider_event_id, canonical_event_type,
         license_id, billing_subscription_id, external_invoice_id,
         amount_minor, currency, period_start_granted, period_end_granted,
         processing_status, payload_sha256, occurred_at, processed_at
       ) VALUES (
         ?1, ?2, ?3, 'payment.succeeded',
         ?4, ?5, ?3,
         ?6, ?7, ?8, ?9,
         'processed', ?10, ?11, ?11
       )`
    ).bind(
      billingEventId,
      provider,
      externalPaymentId,
      licenseId,
      billingSub?.id ?? null,
      typeof body.amount_minor === "number" ? body.amount_minor : null,
      typeof body.currency === "string" ? body.currency.trim() : null,
      newPeriodStart,
      newPeriodEnd,
      payloadHash,
      ctx.nowIso
    ),
    env.DB.prepare(
      `UPDATE licenses
       SET status = ?2,
           current_period_start = ?3,
           current_period_end = ?4,
           expires_at = ?4,
           grace_until = NULL,
           updated_at = ?5
       WHERE id = ?1`
    ).bind(licenseId, nextStatus, newPeriodStart, newPeriodEnd, ctx.nowIso),
  ];

  if (billingSub) {
    statements.push(
      env.DB.prepare(
        `UPDATE billing_subscriptions
         SET provider_status = 'active',
             current_period_start = ?2,
             current_period_end = ?3,
             last_payment_event_id = ?4,
             last_payment_at = ?5,
             updated_at = ?5
         WHERE id = ?1`
      ).bind(
        billingSub.id,
        newPeriodStart,
        newPeriodEnd,
        billingEventId,
        ctx.nowIso
      )
    );
  }

  statements.push(
    prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId,
      eventType: "license.renewed",
      actorType: "admin",
      actorId: admin.id,
      previousStatus: license.status,
      newStatus: nextStatus,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: {
        billing_event_id: billingEventId,
        provider,
        external_payment_id: externalPaymentId,
        new_period_start: newPeriodStart,
        new_period_end: newPeriodEnd,
      },
    })
  );

  await env.DB.batch(statements);

  const updated =
    (await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<LicenseRow>()) ?? license;

  return jsonResponse(
    {
      ok: true,
      idempotent_replay: false,
      billing_event_id: billingEventId,
      license: formatLicenseSummary(updated),
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * DELETE /v1/admin/licenses/:license_id/devices/:activation_id
 */
export async function handleAdminForceDeactivateDevice(
  request: Request,
  env: Env,
  ctx: RequestContext,
  licenseId: string,
  activationId: string
): Promise<Response> {
  const admin = await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "support_admin",
  ]);

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(licenseId)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: `License '${licenseId}' not found.`,
    });
  }

  const activation = await env.DB.prepare(
    "SELECT * FROM activations WHERE id = ?1 AND license_id = ?2"
  )
    .bind(activationId, licenseId)
    .first<ActivationRow>();

  if (!activation) {
    throw new ApiError({
      code: "ACTIVATION_NOT_FOUND",
      status: 404,
      message: `Activation '${activationId}' not found on license '${licenseId}'.`,
    });
  }

  if (activation.status !== "active") {
    return jsonResponse(
      {
        ok: true,
        deactivated_activation_id: activationId,
        already_deactivated: true,
        license_id: licenseId,
        device_limit: license.device_limit,
        devices_used: license.active_devices_count,
        server_time: ctx.nowIso,
      },
      200,
      { "X-Request-Id": ctx.requestId }
    );
  }

  const upd = await env.DB.prepare(
    `UPDATE activations
     SET status = 'deactivated',
         deactivated_at = ?2,
         deactivated_by = ?3,
         deactivation_reason = 'admin_force_deactivated',
         updated_at = ?2
     WHERE id = ?1 AND status = 'active'`
  )
    .bind(activationId, ctx.nowIso, `admin:${admin.id}`)
    .run();

  let newDevicesUsed = license.active_devices_count;
  if ((upd.meta?.changes ?? 0) === 1) {
    newDevicesUsed = Math.max(0, license.active_devices_count - 1);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE licenses SET active_devices_count = MAX(0, active_devices_count - 1), updated_at = ?2 WHERE id = ?1"
      ).bind(licenseId, ctx.nowIso),
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId,
        activationId,
        deviceId: activation.device_id,
        eventType: "license.deactivated",
        actorType: "admin",
        actorId: admin.id,
        previousStatus: license.status,
        newStatus: license.status,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: {
          deactivated_by: `admin:${admin.id}`,
          devices_used: newDevicesUsed,
        },
      }),
    ]);
  }

  return jsonResponse(
    {
      ok: true,
      deactivated_activation_id: activationId,
      already_deactivated: false,
      license_id: licenseId,
      device_limit: license.device_limit,
      devices_used: newDevicesUsed,
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/billing/webhooks/:provider
 * Payment-Provider-Independent Billing Webhook Normalizer & Idempotent Ledger.
 * Verifies HMAC-SHA256 webhook signature (`X-Webhook-Signature`) against
 * `BILLING_WEBHOOK_SECRETS_JSON[provider]` and processes canonical billing events.
 */
export async function handleBillingWebhook(
  request: Request,
  env: Env,
  ctx: RequestContext,
  providerParam: string
): Promise<Response> {
  const provider = providerParam.trim().toLowerCase();
  if (!provider || !/^[a-z0-9_-]{2,32}$/.test(provider)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Invalid billing provider identifier.",
    });
  }

  let secretsMap: Record<string, string> = {};
  if (env.BILLING_WEBHOOK_SECRETS_JSON) {
    try {
      secretsMap = JSON.parse(env.BILLING_WEBHOOK_SECRETS_JSON) as Record<
        string,
        string
      >;
    } catch {
      throw new ApiError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Malformed BILLING_WEBHOOK_SECRETS_JSON configuration.",
      });
    }
  }

  const providerSecret = secretsMap[provider];
  if (!providerSecret) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: `No webhook signing secret configured for provider '${provider}'.`,
    });
  }

  const signatureHeader =
    request.headers.get("X-Webhook-Signature")?.trim() ?? "";
  if (!signatureHeader) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Missing X-Webhook-Signature header.",
    });
  }

  const rawBody = await request.text();
  const expectedSig = await hmacSha256Hex(providerSecret, rawBody);
  if (!constantTimeEqual(signatureHeader.toLowerCase(), expectedSig.toLowerCase())) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Invalid webhook HMAC signature.",
    });
  }

  let payload: {
    event_id?: unknown;
    event_type?: unknown;
    license_id?: unknown;
    external_subscription_id?: unknown;
    external_invoice_id?: unknown;
    amount_minor?: unknown;
    currency?: unknown;
    period_start?: unknown;
    period_end?: unknown;
    grace_until?: unknown;
    cancel_at_period_end?: unknown;
    occurred_at?: unknown;
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Malformed JSON webhook body.",
    });
  }

  const providerEventId =
    typeof payload.event_id === "string" ? payload.event_id.trim() : "";
  const canonicalType = payload.event_type as CanonicalBillingEventType;

  const allowedTypes: CanonicalBillingEventType[] = [
    "payment.succeeded",
    "payment.failed",
    "subscription.created",
    "subscription.renewed",
    "subscription.canceled",
    "payment.refunded",
    "payment.chargeback",
  ];

  if (!providerEventId || !allowedTypes.includes(canonicalType)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message:
        "'event_id' and a valid canonical 'event_type' are required.",
    });
  }

  // 1. Check idempotency ledger first
  const existingEvent = await env.DB.prepare(
    "SELECT * FROM billing_events WHERE provider = ?1 AND provider_event_id = ?2"
  )
    .bind(provider, providerEventId)
    .first<BillingEventRow>();

  if (existingEvent) {
    return jsonResponse(
      {
        ok: true,
        idempotent_replay: true,
        billing_event_id: existingEvent.id,
        processing_status: existingEvent.processing_status,
        server_time: ctx.nowIso,
      },
      200,
      { "X-Request-Id": ctx.requestId }
    );
  }

  // 2. Resolve target license / subscription
  let license: LicenseRow | null = null;
  let billingSub: BillingSubscriptionRow | null = null;

  if (
    typeof payload.external_subscription_id === "string" &&
    payload.external_subscription_id.trim().length > 0
  ) {
    billingSub = await env.DB.prepare(
      "SELECT * FROM billing_subscriptions WHERE provider = ?1 AND external_subscription_id = ?2"
    )
      .bind(provider, payload.external_subscription_id.trim())
      .first<BillingSubscriptionRow>();
    if (billingSub) {
      license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
        .bind(billingSub.license_id)
        .first<LicenseRow>();
    }
  }

  if (
    !license &&
    typeof payload.license_id === "string" &&
    payload.license_id.trim().length > 0
  ) {
    license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(payload.license_id.trim())
      .first<LicenseRow>();
    if (license && !billingSub) {
      billingSub = await env.DB.prepare(
        "SELECT * FROM billing_subscriptions WHERE license_id = ?1"
      )
        .bind(license.id)
        .first<BillingSubscriptionRow>();
    }
  }

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: "Target license for billing event was not found.",
    });
  }

  const billingEventId = generatePrefixedId("bev", ctx.now.getTime());
  const payloadSha256 = await sha256Hex(rawBody);
  const occurredAt =
    typeof payload.occurred_at === "string"
      ? validateIsoTimestamp(payload.occurred_at, "occurred_at")
      : ctx.nowIso;

  let periodStartGranted: string | null = null;
  let periodEndGranted: string | null = null;
  const statements: D1PreparedStatement[] = [];

  // Only confirmed payment events ('payment.succeeded' / 'subscription.renewed') may extend subscription validity!
  if (
    canonicalType === "payment.succeeded" ||
    canonicalType === "subscription.renewed"
  ) {
    if (license.license_type !== "subscription") {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "Cannot apply subscription period extension to a perpetual license.",
      });
    }
    periodStartGranted = validateIsoTimestamp(
      payload.period_start,
      "period_start"
    );
    periodEndGranted = validateIsoTimestamp(payload.period_end, "period_end");

    if (Date.parse(periodEndGranted) <= Date.parse(periodStartGranted)) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "'period_end' must be greater than 'period_start'.",
      });
    }

    const nextStatus =
      license.status === "expired" || license.status === "past_due"
        ? "active"
        : license.status;

    statements.push(
      env.DB.prepare(
        `UPDATE licenses
         SET status = ?2,
             current_period_start = ?3,
             current_period_end = ?4,
             expires_at = ?4,
             grace_until = NULL,
             updated_at = ?5
         WHERE id = ?1 AND status != 'revoked'`
      ).bind(
        license.id,
        nextStatus,
        periodStartGranted,
        periodEndGranted,
        ctx.nowIso
      )
    );

    if (billingSub) {
      statements.push(
        env.DB.prepare(
          `UPDATE billing_subscriptions
           SET provider_status = 'active',
               current_period_start = ?2,
               current_period_end = ?3,
               last_payment_event_id = ?4,
               last_payment_at = ?5,
               updated_at = ?5
           WHERE id = ?1`
        ).bind(
          billingSub.id,
          periodStartGranted,
          periodEndGranted,
          billingEventId,
          ctx.nowIso
        )
      );
    }

    statements.push(
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId: license.id,
        eventType: "license.renewed",
        actorType: "billing_webhook",
        actorId: `${provider}:${providerEventId}`,
        previousStatus: license.status,
        newStatus: nextStatus,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: {
          billing_event_id: billingEventId,
          period_start_granted: periodStartGranted,
          period_end_granted: periodEndGranted,
        },
      })
    );
  } else if (canonicalType === "payment.failed") {
    const graceUntil =
      typeof payload.grace_until === "string"
        ? validateIsoTimestamp(payload.grace_until, "grace_until")
        : new Date(ctx.now.getTime() + 3 * 24 * 60 * 60 * 1000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z");

    statements.push(
      env.DB.prepare(
        `UPDATE licenses
         SET status = 'past_due',
             grace_until = ?2,
             updated_at = ?3
         WHERE id = ?1 AND status IN ('active', 'past_due')`
      ).bind(license.id, graceUntil, ctx.nowIso),
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId: license.id,
        eventType: "license.past_due",
        actorType: "billing_webhook",
        actorId: `${provider}:${providerEventId}`,
        previousStatus: license.status,
        newStatus: "past_due",
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: { billing_event_id: billingEventId, grace_until: graceUntil },
      })
    );
  } else if (canonicalType === "subscription.canceled") {
    const cancelAtPeriodEnd = payload.cancel_at_period_end !== false ? 1 : 0;
    statements.push(
      env.DB.prepare(
        `UPDATE licenses
         SET cancel_at_period_end = ?2,
             canceled_at = ?3,
             updated_at = ?3
         WHERE id = ?1`
      ).bind(license.id, cancelAtPeriodEnd, ctx.nowIso),
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId: license.id,
        eventType: "license.updated",
        actorType: "billing_webhook",
        actorId: `${provider}:${providerEventId}`,
        previousStatus: license.status,
        newStatus: license.status,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: {
          billing_event_id: billingEventId,
          cancel_at_period_end: cancelAtPeriodEnd === 1,
        },
      })
    );
  } else if (
    canonicalType === "payment.refunded" ||
    canonicalType === "payment.chargeback"
  ) {
    statements.push(
      env.DB.prepare(
        `UPDATE activations
         SET status = 'revoked',
             deactivated_at = ?2,
             deactivated_by = 'system_revocation',
             deactivation_reason = ?3,
             updated_at = ?2
         WHERE license_id = ?1 AND status = 'active'`
      ).bind(license.id, ctx.nowIso, canonicalType),
      env.DB.prepare(
        `UPDATE licenses
         SET status = 'revoked',
             active_devices_count = 0,
             revoked_at = ?2,
             revocation_reason = ?3,
             updated_at = ?2
         WHERE id = ?1`
      ).bind(license.id, ctx.nowIso, canonicalType),
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId: license.id,
        eventType: "license.revoked",
        actorType: "billing_webhook",
        actorId: `${provider}:${providerEventId}`,
        previousStatus: license.status,
        newStatus: "revoked",
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: { billing_event_id: billingEventId, reason: canonicalType },
      })
    );
  }

  // Insert billing_events ledger record first in the atomic batch
  statements.unshift(
    env.DB.prepare(
      `INSERT INTO billing_events (
         id, provider, provider_event_id, canonical_event_type,
         license_id, billing_subscription_id, external_invoice_id,
         amount_minor, currency, period_start_granted, period_end_granted,
         processing_status, payload_sha256, occurred_at, processed_at
       ) VALUES (
         ?1, ?2, ?3, ?4,
         ?5, ?6, ?7,
         ?8, ?9, ?10, ?11,
         'processed', ?12, ?13, ?14
       )`
    ).bind(
      billingEventId,
      provider,
      providerEventId,
      canonicalType,
      license.id,
      billingSub?.id ?? null,
      typeof payload.external_invoice_id === "string"
        ? payload.external_invoice_id
        : null,
      typeof payload.amount_minor === "number" ? payload.amount_minor : null,
      typeof payload.currency === "string" ? payload.currency : null,
      periodStartGranted,
      periodEndGranted,
      payloadSha256,
      occurredAt,
      ctx.nowIso
    )
  );

  await env.DB.batch(statements);

  return jsonResponse(
    {
      ok: true,
      idempotent_replay: false,
      billing_event_id: billingEventId,
      processing_status: "processed",
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}
