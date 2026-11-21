#!/usr/bin/env node
// =============================================================================
// StockStudio Pro License API — Guarded Production Secrets & D1 Bootstrap Script
//
// Operates strictly against `--env production` and `--remote` D1 ONLY.
// NEVER creates Cloudflare Workers, D1 databases, or domains.
// NEVER prints secrets, peppers, private keys, passphrases, or raw admin keys.
//
// Safety & Partial-Failure Guarantees:
//   1. Validates `wrangler.toml` `[env.production]` `database_id` (rejects
//      placeholders, dev, and staging IDs) + requires `--confirm-production`
//      AND `CONFIRM_PRODUCTION_D1_ID=<exact-prod-d1-uuid>`.
//   2. Requires `BOOTSTRAP_RECOVERY_PASSPHRASE` (>= 16 chars) so an AES-256-GCM
//      encrypted offline recovery bundle is written before/with upload.
//   3. Preflight D1 Check BEFORE secret generation/upload: aborts if ANY rows
//      exist in `signing_keys`, `admin_api_keys`, or `licenses`.
//   4. Preflight Cloudflare Secret Check BEFORE secret generation/upload:
//      inspects `wrangler secret list --env production --format json` and aborts
//      if ANY protected secret already exists (never silently overwrites).
//   5. Applies restrictive Windows NTFS ACL (`icacls`) on win32 in addition to
//      POSIX mode `0o600` for the encrypted recovery file.
//   6. Sanitizes all subprocess errors so secret values or raw wrangler stderr
//      are never echoed to logs.
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
  scryptSync,
  webcrypto,
} from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(__dirname, "..");
const wranglerTomlPath = resolve(workerRoot, "wrangler.toml");
const wranglerBin = resolve(
  workerRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js"
);
const defaultRecoveryPath = resolve(
  workerRoot,
  "bootstrap-production-recovery.enc.json"
);

export const PROD_KID = "sspro-ed25519-prod-01";
export const PROTECTED_PRODUCTION_SECRETS = Object.freeze([
  "LICENSE_KEY_PEPPER",
  "ADMIN_TOKEN_PEPPER",
  "IP_HASH_SALT",
  "LICENSE_SIGNING_PRIVATE_KEY_JWK",
  "LICENSE_SIGNING_PUBLIC_KEY_BASE64",
]);

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_IDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "870f9578-82ab-4516-b45f-5300ed3f5e29", // staging D1 ID
  "replace_with_production_d1_database_id",
]);
const textEncoder = new TextEncoder();

export class BootstrapStepError extends Error {
  constructor(step, safeMessage) {
    super(`[step:${step}] ${safeMessage}`);
    this.name = "BootstrapStepError";
    this.step = step;
  }
}

export function extractProductionD1Id(tomlContent) {
  const prodD1Match = tomlContent.match(
    /\[\[env\.production\.d1_databases\]\][\s\S]*?database_id\s*=\s*"([^"]+)"/
  );
  if (!prodD1Match) {
    throw new BootstrapStepError(
      "config_validation",
      "Missing [[env.production.d1_databases]] database_id in wrangler.toml."
    );
  }
  return prodD1Match[1].trim();
}

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

/**
 * Encrypts a JSON-serializable recovery payload using scrypt + AES-256-GCM.
 */
export function encryptRecoveryBundle(payloadObj, passphrase) {
  const salt = nodeRandomBytes(16);
  const iv = nodeRandomBytes(12);
  const derivedKey = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  derivedKey.fill(0);
  plaintext.fill(0);

  return {
    format: "stockstudio-pro-recovery-v1",
    kdf: "scrypt",
    kdf_params: { N: 16384, r: 8, p: 1 },
    cipher: "aes-256-gcm",
    salt_b64: salt.toString("base64"),
    iv_b64: iv.toString("base64"),
    tag_b64: authTag.toString("base64"),
    ciphertext_b64: ciphertext.toString("base64"),
  };
}

