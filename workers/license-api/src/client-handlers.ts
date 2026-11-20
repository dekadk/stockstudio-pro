// =============================================================================
// StockStudio Pro License API (v0.2.0) — Public Client Endpoints
// Endpoints:
//   - POST /v1/licenses/activate
//   - POST /v1/licenses/validate
//   - POST /v1/licenses/deactivate
//   - GET  /v1/licenses/devices
// =============================================================================

import {
  constantTimeEqual,
  generateActivationToken,
  generatePrefixedId,
  hashActivationToken,
  hashLicenseKey,
  normalizeAndValidateLicenseKey,
  signEntitlementLease,
} from "./crypto";
import { ApiError, jsonResponse } from "./errors";
import {
  ActivationRow,
  Env,
  LicenseRow,
  RequestContext,
} from "./types";
import {
  buildSignedLeasePayload,
  checkRateLimit,
  formatLicenseSummary,
  isSubscriptionExpired,
  parseJsonBody,
  prepareLicenseEventStatement,
  validateClientHeaders,
  validateDeviceInput,
} from "./utils";

/**
 * Extracts a Bearer token from the Authorization header.
 */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization")?.trim();
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Evaluates license status & automatic subscription expiration transition.
 * Throws a terminal ApiError (403) if the license is revoked, suspended, or expired.
 */
async function enforceLicenseActiveOrThrow(
  db: D1Database,
  license: LicenseRow,
  ctx: RequestContext,
  activationId: string | null,
  deviceId: string | null
): Promise<LicenseRow> {
  if (license.status === "revoked") {
    throw new ApiError({
      code: "LICENSE_REVOKED",
      status: 403,
      message: "This license has been permanently revoked.",
      retryable: false,
    });
  }

  if (license.status === "suspended") {
    throw new ApiError({
      code: "LICENSE_SUSPENDED",
      status: 403,
      message: "This license is currently suspended.",
      retryable: false,
    });
  }

  if (license.status === "expired" || isSubscriptionExpired(license, ctx.now)) {
    if (license.status !== "expired") {
      await db.batch([
        db
          .prepare(
            "UPDATE licenses SET status = 'expired', updated_at = ?2 WHERE id = ?1 AND status != 'revoked'"
          )
          .bind(license.id, ctx.nowIso),
        prepareLicenseEventStatement(db, {
          now: ctx.now,
          nowIso: ctx.nowIso,
          licenseId: license.id,
          activationId,
          deviceId,
          eventType: "license.expired",
          actorType: "system",
          previousStatus: license.status,
          newStatus: "expired",
          ipHash: ctx.ipHash,
          userAgent: ctx.userAgent,
          metadata: { expires_at: license.expires_at, grace_until: license.grace_until },
        }),
      ]);
    }
    throw new ApiError({
      code: "LICENSE_EXPIRED",
      status: 403,
      message: "This subscription license has expired.",
      retryable: false,
      details: {
        expires_at: license.expires_at,
      },
    });
  }

  return license;
}

/**
 * Helper to fetch the current active devices list for a license.
 */
async function listActiveDevicesForLicense(
  db: D1Database,
  licenseId: string,
  currentDeviceId?: string | null
): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .prepare(
      `SELECT
         a.id AS activation_id,
         a.device_id AS device_id,
         d.device_name AS device_name,
         d.platform AS platform,
         d.os_version AS os_version,
         d.last_app_version AS app_version,
         a.status AS status,
         a.activated_at AS activated_at,
         a.last_validated_at AS last_validated_at
       FROM activations a
       JOIN devices d ON d.id = a.device_id
       WHERE a.license_id = ?1 AND a.status = 'active'
       ORDER BY a.activated_at ASC`
    )
    .bind(licenseId)
    .all<{
      activation_id: string;
      device_id: string;
      device_name: string;
      platform: string;
      os_version: string | null;
      app_version: string | null;
      status: string;
      activated_at: string;
      last_validated_at: string;
    }>();

  return (rows.results ?? []).map((row) => ({
    activation_id: row.activation_id,
    device_id: row.device_id,
    device_name: row.device_name,
    platform: row.platform,
    os_version: row.os_version,
    app_version: row.app_version ?? "0.2.0",
    status: row.status,
    is_current_device: currentDeviceId ? row.device_id === currentDeviceId : false,
    activated_at: row.activated_at,
    last_validated_at: row.last_validated_at,
  }));
}

