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
  ProductEntitlementId,
  RequestContext,
  SignedLeasePayload,
  SUPPORTED_PRODUCT_ENTITLEMENTS,
} from "./types";
import { generatePrefixedId } from "./crypto";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const SUPPORTED_PRODUCT_SET = new Set<string>(SUPPORTED_PRODUCT_ENTITLEMENTS);
const IPV4_OCTET_REGEX = /^(0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP_REGEX = /^[0-9a-f]{1,4}$/i;

function parseIpv4Octets(raw: string): number[] | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET_REGEX.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Validates and canonicalizes an IPv4 or IPv6 address for deterministic comparison.
 * - IPv4 -> canonical dotted-decimal ("203.0.113.10")
 * - IPv6 -> canonical expanded 8-hextet lowercase ("2001:0db8:0000:0000:0000:0000:0000:0001")
 * - Rejects malformed strings, ports, CIDR suffixes, and zone IDs (returns null).
 */
export function canonicalizeIpAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64 || /\s/.test(trimmed)) return null;

  // IPv4 check
  if (!trimmed.includes(":")) {
    const octets = parseIpv4Octets(trimmed);
    return octets ? octets.join(".") : null;
  }

  // IPv6 check (reject brackets, zone IDs, slashes)
  if (trimmed.includes("[") || trimmed.includes("]") || trimmed.includes("%") || trimmed.includes("/")) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const doubleColonParts = lower.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const parseGroups = (segment: string, allowEmbeddedIpv4: boolean): string[] | null => {
    if (segment === "") return [];
    const tokens = segment.split(":");
    const groups: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const isLast = i === tokens.length - 1;
      if (isLast && allowEmbeddedIpv4 && token.includes(".")) {
        const octets = parseIpv4Octets(token);
        if (!octets) return null;
        const hi = ((octets[0] << 8) | octets[1]).toString(16).padStart(4, "0");
        const lo = ((octets[2] << 8) | octets[3]).toString(16).padStart(4, "0");
        groups.push(hi, lo);
      } else {
        if (!IPV6_GROUP_REGEX.test(token)) return null;
        groups.push(token.padStart(4, "0"));
      }
    }
    return groups;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroups(doubleColonParts[0], true);
    if (!groups || groups.length !== 8) return null;
    return groups.join(":");
  }

  const left = parseGroups(doubleColonParts[0], false);
  const right = parseGroups(doubleColonParts[1], true);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  const zeros = new Array<string>(missing).fill("0000");
  return [...left, ...zeros, ...right].join(":");
}

/**
 * Resolves the trusted client IP according to environment:
 * - production / staging: trusts `CF-Connecting-IP` EXCLUSIVELY (never `X-Forwarded-For`
 *   and never substitutes `127.0.0.1`). Returns null if missing or malformed.
 * - development: checks `CF-Connecting-IP`, then `X-Forwarded-For` first entry, then `127.0.0.1`.
 */
export function resolveClientIp(request: Request, env: Env): string | null {
  const environment = (env.ENVIRONMENT ?? "development").toLowerCase();
  const cfIp = request.headers.get("CF-Connecting-IP");

  if (environment === "production" || environment === "staging") {
    return canonicalizeIpAddress(cfIp);
  }

  if (cfIp !== null && cfIp.trim().length > 0) {
    return canonicalizeIpAddress(cfIp);
  }

  const xffFirst = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
  if (xffFirst) {
    return canonicalizeIpAddress(xffFirst);
  }

  return "127.0.0.1";
}

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

export function validateAndNormalizeProducts(
  rawProducts: unknown
): ProductEntitlementId[] {
  if (!Array.isArray(rawProducts)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message:
        "'entitlements.products' must be an array of supported product identifiers.",
    });
  }

  const normalized: ProductEntitlementId[] = [];
  const seen = new Set<string>();

  for (const entry of rawProducts) {
    if (typeof entry !== "string") {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message:
          "Each entry in 'entitlements.products' must be a string product identifier.",
      });
    }
    const candidate = entry.trim().toLowerCase();
    if (!SUPPORTED_PRODUCT_SET.has(candidate)) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: `Unsupported product entitlement '${entry}'. Allowed products: ${SUPPORTED_PRODUCT_ENTITLEMENTS.join(", ")}.`,
      });
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      normalized.push(candidate as ProductEntitlementId);
    }
  }

  if (normalized.length === 0) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'entitlements.products' cannot be empty when specified.",
    });
  }

  return normalized;
}

