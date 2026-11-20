#!/usr/bin/env node
// =============================================================================
// StockStudio Pro License API — Local Development Bootstrap Script (D1 Local)
//
// Idempotently seeds the local Cloudflare D1 database (`--local` ONLY) with:
//   1. The active Ed25519 public verifying key metadata in `signing_keys`
//      (read from `.dev.vars` — NEVER stores private keys in D1).
//   2. One `super_admin` principal in `admin_api_keys` (hashed with
//      `HMAC-SHA256(ADMIN_TOKEN_PEPPER, "StockStudioPro:admin-key:v1:" + rawKey)`).
//
// Security & Idempotency Guarantees:
// - Reads secrets from `.dev.vars` without printing peppers or private keys.
// - Never modifies `.dev.vars` or rotates the existing Ed25519 key pair.
// - Safe to re-run: if an active `super_admin` or matching `signing_keys` row
//   already exists, no duplicate records are created and existing rows are preserved.
// - Prints the raw Admin API key ONCE only when a new admin key is created.
// - Operates strictly against `--local` D1 (never `--remote`).
// =============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(__dirname, "..");
const devVarsPath = resolve(workerRoot, ".dev.vars");

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const textEncoder = new TextEncoder();

function parseDevVars(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(
      `Missing .dev.vars at ${filePath}. Run 'npm run dev:setup' first.`
    );
  }
  const vars = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

function generatePrefixedId(prefix, nowMs = Date.now()) {
  const timeChars = new Array(10);
  let time = nowMs;
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD_ALPHABET[time % 32];
    time = Math.floor(time / 32);
  }
  const randomBytes = new Uint8Array(16);
  webcrypto.getRandomValues(randomBytes);
  const randChars = new Array(16);
  for (let i = 0; i < 16; i++) {
    randChars[i] = CROCKFORD_ALPHABET[randomBytes[i] & 31];
  }
  return `${prefix}_${timeChars.join("")}${randChars.join("")}`;
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateAdminApiKey(adminId) {
  const core = adminId.replace(/^adm_/, "").slice(0, 10);
  const randomBytes = new Uint8Array(32);
  webcrypto.getRandomValues(randomBytes);
  const secretPart = base64UrlEncode(randomBytes);
  return {
    adminApiKey: `ssadm_${core}_${secretPart}`,
    keyPrefix: `ssadm_${core}`,
  };
}

async function hashAdminApiKey(adminPepper, rawAdminKey) {
  if (!adminPepper || adminPepper.trim().length < 16) {
    throw new Error("ADMIN_TOKEN_PEPPER in .dev.vars is missing or too short.");
  }
  const key = await webcrypto.subtle.importKey(
    "raw",
    textEncoder.encode(adminPepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await webcrypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`StockStudioPro:admin-key:v1:${rawAdminKey}`)
  );
  return Buffer.from(sig).toString("hex");
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runLocalD1Json(sql) {
  const wranglerBin = resolve(
    workerRoot,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js"
  );
  const output = execFileSync(
    process.execPath,
    [wranglerBin, "d1", "execute", "DB", "--local", "--json", "--command", sql],
    {
      cwd: workerRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || !parsed[0]?.success) {
    throw new Error("Unexpected D1 execute response.");
  }
  return parsed[0].results ?? [];
}

async function main() {
  const vars = parseDevVars(devVarsPath);
  const adminPepper = vars.ADMIN_TOKEN_PEPPER;
  const kid = vars.LICENSE_SIGNING_KID || "sspro-ed25519-dev-01";
  const publicKeyBase64 = vars.LICENSE_SIGNING_PUBLIC_KEY_BASE64;

  if (!adminPepper || adminPepper.length < 16) {
    throw new Error("ADMIN_TOKEN_PEPPER is missing or invalid in .dev.vars.");
  }
  if (!publicKeyBase64 || Buffer.from(publicKeyBase64, "base64").length !== 32) {
    throw new Error(
      "LICENSE_SIGNING_PUBLIC_KEY_BASE64 in .dev.vars is missing or not a 32-byte Ed25519 public key."
    );
  }

  const now = new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  // 1. Idempotently ensure signing_keys row exists for current kid
  const existingKeys = runLocalD1Json(
    `SELECT kid, status FROM signing_keys WHERE kid = ${sqlQuote(kid)};`
  );

  let signingKeyAction = "preserved_existing";
  if (existingKeys.length === 0) {
    runLocalD1Json(
      `INSERT INTO signing_keys (kid, algorithm, public_key_base64, status, created_at) VALUES (${sqlQuote(
        kid
      )}, 'Ed25519', ${sqlQuote(publicKeyBase64)}, 'active', ${sqlQuote(nowIso)});`
    );
    signingKeyAction = "created";
  }

  // 2. Idempotently ensure at least one active super_admin exists
  const existingAdmins = runLocalD1Json(
    `SELECT id, name, key_prefix, role, status FROM admin_api_keys WHERE role = 'super_admin' AND status = 'active';`
  );

  let adminAction = "preserved_existing";
  let newlyCreatedAdminKey = null;
  let newlyCreatedAdminPrefix = null;

  if (existingAdmins.length === 0) {
    const adminId = generatePrefixedId("adm", now.getTime());
    const { adminApiKey, keyPrefix } = generateAdminApiKey(adminId);
    const keyHash = await hashAdminApiKey(adminPepper, adminApiKey);

    runLocalD1Json(
      `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, created_by, created_at) VALUES (${sqlQuote(
        adminId
      )}, 'Local Development Super Admin', ${sqlQuote(keyPrefix)}, ${sqlQuote(
        keyHash
      )}, 'super_admin', 'active', 'bootstrap-local', ${sqlQuote(nowIso)});`
    );

    adminAction = "created";
    newlyCreatedAdminKey = adminApiKey;
    newlyCreatedAdminPrefix = keyPrefix;
  }

  // 3. Verify final active counts without printing any hashes or secrets
  const activeAdmins = runLocalD1Json(
    "SELECT COUNT(*) AS count FROM admin_api_keys WHERE status = 'active';"
  );
  const activeSigningKeys = runLocalD1Json(
    "SELECT COUNT(*) AS count FROM signing_keys WHERE status = 'active';"
  );

  console.log("=== StockStudio Pro Local D1 Bootstrap Summary ===");
  console.log(`Target Database:   DB (--local ONLY)`);
  console.log(`Signing Key (${kid}): ${signingKeyAction}`);
  console.log(`Super Admin Key:   ${adminAction}`);
  console.log(`Active Admins:     ${activeAdmins[0]?.count ?? 0}`);
  console.log(`Active Sign Keys:  ${activeSigningKeys[0]?.count ?? 0}`);

  if (newlyCreatedAdminKey) {
    console.log("");
    console.log("IMPORTANT: Copy this local Admin API Key now. It is shown ONCE and NOT saved in plaintext:");
    console.log(`  Key Prefix: ${newlyCreatedAdminPrefix}`);
    console.log(`  Admin Key:  ${newlyCreatedAdminKey}`);
  } else {
    console.log(
      "Note: An active super_admin already exists in local D1. No new key was generated."
    );
  }
}

main().catch((err) => {
  console.error("[dev:bootstrap] Failed:", err.message || err);
  process.exit(1);
});