/**
 * POST /v1/licenses/activate
 */
export async function handleActivateLicense(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  validateClientHeaders(request, env, ctx);
  const nowEpochSec = Math.floor(ctx.now.getTime() / 1000);

  // Per-IP activation rate limit: 20 attempts per 60s
  await checkRateLimit({
    db: env.DB,
    bucketKey: `act_ip:${ctx.ipHash}`,
    nowEpochSec,
    windowSeconds: 60,
    maxAttempts: 20,
  });

  const body = await parseJsonBody<{
    license_key?: unknown;
    device?: unknown;
  }>(request);

  const keyInfo = normalizeAndValidateLicenseKey(body.license_key);
  if (!keyInfo) {
    throw new ApiError({
      code: "INVALID_LICENSE_KEY",
      status: 401,
      message: "Invalid license key format.",
    });
  }

  // Per-key-prefix lockout: 10 attempts per 900s (15 min)
  await checkRateLimit({
    db: env.DB,
    bucketKey: `act_prefix:${keyInfo.keyPrefix}`,
    nowEpochSec,
    windowSeconds: 900,
    maxAttempts: 15,
    lockoutSeconds: 900,
  });

  const device = validateDeviceInput(body.device, true);
  const keyHash = await hashLicenseKey(env.LICENSE_KEY_PEPPER, keyInfo.normalizedKey);

  const license = await env.DB.prepare(
    "SELECT * FROM licenses WHERE key_hash = ?1"
  )
    .bind(keyHash)
    .first<LicenseRow>();

  if (!license || !constantTimeEqual(license.key_hash, keyHash)) {
    throw new ApiError({
      code: "INVALID_LICENSE_KEY",
      status: 401,
      message: "Invalid license key.",
    });
  }

  await enforceLicenseActiveOrThrow(env.DB, license, ctx, null, device.deviceId);

  // Upsert the client device record in `devices`
  await env.DB.prepare(
    `INSERT INTO devices (
       id, device_fingerprint, device_name, platform, os_version, arch,
       last_app_version, first_seen_at, last_seen_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
     ON CONFLICT(id) DO UPDATE SET
       device_fingerprint = excluded.device_fingerprint,
       device_name = excluded.device_name,
       platform = excluded.platform,
       os_version = excluded.os_version,
       arch = excluded.arch,
       last_app_version = excluded.last_app_version,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`
  )
    .bind(
      device.deviceId,
      device.deviceFingerprint,
      device.deviceName,
      device.platform,
      device.osVersion,
      device.arch,
      device.appVersion,
      ctx.nowIso
    )
    .run();

  // Check if this device_id OR this device_fingerprint already holds an active slot on this license
  const existingActivation = await env.DB.prepare(
    `SELECT * FROM activations
     WHERE license_id = ?1
       AND status = 'active'
       AND (device_id = ?2 OR device_fingerprint = ?3)
     ORDER BY CASE WHEN device_id = ?2 THEN 0 ELSE 1 END ASC
     LIMIT 1`
  )
    .bind(license.id, device.deviceId, device.deviceFingerprint)
    .first<ActivationRow>();

  if (existingActivation) {
    // Idempotent Re-Activation or Reinstall Recovery on the same physical machine
    const isReinstallRebind = existingActivation.device_id !== device.deviceId;
    const { activationToken, tokenPrefix } = generateActivationToken(existingActivation.id);
    const tokenHash = await hashActivationToken(activationToken);

    const updatedStatus =
      license.status === "pending_activation" ? "active" : license.status;
    const updatedLicense: LicenseRow = {
      ...license,
      status: updatedStatus,
      activated_at: license.activated_at ?? ctx.nowIso,
    };

    const leasePayload = buildSignedLeasePayload({
      env,
      now: ctx.now,
      license: updatedLicense,
      activationId: existingActivation.id,
      deviceId: device.deviceId,
      deviceFingerprint: device.deviceFingerprint,
    });
    const leaseToken = await signEntitlementLease(
      leasePayload,
      env.LICENSE_SIGNING_PRIVATE_KEY_JWK
    );

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE activations
         SET device_id = ?2,
             device_fingerprint = ?3,
             device_name_snapshot = ?4,
             app_version_snapshot = ?5,
             token_prefix = ?6,
             token_hash = ?7,
             last_lease_jti = ?8,
             last_lease_issued_at = ?9,
             last_lease_expires_at = ?10,
             last_validated_at = ?9,
             last_seen_ip_hash = ?11,
             updated_at = ?9
         WHERE id = ?1`
      ).bind(
        existingActivation.id,
        device.deviceId,
        device.deviceFingerprint,
        device.deviceName,
        device.appVersion,
        tokenPrefix,
        tokenHash,
        leasePayload.jti,
        ctx.nowIso,
        leasePayload.exp,
        ctx.ipHash
      ),
      env.DB.prepare(
        `UPDATE licenses
         SET status = CASE WHEN status = 'pending_activation' THEN 'active' ELSE status END,
             activated_at = COALESCE(activated_at, ?2),
             updated_at = ?2
         WHERE id = ?1`
      ).bind(license.id, ctx.nowIso),
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId: license.id,
        activationId: existingActivation.id,
        deviceId: device.deviceId,
        eventType: isReinstallRebind
          ? "license.rebound_on_reinstall"
          : "license.activated",
        actorType: "client",
        actorId: device.deviceId,
        previousStatus: license.status,
        newStatus: updatedStatus,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: {
          idempotent_reactivation: !isReinstallRebind,
          rebound_previous_device_id: isReinstallRebind
            ? existingActivation.device_id
            : undefined,
          device_name: device.deviceName,
          app_version: device.appVersion,
        },
      }),
    ]);

    return jsonResponse(
      {
        ok: true,
        activation_id: existingActivation.id,
        activation_token: activationToken,
        license: formatLicenseSummary(updatedLicense),
        lease: leasePayload,
        lease_token: leaseToken,
        server_time: ctx.nowIso,
      },
      200,
      { "X-Request-Id": ctx.requestId }
    );
  }

  // New device slot allocation — Atomic conditional increment on `licenses`
  const slotClaimResult = await env.DB.prepare(
    `UPDATE licenses
     SET active_devices_count = active_devices_count + 1,
         status = CASE WHEN status = 'pending_activation' THEN 'active' ELSE status END,
         activated_at = COALESCE(activated_at, ?2),
         updated_at = ?2
     WHERE id = ?1
       AND status IN ('pending_activation', 'active', 'past_due')
       AND active_devices_count < device_limit`
  )
    .bind(license.id, ctx.nowIso)
    .run();

  if ((slotClaimResult.meta?.changes ?? 0) === 0) {
    // Re-read license to provide accurate details and audit log
    const currentLicense =
      (await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
        .bind(license.id)
        .first<LicenseRow>()) ?? license;

    await enforceLicenseActiveOrThrow(
      env.DB,
      currentLicense,
      ctx,
      null,
      device.deviceId
    );

    const activeDevices = await listActiveDevicesForLicense(
      env.DB,
      currentLicense.id,
      device.deviceId
    );

    await prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId: currentLicense.id,
      deviceId: device.deviceId,
      eventType: "license.device_limit_rejected",
      actorType: "client",
      actorId: device.deviceId,
      previousStatus: currentLicense.status,
      newStatus: currentLicense.status,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: {
        device_limit: currentLicense.device_limit,
        devices_used: currentLicense.active_devices_count,
        attempted_device_name: device.deviceName,
      },
    }).run();

    throw new ApiError({
      code: "DEVICE_LIMIT_REACHED",
      status: 409,
      message: `Maximum active device limit (${currentLicense.device_limit}) reached for this license.`,
      retryable: false,
      details: {
        device_limit: currentLicense.device_limit,
        devices_used: currentLicense.active_devices_count,
        active_devices: activeDevices,
      },
    });
  }

  // Slot claimed atomically! Now insert activation record and generate signed lease.
  const activationId = generatePrefixedId("act", ctx.now.getTime());
  const { activationToken, tokenPrefix } = generateActivationToken(activationId);
  const tokenHash = await hashActivationToken(activationToken);

  const updatedLicense: LicenseRow = {
    ...license,
    status: license.status === "pending_activation" ? "active" : license.status,
    activated_at: license.activated_at ?? ctx.nowIso,
    active_devices_count: license.active_devices_count + 1,
    updated_at: ctx.nowIso,
  };

  const leasePayload = buildSignedLeasePayload({
    env,
    now: ctx.now,
    license: updatedLicense,
    activationId,
    deviceId: device.deviceId,
    deviceFingerprint: device.deviceFingerprint,
  });
  const leaseToken = await signEntitlementLease(
    leasePayload,
    env.LICENSE_SIGNING_PRIVATE_KEY_JWK
  );

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO activations (
           id, license_id, device_id, device_fingerprint,
           device_name_snapshot, app_version_snapshot,
           token_prefix, token_hash, status,
           last_lease_jti, last_lease_issued_at, last_lease_expires_at,
           activated_at, last_validated_at, last_seen_ip_hash,
           created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4,
           ?5, ?6,
           ?7, ?8, 'active',
           ?9, ?10, ?11,
           ?10, ?10, ?12,
           ?10, ?10
         )`
      ).bind(
        activationId,
        updatedLicense.id,
        device.deviceId,
        device.deviceFingerprint,
        device.deviceName,
        device.appVersion,
        tokenPrefix,
        tokenHash,
        leasePayload.jti,
        ctx.nowIso,
        leasePayload.exp,
        ctx.ipHash
      ),
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId: updatedLicense.id,
        activationId,
        deviceId: device.deviceId,
        eventType: "license.activated",
        actorType: "client",
        actorId: device.deviceId,
        previousStatus: license.status,
        newStatus: updatedLicense.status,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: {
          device_name: device.deviceName,
          platform: device.platform,
          app_version: device.appVersion,
          devices_used: updatedLicense.active_devices_count,
          device_limit: updatedLicense.device_limit,
        },
      }),
    ]);
  } catch (err) {
    // Compensating rollback if unique constraint was triggered concurrently
    await env.DB.prepare(
      "UPDATE licenses SET active_devices_count = MAX(0, active_devices_count - 1), updated_at = ?2 WHERE id = ?1"
    )
      .bind(license.id, ctx.nowIso)
      .run();
    throw err;
  }

  return jsonResponse(
    {
      ok: true,
      activation_id: activationId,
      activation_token: activationToken,
      license: formatLicenseSummary(updatedLicense),
      lease: leasePayload,
      lease_token: leaseToken,
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/licenses/validate
 */
export async function handleValidateLicense(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  validateClientHeaders(request, env, ctx);
  const nowEpochSec = Math.floor(ctx.now.getTime() / 1000);

  // Per-IP validation rate limit: 60 req / 60s
  await checkRateLimit({
    db: env.DB,
    bucketKey: `val_ip:${ctx.ipHash}`,
    nowEpochSec,
    windowSeconds: 60,
    maxAttempts: 60,
  });

  const bearerToken = extractBearerToken(request);
  if (!bearerToken || !bearerToken.startsWith("ssact_")) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Missing or invalid Bearer activation token.",
    });
  }

  const body = await parseJsonBody<{
    activation_id?: unknown;
    device?: unknown;
  }>(request);

  const device = validateDeviceInput(body.device, false);
  const tokenHash = await hashActivationToken(bearerToken);

  const activation = await env.DB.prepare(
    "SELECT * FROM activations WHERE token_hash = ?1"
  )
    .bind(tokenHash)
    .first<ActivationRow>();

  if (!activation || !constantTimeEqual(activation.token_hash, tokenHash)) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Invalid activation token.",
    });
  }

  if (
    typeof body.activation_id === "string" &&
    body.activation_id.trim().length > 0 &&
    body.activation_id.trim() !== activation.id
  ) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Activation ID does not match the provided activation token.",
    });
  }

  if (activation.status !== "active") {
    throw new ApiError({
      code: "ACTIVATION_REVOKED",
      status: 403,
      message: `This device activation is no longer active (status: ${activation.status}).`,
      retryable: false,
    });
  }

  if (
    activation.device_id !== device.deviceId ||
    activation.device_fingerprint !== device.deviceFingerprint
  ) {
    throw new ApiError({
      code: "DEVICE_MISMATCH",
      status: 403,
      message: "Device identity does not match the bound activation slot.",
      retryable: false,
    });
  }

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(activation.license_id)
    .first<LicenseRow>();

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: "Associated license record was not found.",
    });
  }

  await enforceLicenseActiveOrThrow(
    env.DB,
    license,
    ctx,
    activation.id,
    device.deviceId
  );

  const leasePayload = buildSignedLeasePayload({
    env,
    now: ctx.now,
    license,
    activationId: activation.id,
    deviceId: device.deviceId,
    deviceFingerprint: device.deviceFingerprint,
  });
  const leaseToken = await signEntitlementLease(
    leasePayload,
    env.LICENSE_SIGNING_PRIVATE_KEY_JWK
  );

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE activations
       SET app_version_snapshot = ?2,
           last_lease_jti = ?3,
           last_lease_issued_at = ?4,
           last_lease_expires_at = ?5,
           last_validated_at = ?4,
           last_seen_ip_hash = ?6,
           updated_at = ?4
       WHERE id = ?1`
    ).bind(
      activation.id,
      device.appVersion,
      leasePayload.jti,
      ctx.nowIso,
      leasePayload.exp,
      ctx.ipHash
    ),
    env.DB.prepare(
      "UPDATE devices SET last_app_version = ?2, last_seen_at = ?3, updated_at = ?3 WHERE id = ?1"
    ).bind(device.deviceId, device.appVersion, ctx.nowIso),
    prepareLicenseEventStatement(env.DB, {
      now: ctx.now,
      nowIso: ctx.nowIso,
      licenseId: license.id,
      activationId: activation.id,
      deviceId: device.deviceId,
      eventType: "license.validated",
      actorType: "client",
      actorId: device.deviceId,
      previousStatus: license.status,
      newStatus: license.status,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      metadata: {
        lease_jti: leasePayload.jti,
        lease_exp: leasePayload.exp,
        app_version: device.appVersion,
      },
    }),
  ]);

  return jsonResponse(
    {
      ok: true,
      activation_id: activation.id,
      license: formatLicenseSummary(license),
      lease: leasePayload,
      lease_token: leaseToken,
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/licenses/deactivate
 * Supports:
 * 1) Self-deactivation or remote slot deactivation via Bearer activation_token
 * 2) Remote lost-device deactivation via license_key + target_activation_id
 */
export async function handleDeactivateLicense(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  validateClientHeaders(request, env, ctx);
  const nowEpochSec = Math.floor(ctx.now.getTime() / 1000);

  await checkRateLimit({
    db: env.DB,
    bucketKey: `deact_ip:${ctx.ipHash}`,
    nowEpochSec,
    windowSeconds: 60,
    maxAttempts: 20,
  });

  const body = await parseJsonBody<{
    device_id?: unknown;
    target_activation_id?: unknown;
    license_key?: unknown;
    reason?: unknown;
  }>(request);

  const bearerToken = extractBearerToken(request);
  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim().slice(0, 200)
      : "client_requested_deactivation";

  let license: LicenseRow | null = null;
  let targetActivation: ActivationRow | null = null;
  let deactivatedBy = "client_self";

  if (bearerToken && bearerToken.startsWith("ssact_")) {
    const tokenHash = await hashActivationToken(bearerToken);
    const callerActivation = await env.DB.prepare(
      "SELECT * FROM activations WHERE token_hash = ?1"
    )
      .bind(tokenHash)
      .first<ActivationRow>();

    if (!callerActivation || !constantTimeEqual(callerActivation.token_hash, tokenHash)) {
      throw new ApiError({
        code: "UNAUTHORIZED_TOKEN",
        status: 401,
        message: "Invalid activation token.",
      });
    }

    license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(callerActivation.license_id)
      .first<LicenseRow>();

    const requestedTargetId =
      typeof body.target_activation_id === "string" &&
      body.target_activation_id.trim().length > 0
        ? body.target_activation_id.trim()
        : callerActivation.id;

    if (requestedTargetId === callerActivation.id) {
      targetActivation = callerActivation;
      deactivatedBy = "client_self";
    } else {
      targetActivation = await env.DB.prepare(
        "SELECT * FROM activations WHERE id = ?1 AND license_id = ?2"
      )
        .bind(requestedTargetId, callerActivation.license_id)
        .first<ActivationRow>();
      deactivatedBy = "client_key_owner";
    }
  } else if (body.license_key !== undefined) {
    const keyInfo = normalizeAndValidateLicenseKey(body.license_key);
    if (!keyInfo) {
      throw new ApiError({
        code: "INVALID_LICENSE_KEY",
        status: 401,
        message: "Invalid license key format.",
      });
    }
    const keyHash = await hashLicenseKey(env.LICENSE_KEY_PEPPER, keyInfo.normalizedKey);
    license = await env.DB.prepare("SELECT * FROM licenses WHERE key_hash = ?1")
      .bind(keyHash)
      .first<LicenseRow>();

    if (!license || !constantTimeEqual(license.key_hash, keyHash)) {
      throw new ApiError({
        code: "INVALID_LICENSE_KEY",
        status: 401,
        message: "Invalid license key.",
      });
    }

    const requestedTargetId =
      typeof body.target_activation_id === "string"
        ? body.target_activation_id.trim()
        : "";
    const requestedDeviceId =
      typeof body.device_id === "string" ? body.device_id.trim().toLowerCase() : "";

    if (requestedTargetId) {
      targetActivation = await env.DB.prepare(
        "SELECT * FROM activations WHERE id = ?1 AND license_id = ?2"
      )
        .bind(requestedTargetId, license.id)
        .first<ActivationRow>();
    } else if (requestedDeviceId) {
      targetActivation = await env.DB.prepare(
        "SELECT * FROM activations WHERE license_id = ?1 AND device_id = ?2 ORDER BY activated_at DESC LIMIT 1"
      )
        .bind(license.id, requestedDeviceId)
        .first<ActivationRow>();
    } else {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "Either 'target_activation_id' or 'device_id' must be provided.",
      });
    }
    deactivatedBy = "client_key_owner";
  } else {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message:
        "Authentication required: provide Bearer activation_token or license_key.",
    });
  }

  if (!license || !targetActivation) {
    throw new ApiError({
      code: "ACTIVATION_NOT_FOUND",
      status: 404,
      message: "Target device activation was not found for this license.",
    });
  }

  // Idempotent return if already deactivated/revoked
  if (targetActivation.status !== "active") {
    return jsonResponse(
      {
        ok: true,
        deactivated_activation_id: targetActivation.id,
        already_deactivated: true,
        license_id: license.id,
        device_limit: license.device_limit,
        devices_used: license.active_devices_count,
        deactivated_at: targetActivation.deactivated_at ?? ctx.nowIso,
        server_time: ctx.nowIso,
      },
      200,
      { "X-Request-Id": ctx.requestId }
    );
  }

  const updateAct = await env.DB.prepare(
    `UPDATE activations
     SET status = 'deactivated',
         deactivated_at = ?2,
         deactivated_by = ?3,
         deactivation_reason = ?4,
         updated_at = ?2
     WHERE id = ?1 AND status = 'active'`
  )
    .bind(targetActivation.id, ctx.nowIso, deactivatedBy, reason)
    .run();

  let newDevicesUsed = license.active_devices_count;
  if ((updateAct.meta?.changes ?? 0) === 1) {
    newDevicesUsed = Math.max(0, license.active_devices_count - 1);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE licenses SET active_devices_count = MAX(0, active_devices_count - 1), updated_at = ?2 WHERE id = ?1"
      ).bind(license.id, ctx.nowIso),
      prepareLicenseEventStatement(env.DB, {
        now: ctx.now,
        nowIso: ctx.nowIso,
        licenseId: license.id,
        activationId: targetActivation.id,
        deviceId: targetActivation.device_id,
        eventType: "license.deactivated",
        actorType: "client",
        actorId: targetActivation.device_id,
        previousStatus: license.status,
        newStatus: license.status,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
        metadata: {
          deactivated_by: deactivatedBy,
          reason,
          devices_used: newDevicesUsed,
        },
      }),
    ]);
  }

  return jsonResponse(
    {
      ok: true,
      deactivated_activation_id: targetActivation.id,
      already_deactivated: false,
      license_id: license.id,
      device_limit: license.device_limit,
      devices_used: newDevicesUsed,
      deactivated_at: ctx.nowIso,
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * GET /v1/licenses/devices
 */
export async function handleListLicenseDevices(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  validateClientHeaders(request, env, ctx);
  const url = new URL(request.url);
  const currentDeviceId = url.searchParams.get("device_id")?.trim().toLowerCase() ?? null;

  const bearerToken = extractBearerToken(request);
  const headerLicenseKey = request.headers.get("X-License-Key");

  let license: LicenseRow | null = null;
  let resolvedCurrentDeviceId = currentDeviceId;

  if (bearerToken && bearerToken.startsWith("ssact_")) {
    const tokenHash = await hashActivationToken(bearerToken);
    const activation = await env.DB.prepare(
      "SELECT * FROM activations WHERE token_hash = ?1"
    )
      .bind(tokenHash)
      .first<ActivationRow>();

    if (!activation || !constantTimeEqual(activation.token_hash, tokenHash)) {
      throw new ApiError({
        code: "UNAUTHORIZED_TOKEN",
        status: 401,
        message: "Invalid activation token.",
      });
    }

    if (!resolvedCurrentDeviceId) {
      resolvedCurrentDeviceId = activation.device_id;
    }

    license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
      .bind(activation.license_id)
      .first<LicenseRow>();
  } else if (headerLicenseKey) {
    const keyInfo = normalizeAndValidateLicenseKey(headerLicenseKey);
    if (!keyInfo) {
      throw new ApiError({
        code: "INVALID_LICENSE_KEY",
        status: 401,
        message: "Invalid X-License-Key header format.",
      });
    }
    const keyHash = await hashLicenseKey(env.LICENSE_KEY_PEPPER, keyInfo.normalizedKey);
    license = await env.DB.prepare("SELECT * FROM licenses WHERE key_hash = ?1")
      .bind(keyHash)
      .first<LicenseRow>();

    if (!license || !constantTimeEqual(license.key_hash, keyHash)) {
      throw new ApiError({
        code: "INVALID_LICENSE_KEY",
        status: 401,
        message: "Invalid license key.",
      });
    }
  } else {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message:
        "Authentication required: provide Bearer activation_token or X-License-Key header.",
    });
  }

  if (!license) {
    throw new ApiError({
      code: "LICENSE_NOT_FOUND",
      status: 404,
      message: "License not found.",
    });
  }

  const devices = await listActiveDevicesForLicense(
    env.DB,
    license.id,
    resolvedCurrentDeviceId
  );

  return jsonResponse(
    {
      ok: true,
      license_id: license.id,
      key_prefix: license.key_prefix,
      license_type: license.license_type,
      billing_interval: license.billing_interval,
      status: license.status,
      device_limit: license.device_limit,
      devices_used: license.active_devices_count,
      devices,
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}