export function validateEntitlementsInput(
  rawEntitlements: unknown,
  baseEntitlements?: LicenseEntitlements
): LicenseEntitlements {
  const base = baseEntitlements ?? DEFAULT_ENTITLEMENTS;
  if (rawEntitlements === undefined) {
    return {
      ...(base.products !== undefined ? { products: [...base.products] } : {}),
      features: [...base.features],
      max_accounts: base.max_accounts,
      updates_until: base.updates_until,
      max_app_version: base.max_app_version,
    };
  }

  if (
    !rawEntitlements ||
    typeof rawEntitlements !== "object" ||
    Array.isArray(rawEntitlements)
  ) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "'entitlements' must be a JSON object.",
    });
  }

  const rawEnt = rawEntitlements as Record<string, unknown>;

  let products: ProductEntitlementId[] | undefined =
    base.products !== undefined ? [...base.products] : undefined;
  if ("products" in rawEnt && rawEnt.products !== undefined) {
    products = validateAndNormalizeProducts(rawEnt.products);
  }

  let features = [...base.features];
  if ("features" in rawEnt && rawEnt.features !== undefined) {
    if (!Array.isArray(rawEnt.features)) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "'entitlements.features' must be an array of strings.",
      });
    }
    features = rawEnt.features.map((item) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new ApiError({
          code: "INVALID_REQUEST",
          status: 400,
          message:
            "Each entry in 'entitlements.features' must be a non-empty string.",
        });
      }
      return item.trim();
    });
  }

  let maxAccounts = base.max_accounts;
  if ("max_accounts" in rawEnt && rawEnt.max_accounts !== undefined) {
    if (rawEnt.max_accounts === null) {
      maxAccounts = null;
    } else if (
      typeof rawEnt.max_accounts === "number" &&
      Number.isInteger(rawEnt.max_accounts) &&
      rawEnt.max_accounts >= 1
    ) {
      maxAccounts = rawEnt.max_accounts;
    } else {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "'entitlements.max_accounts' must be a positive integer or null.",
      });
    }
  }

  let updatesUntil = base.updates_until;
  if ("updates_until" in rawEnt && rawEnt.updates_until !== undefined) {
    if (rawEnt.updates_until === null) {
      updatesUntil = null;
    } else if (typeof rawEnt.updates_until === "string") {
      updatesUntil = rawEnt.updates_until.trim() || null;
    } else {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "'entitlements.updates_until' must be a string or null.",
      });
    }
  }

  let maxAppVersion = base.max_app_version;
  if ("max_app_version" in rawEnt && rawEnt.max_app_version !== undefined) {
    if (rawEnt.max_app_version === null) {
      maxAppVersion = null;
    } else if (typeof rawEnt.max_app_version === "string") {
      maxAppVersion = rawEnt.max_app_version.trim() || null;
    } else {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "'entitlements.max_app_version' must be a string or null.",
      });
    }
  }

  return {
    ...(products !== undefined ? { products } : {}),
    features,
    max_accounts: maxAccounts,
    updates_until: updatesUntil,
    max_app_version: maxAppVersion,
  };
}

export function parseEntitlements(
  license: Pick<LicenseRow, "entitlements_json" | "updates_until" | "max_app_version">
): LicenseEntitlements {
  try {
    const parsed = JSON.parse(license.entitlements_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Entitlements JSON must be an object");
    }
    const obj = parsed as Partial<LicenseEntitlements> & { products?: unknown };

    let products: ProductEntitlementId[] | undefined;
    if (Array.isArray(obj.products)) {
      const seen = new Set<string>();
      const validProducts: ProductEntitlementId[] = [];
      for (const item of obj.products) {
        if (typeof item === "string") {
          const normalized = item.trim().toLowerCase();
          if (SUPPORTED_PRODUCT_SET.has(normalized) && !seen.has(normalized)) {
            seen.add(normalized);
            validProducts.push(normalized as ProductEntitlementId);
          }
        }
      }
      products = validProducts;
    }

    return {
      ...(products !== undefined ? { products } : {}),
      features: Array.isArray(obj.features)
        ? obj.features.map(String)
        : DEFAULT_ENTITLEMENTS.features,
      max_accounts:
        typeof obj.max_accounts === "number" ? obj.max_accounts : null,
      updates_until:
        license.updates_until ??
        (typeof obj.updates_until === "string" ? obj.updates_until : null),
      max_app_version:
        license.max_app_version ??
        (typeof obj.max_app_version === "string" ? obj.max_app_version : null),
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
