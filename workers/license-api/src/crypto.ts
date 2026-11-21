// =============================================================================
// StockStudio Pro License API (v0.2.0) — Cryptographic Utilities & Ed25519 Signer
//
// Security Invariants:
// - Uses Web Crypto API (crypto.subtle) exclusively.
// - License keys, activation tokens, and admin API keys are hashed before D1 lookup/storage.
// - Entitlement leases are signed with asymmetric Ed25519 private keys held only
//   in Cloudflare Secrets (.dev.vars locally).
// - Constant-time comparison is used for all hash/token checks.
// =============================================================================

import { ApiError } from "./errors";
import { SignedLeasePayload } from "./types";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LICENSE_KEY_REGEX =
  /^SSPRO-[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Generates a time-sortable ULID-style identifier with a domain prefix
 * (e.g. `lic_01JDF...`, `act_01JDF...`, `lev_01JDF...`).
 */
export function generatePrefixedId(prefix: string, nowMs = Date.now()): string {
  const timeChars = new Array<string>(10);
  let time = nowMs;
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeChars[i] = CROCKFORD_ALPHABET[mod];
    time = Math.floor(time / 32);
  }

  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const randChars = new Array<string>(16);
  for (let i = 0; i < 16; i++) {
    randChars[i] = CROCKFORD_ALPHABET[randomBytes[i] & 31];
  }

  return `${prefix}_${timeChars.join("")}${randChars.join("")}`;
}

/**
 * Generates a high-entropy StockStudio Pro license key (`SSPRO-XXXX-XXXX-XXXX-XXXX`)
 * using CSPRNG and Crockford Base32 alphabet (excluding I, L, O, U).
 */
export function generateLicenseKey(): {
  licenseKey: string;
  keyPrefix: string;
} {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const groups: string[] = [];

  for (let g = 0; g < 4; g++) {
    let chunk = "";
    for (let i = 0; i < 4; i++) {
      const idx = randomBytes[g * 4 + i] & 31;
      chunk += CROCKFORD_ALPHABET[idx];
    }
    groups.push(chunk);
  }

  const licenseKey = `SSPRO-${groups.join("-")}`;
  const keyPrefix = licenseKey.slice(0, 10); // "SSPRO-XXXX"
  return { licenseKey, keyPrefix };
}

/**
 * Normalizes and validates a user-provided license key.
 * Returns null if the format is invalid.
 */
export function normalizeAndValidateLicenseKey(rawKey: unknown): {
  normalizedKey: string;
  keyPrefix: string;
} | null {
  if (typeof rawKey !== "string") return null;
  const normalizedKey = rawKey.trim().toUpperCase();
  if (!LICENSE_KEY_REGEX.test(normalizedKey)) {
    return null;
  }
  return {
    normalizedKey,
    keyPrefix: normalizedKey.slice(0, 10),
  };
}

/**
 * Generates a 256-bit high-entropy activation session token:
 * `ssact_<activationIdCore>_<base64urlSecret>`
 */
export function generateActivationToken(activationId: string): {
  activationToken: string;
  tokenPrefix: string;
} {
  const core = activationId.replace(/^act_/, "").slice(0, 10);
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const secretPart = base64UrlEncode(randomBytes);
  const activationToken = `ssact_${core}_${secretPart}`;
  const tokenPrefix = `ssact_${core}`;
  return { activationToken, tokenPrefix };
}

/**
 * Generates a 256-bit Admin API token:
 * `ssadm_<adminIdCore>_<base64urlSecret>`
 */
