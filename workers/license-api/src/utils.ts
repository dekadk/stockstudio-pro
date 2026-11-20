// =============================================================================
// StockStudio Pro License API (v0.2.0) — Validation, Rate Limiting & Audit Helpers
// =============================================================================

import { ApiError } from "./errors";
import {
  Env,
  LicenseEntitlements,
  LicenseEventType,
  LicenseRow,
  PlatformType,
  RequestContext,
  SignedLeasePayload,
} from "./types";
import { generatePrefixedId } from "./crypto";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;

export const DEFAULT_ENTITLEMENTS: LicenseEntitlements = {
  features: [
    "google_flow_workspace",
    "multi_account_manager",
    "unlimited_accounts",
  ],
  max_accounts: null,
  updates_until: null,
  max_app_version: null,
};

export function getExpectedProductId(env: Env): string {
  return env.PRODUCT_ID?.trim() || "com.stockstudiopro.desktop";
}

export function getIssuer(env: Env): string {
  return env.ISSUER?.trim() || "stockstudiopro-license-server";
}

export function getDefaultDeviceLimit(env: Env): number {
  const parsed = Number.parseInt(env.DEFAULT_DEVICE_LIMIT ?? "2", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 2;
}

export function getLeaseTtlDays(env: Env): number {
  const parsed = Number.parseInt(env.LEASE_TTL_DAYS ?? "7", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 30 ? parsed : 7;
}

export function getMaxClockSkewSeconds(env: Env): number {
  const parsed = Number.parseInt(env.MAX_CLOCK_SKEW_SECONDS ?? "300", 10);
  return Number.isFinite(parsed) && parsed >= 30 ? parsed : 300;
}

export function getSigningKid(env: Env): string {
  return env.LICENSE_SIGNING_KID?.trim() || "sspro-ed25519-2026-01";
}

/**
 * Validates client product header and request timestamp skew for public endpoints.
 */
export function validateClientHeaders(
  request: Request,
  env: Env,
  ctx: RequestContext
): void {
  const expectedProduct = getExpectedProductId(env);
  const clientProduct = request.headers.get("X-Client-Product")?.trim();

  if (!clientProduct || clientProduct !== expectedProduct) {
    throw new ApiError({
      code: "PRODUCT_MISMATCH",
      status: 400,
      message: `Invalid or missing X-Client-Product header. Expected '${expectedProduct}'.`,
    });
  }

  const timestampHeader = request.headers.get("X-Request-Timestamp")?.trim();
  if (timestampHeader) {
    const clientEpochSec = Number.parseInt(timestampHeader, 10);
    if (!Number.isFinite(clientEpochSec)) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "X-Request-Timestamp must be a valid Unix epoch timestamp in seconds.",
      });
    }
    const serverEpochSec = Math.floor(ctx.now.getTime() / 1000);
    const maxSkew = getMaxClockSkewSeconds(env);
    const skew = Math.abs(serverEpochSec - clientEpochSec);
    if (skew > maxSkew) {
      throw new ApiError({
        code: "CLOCK_SKEW_TOO_LARGE",
        status: 400,
        message: `Client clock skew (${skew}s) exceeds maximum allowed threshold (${maxSkew}s).`,
        details: {
          max_skew_seconds: maxSkew,
          observed_skew_seconds: skew,
        },
      });
    }
  }
}

export async function parseJsonBody<T = Record<string, unknown>>(
  request: Request
): Promise<T> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Content-Type must be application/json.",
    });
  }
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Body must be a JSON object");
    }
    return parsed as T;
  } catch {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Malformed JSON request body.",
    });
  }
}

export interface ValidatedDeviceInput {
  deviceId: string;
  deviceFingerprint: string;
  deviceName: string;
  platform: PlatformType;
  osVersion: string | null;
  arch: string | null;
  appVersion: string;
}