/**
 * Decrypts a `stockstudio-pro-recovery-v1` bundle for disaster recovery verification.
 */
export function decryptRecoveryBundle(encryptedBundle, passphrase) {
  const salt = Buffer.from(encryptedBundle.salt_b64, "base64");
  const iv = Buffer.from(encryptedBundle.iv_b64, "base64");
  const authTag = Buffer.from(encryptedBundle.tag_b64, "base64");
  const ciphertext = Buffer.from(encryptedBundle.ciphertext_b64, "base64");
  const { N, r, p } = encryptedBundle.kdf_params;
  const derivedKey = scryptSync(passphrase, salt, 32, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  derivedKey.fill(0);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  plaintext.fill(0);
  return parsed;
}

function defaultRunRemoteProdD1Json(sql) {
  try {
    const output = execFileSync(
      process.execPath,
      [
        wranglerBin,
        "d1",
        "execute",
        "DB",
        "--env",
        "production",
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
      throw new Error("invalid_d1_response");
    }
    return parsed[0].results ?? [];
  } catch {
    throw new BootstrapStepError(
      "d1_execute",
      "Remote production D1 command failed. Inspect wrangler auth and D1 state manually."
    );
  }
}

function defaultListProdSecretNames() {
  try {
    const output = execFileSync(
      process.execPath,
      [
        wranglerBin,
        "secret",
        "list",
        "--env",
        "production",
        "--format",
        "json",
      ],
      {
        cwd: workerRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) {
      throw new Error("invalid_secret_list");
    }
    return parsed
      .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
      .filter((name) => name.length > 0);
  } catch {
    throw new BootstrapStepError(
      "secret_preflight",
      "Unable to inspect existing Cloudflare production secret names. Aborting before any mutation."
    );
  }
}

function defaultPutProdSecret(secretName, secretValue) {
  try {
    execFileSync(
      process.execPath,
      [wranglerBin, "secret", "put", secretName, "--env", "production"],
      {
        cwd: workerRoot,
        input: secretValue,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch {
    throw new BootstrapStepError(
      "secret_upload",
      `Failed to upload production secret '${secretName}'. Halted immediately; inspect existing Cloudflare secrets and follow manual recovery before retrying.`
    );
  }
}

function defaultLockFileAcl(filePath) {
  if (process.platform === "win32") {
    const user = process.env.USERNAME;
    if (!user) return;
    try {
      execFileSync(
        "icacls",
        [filePath, "/inheritance:r", "/grant:r", `${user}:(R,W)`],
        { stdio: ["ignore", "ignore", "ignore"] }
      );
    } catch {
      throw new BootstrapStepError(
        "recovery_acl",
        "Failed to restrict Windows NTFS ACL on recovery file. Remove the file and verify user permissions."
      );
    }
  }
}

/**
 * Core production bootstrap workflow with dependency injection for offline testing.
 */
export async function runProductionBootstrap(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const tomlContent =
    options.tomlContent ?? readFileSync(wranglerTomlPath, "utf8");
  const runRemoteProdD1Json =
    options.runRemoteProdD1Json ?? defaultRunRemoteProdD1Json;
  const listProdSecretNames =
    options.listProdSecretNames ?? defaultListProdSecretNames;
  const putProdSecret = options.putProdSecret ?? defaultPutProdSecret;
  const writeRecoveryFile =
    options.writeRecoveryFile ??
    ((path, content) =>
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 }));
  const lockFileAcl = options.lockFileAcl ?? defaultLockFileAcl;
  const recoveryPath = options.recoveryPath ?? defaultRecoveryPath;
  const log = options.log ?? ((msg) => console.log(msg));

  // Step 1: Config & confirmation safety gate
  const args = new Set(argv);
  const hasConfirmFlag = args.has("--confirm-production");
  const prodD1Id = extractProductionD1Id(tomlContent);

  if (
    FORBIDDEN_IDS.has(prodD1Id.toLowerCase()) ||
    !UUID_REGEX.test(prodD1Id)
  ) {
    throw new BootstrapStepError(
      "config_validation",
      `Refusing to bootstrap production: invalid or placeholder database_id ('${prodD1Id}'). Provision production D1 and update wrangler.toml first.`
    );
  }

  const confirmedId = (env.CONFIRM_PRODUCTION_D1_ID ?? "").trim();
  if (!hasConfirmFlag || confirmedId !== prodD1Id) {
    throw new BootstrapStepError(
      "confirmation_gate",
      "Production safety gate blocked execution. Re-run with both '--confirm-production' and CONFIRM_PRODUCTION_D1_ID=<exact-wrangler-prod-d1-id>."
    );
  }

  const recoveryPassphrase = (env.BOOTSTRAP_RECOVERY_PASSPHRASE ?? "").trim();
  if (recoveryPassphrase.length < 16) {
    throw new BootstrapStepError(
      "recovery_passphrase",
      "BOOTSTRAP_RECOVERY_PASSPHRASE (>= 16 chars) is required to write an encrypted offline recovery bundle."
    );
  }

  // Step 2: Production D1 Preflight BEFORE generating or uploading any secrets
  const signingKeyRows = runRemoteProdD1Json(
    "SELECT COUNT(*) AS count FROM signing_keys;"
  );
  const adminKeyRows = runRemoteProdD1Json(
    "SELECT COUNT(*) AS count FROM admin_api_keys;"
  );
  const licenseRows = runRemoteProdD1Json(
    "SELECT COUNT(*) AS count FROM licenses;"
  );

  const signingKeysCount = Number(signingKeyRows[0]?.count ?? 0);
  const adminKeysCount = Number(adminKeyRows[0]?.count ?? 0);
  const licensesCount = Number(licenseRows[0]?.count ?? 0);

  if (signingKeysCount > 0 || adminKeysCount > 0 || licensesCount > 0) {
    throw new BootstrapStepError(
      "d1_preflight",
      `Refusing to bootstrap non-empty production D1 (signing_keys=${signingKeysCount}, admin_api_keys=${adminKeysCount}, licenses=${licensesCount}). Use manual key rotation or recovery procedures instead.`
    );
  }

  // Step 3: Cloudflare Secret Preflight BEFORE generating or uploading any secrets
  const existingSecretNames = new Set(listProdSecretNames());
  const conflictingSecrets = PROTECTED_PRODUCTION_SECRETS.filter((name) =>
    existingSecretNames.has(name)
  );
  if (conflictingSecrets.length > 0) {
    throw new BootstrapStepError(
      "secret_preflight",
      `Refusing to overwrite existing production secrets: ${conflictingSecrets.join(", ")}. Follow manual recovery or explicit key rotation rather than re-running initial bootstrap.`
    );
  }

  // Step 4: Generate fresh production-only Ed25519 keypair & peppers
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  );
  const testMsg = textEncoder.encode("StockStudioPro:prod-keypair-self-check");
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
    throw new BootstrapStepError(
      "keypair_self_check",
      "Generated Ed25519 production keypair failed self-verification."
    );
  }

  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicRaw = await webcrypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyBase64 = Buffer.from(publicRaw).toString("base64");

  const licensePepper = randomHex(32);
  const adminPepper = randomHex(32);
  const ipHashSalt = randomHex(32);

  const now = new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const adminId = generatePrefixedId("adm", now.getTime());
  const { adminApiKey, keyPrefix } = generateAdminApiKey(adminId);
  const adminKeyHash = await hashAdminApiKey(adminPepper, adminApiKey);

  // Step 5: Write AES-256-GCM encrypted offline recovery bundle FIRST & lock ACLs
  const encryptedRecovery = encryptRecoveryBundle(
    {
      environment: "production",
      created_at: nowIso,
      database_id: prodD1Id,
      signing_kid: PROD_KID,
      public_key_base64: publicKeyBase64,
      LICENSE_KEY_PEPPER: licensePepper,
      ADMIN_TOKEN_PEPPER: adminPepper,
      IP_HASH_SALT: ipHashSalt,
      LICENSE_SIGNING_PRIVATE_KEY_JWK: privateJwk,
      admin_id: adminId,
      admin_key_prefix: keyPrefix,
      admin_api_key: adminApiKey,
    },
    recoveryPassphrase
  );

  try {
    writeRecoveryFile(
      recoveryPath,
      JSON.stringify(encryptedRecovery, null, 2) + "\n"
    );
  } catch {
    throw new BootstrapStepError(
      "recovery_write",
      "Failed to write encrypted offline recovery bundle. Aborted before uploading any secrets."
    );
  }
  lockFileAcl(recoveryPath);

  // Step 6: Upload secrets to Cloudflare Production Worker
  const secretsToUpload = [
    ["LICENSE_KEY_PEPPER", licensePepper],
    ["ADMIN_TOKEN_PEPPER", adminPepper],
    ["IP_HASH_SALT", ipHashSalt],
    ["LICENSE_SIGNING_PRIVATE_KEY_JWK", JSON.stringify(privateJwk)],
    ["LICENSE_SIGNING_PUBLIC_KEY_BASE64", publicKeyBase64],
  ];

  const uploadedNames = [];
  for (const [name, value] of secretsToUpload) {
    try {
      putProdSecret(name, value);
    } catch (err) {
      if (err instanceof BootstrapStepError) throw err;
      throw new BootstrapStepError(
        "secret_upload",
        `Failed to upload production secret '${name}'. Halted immediately; inspect existing Cloudflare secrets and follow manual recovery before retrying.`
      );
    }
    uploadedNames.push(name);
  }

  // Step 7: Seed signing_keys (public key ONLY) & initial super_admin (hash ONLY)
  try {
    runRemoteProdD1Json(
      `INSERT INTO signing_keys (kid, algorithm, public_key_base64, status, created_at) VALUES (${sqlQuote(
        PROD_KID
      )}, 'Ed25519', ${sqlQuote(publicKeyBase64)}, 'active', ${sqlQuote(nowIso)});`
    );
    runRemoteProdD1Json(
      `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, created_by, created_at) VALUES (${sqlQuote(
        adminId
      )}, 'Production Super Admin', ${sqlQuote(keyPrefix)}, ${sqlQuote(
        adminKeyHash
      )}, 'super_admin', 'active', 'bootstrap-production', ${sqlQuote(nowIso)});`
    );
  } catch (err) {
    if (err instanceof BootstrapStepError) throw err;
    throw new BootstrapStepError(
      "d1_seed",
      "Production secrets were uploaded and backed up to the encrypted recovery file, but D1 seeding failed. Do NOT re-run bootstrap; recover using the encrypted backup bundle."
    );
  }

  log("=== StockStudio Pro Production Secrets & Bootstrap Summary ===");
  log(`Environment:              production (REMOTE D1 ${prodD1Id})`);
  log(`Ed25519 Keypair Check:    PASS (pubkey_len=${publicKeyBase64.length})`);
  log(`Secrets Uploaded:         ${uploadedNames.join(", ")}`);
  log(`Signing Key (${PROD_KID}): created`);
  log(`Super Admin Key:          created (prefix=${keyPrefix})`);
  log(
    `Encrypted Recovery File:  ${recoveryPath} (gitignored, AES-256-GCM — move to offline vault & securely delete)`
  );

  return {
    databaseId: prodD1Id,
    signingKid: PROD_KID,
    publicKeyBase64,
    uploadedSecrets: uploadedNames,
    adminKeyPrefix: keyPrefix,
    recoveryPath,
  };
}

const isMainModule =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runProductionBootstrap().catch((err) => {
    const safeMsg =
      err instanceof BootstrapStepError
        ? err.message
        : "[step:unknown] Production bootstrap aborted due to an unexpected error.";
    console.error(`[prod:bootstrap] Aborted: ${safeMsg}`);
    process.exit(1);
  });
}
