#!/usr/bin/env node
// =============================================================================
// StockStudio Pro License API — Staging Secrets & Remote D1 Bootstrap Script
//
// Operates strictly against `--env staging` and `--remote` D1 ONLY.
// NEVER prints secrets, peppers, private keys, or raw admin keys to stdout.
//
// What it does:
//   1. Generates fresh, staging-only CSPRNG peppers (LICENSE_KEY_PEPPER,
//      ADMIN_TOKEN_PEPPER, IP_HASH_SALT) and a fresh staging-only Ed25519
//      keypair (verifying private/public match via sign+verify roundtrip).
//   2. Uploads secrets to Cloudflare Worker `stockstudio-pro-license-api-staging`
//      via `wrangler secret put <NAME> --env staging` (stdin pipe, never echoed).
//   3. Idempotently seeds `signing_keys` (`sspro-ed25519-staging-01`) and ONE
//      `super_admin` in remote staging D1 (`admin_api_keys`), storing ONLY
//      the HMAC-SHA256 hash in D1.
//   4. Saves ONLY the staging admin API key and public key metadata to a
//      gitignored local file `workers/license-api/bootstrap-staging-admin.json`
//      (NEVER tracked, NEVER printed to terminal/logs).
// =============================================================================

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(__dirname, "..");
const wranglerBin = resolve(
  workerRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js"
);
const outPath = resolve(workerRoot, "bootstrap-staging-admin.json");

const STAGING_KID = "sspro-ed25519-staging-01";
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const textEncoder = new TextEncoder();

function randomHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
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

function runRemoteStagingD1Json(sql) {
  const output = execFileSync(
    process.execPath,
    [
      wranglerBin,
      "d1",
      "execute",
      "DB",
      "--env",
      "staging",
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: workerRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || !parsed[0]?.success) {
    throw new Error("Unexpected remote D1 execute response.");
  }
  return parsed[0].results ?? [];
}

function putStagingSecret(secretName, secretValue) {
  execFileSync(
    process.execPath,
    [wranglerBin, "secret", "put", secretName, "--env", "staging"],
    {
      cwd: workerRoot,
      input: secretValue,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

async function main() {
  // 1. Generate fresh staging-only Ed25519 keypair & verify sign/verify roundtrip
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  );

  const testMsg = textEncoder.encode("StockStudioPro:staging-keypair-self-check");
  const testSig = await webcrypto.subtle.sign(
    "Ed25519",
    keyPair.privateKey,
    testMsg
  );
  const verified = await webcrypto.subtle.verify(
    "Ed25519",
    keyPair.publicKey,
    testSig,
    testMsg
  );
  if (!verified) {
    throw new Error("Generated Ed25519 staging keypair failed self-verification.");
  }

  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicRaw = await webcrypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyBase64 = Buffer.from(publicRaw).toString("base64");

  const licensePepper = randomHex(32);
  const adminPepper = randomHex(32);
  const ipHashSalt = randomHex(32);

  // 2. Upload secrets to Cloudflare Staging Worker via `wrangler secret put --env staging`
  const secretsToUpload = [
    ["LICENSE_KEY_PEPPER", licensePepper],
    ["ADMIN_TOKEN_PEPPER", adminPepper],
    ["IP_HASH_SALT", ipHashSalt],
    ["LICENSE_SIGNING_PRIVATE_KEY_JWK", JSON.stringify(privateJwk)],
    ["LICENSE_SIGNING_PUBLIC_KEY_BASE64", publicKeyBase64],
  ];

  const uploadedNames = [];
  for (const [name, value] of secretsToUpload) {
    putStagingSecret(name, value);
    uploadedNames.push(name);
  }

  const now = new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  // 3. Seed signing_keys in remote staging D1 (public key ONLY, never private key)
  const existingKeys = runRemoteStagingD1Json(
    `SELECT kid, status FROM signing_keys WHERE kid = ${sqlQuote(STAGING_KID)};`
  );
  let signingKeyAction = "preserved_existing";
  if (existingKeys.length === 0) {
    runRemoteStagingD1Json(
      `INSERT INTO signing_keys (kid, algorithm, public_key_base64, status, created_at) VALUES (${sqlQuote(
        STAGING_KID
      )}, 'Ed25519', ${sqlQuote(publicKeyBase64)}, 'active', ${sqlQuote(nowIso)});`
    );
    signingKeyAction = "created";
  }

  // 4. Seed one super_admin in remote staging D1 (HMAC-SHA256 hash ONLY)
  const existingAdmins = runRemoteStagingD1Json(
    "SELECT id, key_prefix, role, status FROM admin_api_keys WHERE role = 'super_admin' AND status = 'active';"
  );

  let adminAction = "preserved_existing";
  let adminPrefix = existingAdmins[0]?.key_prefix ?? null;

  if (existingAdmins.length === 0) {
    const adminId = generatePrefixedId("adm", now.getTime());
    const { adminApiKey, keyPrefix } = generateAdminApiKey(adminId);
    const keyHash = await hashAdminApiKey(adminPepper, adminApiKey);

    runRemoteStagingD1Json(
      `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, created_by, created_at) VALUES (${sqlQuote(
        adminId
      )}, 'Staging Super Admin', ${sqlQuote(keyPrefix)}, ${sqlQuote(
        keyHash
      )}, 'super_admin', 'active', 'bootstrap-staging', ${sqlQuote(nowIso)});`
    );

    adminAction = "created";
    adminPrefix = keyPrefix;

    // Save raw staging admin key ONLY to a gitignored local file (never printed to stdout/logs)
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          environment: "staging",
          created_at: nowIso,
          signing_kid: STAGING_KID,
          public_key_base64: publicKeyBase64,
          admin_id: adminId,
          admin_key_prefix: keyPrefix,
          admin_api_key: adminApiKey,
        },
        null,
        2
      ) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
  }

  // 5. Final verification counts (zero secrets or hashes printed)
  const activeAdmins = runRemoteStagingD1Json(
    "SELECT COUNT(*) AS count FROM admin_api_keys WHERE status = 'active';"
  );
  const activeSigningKeys = runRemoteStagingD1Json(
    "SELECT COUNT(*) AS count FROM signing_keys WHERE status = 'active';"
  );
  const licensesCount = runRemoteStagingD1Json(
    "SELECT COUNT(*) AS count FROM licenses;"
  );

  console.log("=== StockStudio Pro Staging Secrets & Bootstrap Summary ===");
  console.log(`Environment:           staging (REMOTE D1 ONLY)`);
  console.log(`Ed25519 Keypair Check: PASS (sign+verify roundtrip ok, pubkey_len=${publicKeyBase64.length})`);
  console.log(`Secrets Uploaded:      ${uploadedNames.join(", ")}`);
  console.log(`Signing Key (${STAGING_KID}): ${signingKeyAction}`);
  console.log(`Super Admin Key:       ${adminAction} (prefix=${adminPrefix})`);
  console.log(`Active Staging Admins: ${activeAdmins[0]?.count ?? 0}`);
  console.log(`Active Signing Keys:   ${activeSigningKeys[0]?.count ?? 0}`);
  console.log(`Staging Licenses:      ${licensesCount[0]?.count ?? 0}`);
  console.log(`Local Staging Output:  workers/license-api/bootstrap-staging-admin.json (gitignored)`);
}

main().catch((err) => {
  console.error("[staging:bootstrap] Failed:", err.message || err);
  process.exit(1);
});