export function validateDeviceInput(
  rawDevice: unknown,
  requireFullMetadata = true
): ValidatedDeviceInput {
  if (!rawDevice || typeof rawDevice !== "object" || Array.isArray(rawDevice)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Missing or invalid 'device' object.",
    });
  }

  const d = rawDevice as Record<string, unknown>;
  const deviceId = typeof d.device_id === "string" ? d.device_id.trim().toLowerCase() : "";
  if (!UUID_V4_REGEX.test(deviceId)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'device.device_id' must be a valid UUID v4.",
    });
  }

  const fp =
    typeof d.device_fingerprint === "string"
      ? d.device_fingerprint.trim().toLowerCase()
      : "";
  if (!SHA256_HEX_REGEX.test(fp)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'device.device_fingerprint' must be a 64-character hex SHA-256 digest.",
    });
  }

  let deviceName =
    typeof d.device_name === "string"
      ? d.device_name.replace(/[\u0000-\u001F\u007F]/g, "").trim()
      : "";
  if (requireFullMetadata && !deviceName) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'device.device_name' is required and cannot be empty.",
    });
  }
  if (!deviceName) {
    deviceName = "StockStudio-Desktop";
  }
  if (deviceName.length > 120) {
    deviceName = deviceName.slice(0, 120);
  }

  const rawPlatform =
    typeof d.platform === "string" ? d.platform.trim().toLowerCase() : "windows";
  if (
    rawPlatform !== "windows" &&
    rawPlatform !== "macos" &&
    rawPlatform !== "linux"
  ) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'device.platform' must be one of: windows, macos, linux.",
    });
  }

  const appVersion =
    typeof d.app_version === "string" && d.app_version.trim().length > 0
      ? d.app_version.trim().slice(0, 32)
      : "0.2.0";

  const osVersion =
    typeof d.os_version === "string" && d.os_version.trim().length > 0
      ? d.os_version.trim().slice(0, 64)
      : null;

  const arch =
    typeof d.arch === "string" && d.arch.trim().length > 0
      ? d.arch.trim().slice(0, 32)
      : null;

  return {
    deviceId,
    deviceFingerprint: fp,
    deviceName,
    platform: rawPlatform,
    osVersion,
    arch,
    appVersion,
  };
}

export function parseEntitlements(
  license: Pick<LicenseRow, "entitlements_json" | "updates_until" | "max_app_version">
): LicenseEntitlements {
  try {
    const parsed = JSON.parse(license.entitlements_json) as Partial<LicenseEntitlements>;
    return {
      features: Array.isArray(parsed.features)
        ? parsed.features.map(String)
        : DEFAULT_ENTITLEMENTS.features,
      max_accounts:
        typeof parsed.max_accounts === "number" ? parsed.max_accounts : null,
      updates_until:
        license.updates_until ??
        (typeof parsed.updates_until === "string" ? parsed.updates_until : null),
      max_app_version:
        license.max_app_version ??
        (typeof parsed.max_app_version === "string" ? parsed.max_app_version : null),
    };
  } catch {
    return {
      ...DEFAULT_ENTITLEMENTS,
      updates_until: license.updates_until,
      max_app_version: license.max_app_version,
    };
  }
}

export function formatLicenseSummary(license: LicenseRow): Record<string, unknown> {
  return {
    license_id: license.id,
    key_prefix: license.key_prefix,
    plan_code: license.plan_code,
    plan_name: license.plan_name,
    license_type: license.license_type,
    billing_interval: license.billing_interval,
    status: license.status,
    lifetime: license.license_type === "perpetual",
    expires_at: license.expires_at,
    current_period_start: license.current_period_start,
    current_period_end: license.current_period_end,
    cancel_at_period_end: license.cancel_at_period_end === 1,
    device_limit: license.device_limit,
    devices_used: license.active_devices_count,
    entitlements: parseEntitlements(license),
  };
}

/**
 * Computes the signed lease payload for an active license & device binding.
 * For subscriptions, lease expiration is capped by license.expires_at (or grace_until).
 */
export function buildSignedLeasePayload(options: {
  env: Env;
  now: Date;
  license: LicenseRow;
  activationId: string;
  deviceId: string;
  deviceFingerprint: string;
  leaseJti?: string;
}): SignedLeasePayload {
  const { env, now, license, activationId, deviceId, deviceFingerprint } = options;
  const ttlDays = getLeaseTtlDays(env);
  const defaultLeaseExpMs = now.getTime() + ttlDays * 24 * 60 * 60 * 1000;

  let effectiveExpMs = defaultLeaseExpMs;
  if (license.license_type === "subscription" && license.expires_at) {
    const licenseCutoffIso = license.grace_until ?? license.expires_at;
    const licenseExpMs = Date.parse(licenseCutoffIso);
    if (Number.isFinite(licenseExpMs)) {
      effectiveExpMs = Math.min(defaultLeaseExpMs, licenseExpMs);
    }
  }

  const iatIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const expIso = new Date(effectiveExpMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const jti = options.leaseJti ?? generatePrefixedId("lse", now.getTime());

  return {
    ver: 1,
    kid: getSigningKid(env),
    jti,
    iss: getIssuer(env),
    aud: getExpectedProductId(env),
    iat: iatIso,
    exp: expIso,
    offline_grace_until: expIso,
    license_id: license.id,
    activation_id: activationId,
    device_id: deviceId,
    device_fingerprint: deviceFingerprint,
    plan_code: license.plan_code,
    plan_name: license.plan_name,
    license_type: license.license_type,
    billing_interval: license.billing_interval,
    status: license.status,
    lifetime: license.license_type === "perpetual",
    expires_at: license.expires_at,
    current_period_start: license.current_period_start,
    current_period_end: license.current_period_end,
    cancel_at_period_end: license.cancel_at_period_end === 1,
    device_limit: license.device_limit,
    devices_used: license.active_devices_count,
    entitlements: parseEntitlements(license),
  };
}

/**
 * Checks whether a subscription license has passed its expiration / grace window.
 */
export function isSubscriptionExpired(license: LicenseRow, now: Date): boolean {
  if (license.license_type !== "subscription") {
    return false;
  }
  const cutoffIso = license.grace_until ?? license.expires_at;
  if (!cutoffIso) {
    return true;
  }
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) {
    return true;
  }
  return now.getTime() >= cutoffMs;
}