export function generateAdminApiKey(adminId: string): {
  adminApiKey: string;
  keyPrefix: string;
} {
  const core = adminId.replace(/^adm_/, "").slice(0, 10);
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const secretPart = base64UrlEncode(randomBytes);
  const adminApiKey = `ssadm_${core}_${secretPart}`;
  const keyPrefix = `ssadm_${core}`;
  return { adminApiKey, keyPrefix };
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64Decode(input: string): Uint8Array {
  const binary = atob(input.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Computes SHA-256 hex digest of a UTF-8 string.
 */
export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(message));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Computes HMAC-SHA256 hex digest using a secret pepper.
 */
export async function hmacSha256Hex(pepper: string, message: string): Promise<string> {
  if (!pepper || pepper.trim().length < 16) {
    throw new Error("Server HMAC pepper is missing or too short.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Hashes a normalized license key with the server-side LICENSE_KEY_PEPPER.
 */
export async function hashLicenseKey(
  pepper: string,
  normalizedKey: string
): Promise<string> {
  return hmacSha256Hex(pepper, `StockStudioPro:license-key:v1:${normalizedKey}`);
}

/**
 * Hashes an activation token using SHA-256 for D1 lookup/storage.
 */
export async function hashActivationToken(activationToken: string): Promise<string> {
  return sha256Hex(`StockStudioPro:activation-token:v1:${activationToken}`);
}

/**
 * Hashes an admin API key with the server-side ADMIN_TOKEN_PEPPER.
 */
export async function hashAdminApiKey(
  adminPepper: string,
  rawAdminKey: string
): Promise<string> {
  return hmacSha256Hex(adminPepper, `StockStudioPro:admin-key:v1:${rawAdminKey}`);
}

/**
 * Privacy-preserving daily salted IP hash for rate-limiting and audit trail.
 * Requires an explicit `IP_HASH_SALT` secret (>= 16 chars) and fails closed if missing.
 */
export async function hashClientIp(
  ip: string,
  salt: string | undefined,
  nowIso: string
): Promise<string> {
  const trimmedSalt = typeof salt === "string" ? salt.trim() : "";
  if (trimmedSalt.length < 16) {
    throw new ApiError({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      message: "Server IP hashing configuration is missing or invalid.",
      retryable: false,
    });
  }
  const dayBucket = nowIso.slice(0, 10);
  return sha256Hex(`StockStudioPro:ip:${trimmedSalt}:${dayBucket}:${ip}`);
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * Signs a canonical SignedLeasePayload with the server's Ed25519 private key JWK.
 * Format: `v1.<base64url_payload>.<base64url_ed25519_signature>`
 */
export async function signEntitlementLease(
  payload: SignedLeasePayload,
  privateKeyJwkJson: string
): Promise<string> {
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(privateKeyJwkJson) as JsonWebKey;
  } catch {
    throw new Error("Invalid LICENSE_SIGNING_PRIVATE_KEY_JWK JSON configuration.");
  }

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    false,
    ["sign"]
  );

  const payloadJson = JSON.stringify(payload);
  const encodedPayload = base64UrlEncode(payloadJson);
  const signingInput = textEncoder.encode(`v1.${encodedPayload}`);
  const signatureBuffer = await crypto.subtle.sign("Ed25519", privateKey, signingInput);
  const encodedSignature = base64UrlEncode(new Uint8Array(signatureBuffer));

  return `v1.${encodedPayload}.${encodedSignature}`;
}

/**
 * Verifies an Ed25519 signed lease token (`v1.<payload>.<signature>`) against
 * a 32-byte raw base64 public key. Used by automated tests and diagnostics.
 */
export async function verifyEntitlementLease(
  leaseToken: string,
  publicKeyBase64: string
): Promise<{ valid: boolean; payload: SignedLeasePayload | null }> {
  const parts = leaseToken.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return { valid: false, payload: null };
  }

  try {
    const [, encodedPayload, encodedSignature] = parts;
    const rawPubKey = base64Decode(publicKeyBase64);
    if (rawPubKey.length !== 32) {
      return { valid: false, payload: null };
    }

    const publicKey = await crypto.subtle.importKey(
      "raw",
      rawPubKey,
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    const signingInput = textEncoder.encode(`v1.${encodedPayload}`);
    const signatureBytes = base64UrlDecode(encodedSignature);
    const isValid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      signatureBytes,
      signingInput
    );

    if (!isValid) {
      return { valid: false, payload: null };
    }

    const payloadJson = textDecoder.decode(base64UrlDecode(encodedPayload));
    const payload = JSON.parse(payloadJson) as SignedLeasePayload;
    return { valid: true, payload };
  } catch {
    return { valid: false, payload: null };
  }
}