/**
 * Enforces D1-backed rate limiting and lockout buckets.
 */
export async function checkRateLimit(options: {
  db: D1Database;
  bucketKey: string;
  nowEpochSec: number;
  windowSeconds: number;
  maxAttempts: number;
  lockoutSeconds?: number;
}): Promise<void> {
  const { db, bucketKey, nowEpochSec, windowSeconds, maxAttempts, lockoutSeconds } =
    options;
  const alignedWindow = Math.floor(nowEpochSec / windowSeconds) * windowSeconds;

  const existing = await db
    .prepare(
      "SELECT bucket_key, window_start, attempt_count, locked_until FROM rate_limit_buckets WHERE bucket_key = ?1"
    )
    .bind(bucketKey)
    .first<{
      bucket_key: string;
      window_start: number;
      attempt_count: number;
      locked_until: number | null;
    }>();

  if (existing) {
    if (existing.locked_until && existing.locked_until > nowEpochSec) {
      const retryAfter = existing.locked_until - nowEpochSec;
      throw new ApiError({
        code: "RATE_LIMITED",
        status: 429,
        message: "Too many requests. Please wait before trying again.",
        retryable: true,
        details: { retry_after_seconds: retryAfter },
        headers: { "Retry-After": String(retryAfter) },
      });
    }

    if (existing.window_start === alignedWindow) {
      const nextCount = existing.attempt_count + 1;
      const shouldLock = nextCount > maxAttempts;
      const lockedUntil =
        shouldLock && lockoutSeconds ? nowEpochSec + lockoutSeconds : null;

      await db
        .prepare(
          "UPDATE rate_limit_buckets SET attempt_count = ?2, locked_until = COALESCE(?3, locked_until), updated_at = ?4 WHERE bucket_key = ?1"
        )
        .bind(bucketKey, nextCount, lockedUntil, nowEpochSec)
        .run();

      if (shouldLock) {
        const retryAfter =
          lockedUntil !== null
            ? lockedUntil - nowEpochSec
            : alignedWindow + windowSeconds - nowEpochSec;
        throw new ApiError({
          code: "RATE_LIMITED",
          status: 429,
          message: "Rate limit exceeded. Please try again later.",
          retryable: true,
          details: { retry_after_seconds: Math.max(1, retryAfter) },
          headers: { "Retry-After": String(Math.max(1, retryAfter)) },
        });
      }
      return;
    }
  }

  await db
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, attempt_count, locked_until, updated_at)
       VALUES (?1, ?2, 1, NULL, ?3)
       ON CONFLICT(bucket_key) DO UPDATE SET
         window_start = excluded.window_start,
         attempt_count = 1,
         locked_until = NULL,
         updated_at = excluded.updated_at`
    )
    .bind(bucketKey, alignedWindow, nowEpochSec)
    .run();
}

/**
 * Creates a prepared statement to append an audit entry into `license_events`.
 * Never includes plaintext license keys, tokens, or secrets.
 */
export function prepareLicenseEventStatement(
  db: D1Database,
  options: {
    now: Date;
    nowIso: string;
    licenseId: string | null;
    activationId?: string | null;
    deviceId?: string | null;
    eventType: LicenseEventType;
    actorType: "client" | "admin" | "billing_webhook" | "system";
    actorId?: string | null;
    previousStatus?: string | null;
    newStatus?: string | null;
    ipHash?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  }
): D1PreparedStatement {
  const eventId = generatePrefixedId("lev", options.now.getTime());
  return db
    .prepare(
      `INSERT INTO license_events (
        id, license_id, activation_id, device_id, event_type,
        actor_type, actor_id, previous_status, new_status,
        ip_hash, user_agent, metadata_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
    .bind(
      eventId,
      options.licenseId,
      options.activationId ?? null,
      options.deviceId ?? null,
      options.eventType,
      options.actorType,
      options.actorId ?? null,
      options.previousStatus ?? null,
      options.newStatus ?? null,
      options.ipHash ?? null,
      options.userAgent ?? null,
      JSON.stringify(options.metadata ?? {}),
      options.nowIso
    );
}
