// =============================================================================
// StockStudio Pro License API (v0.2.0-D-B) — Automated Integration Test Suite
//
// Executes against a real local Cloudflare D1 SQLite instance via Miniflare
// with migration `0001_initial_license_schema.sql` applied and ephemeral
// runtime-generated Ed25519 keys (zero hardcoded secrets).
// =============================================================================

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  generateAdminApiKey,
  generatePrefixedId,
  hashAdminApiKey,
  hmacSha256Hex,
  verifyEntitlementLease,
} from "../src/crypto";
import { handleRequest } from "../src/index";
import { Env, SignedLeasePayload } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  resolve(__dirname, "..", "migrations", "0001_initial_license_schema.sql"),
  "utf8"
);

function splitSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  return withoutComments
    .split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

function randomHex(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("StockStudio Pro License API v1 (Cloudflare Workers + D1)", () => {
  let mf: Miniflare;
  let db: D1Database;
  let env: Env;
  let publicKeyBase64: string;
  let superAdminToken: string;
  let readOnlyAdminToken: string;
  let webhookSecret: string;

  const baseNow = new Date("2026-11-20T16:00:00Z");
  const baseEpochSec = Math.floor(baseNow.getTime() / 1000);

  const device1 = {
    device_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
    device_fingerprint:
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    device_name: "STUDIO-PC-01",
    platform: "windows",
    os_version: "10.0.26200",
    arch: "x86_64",
    app_version: "0.2.0",
  };

  const device2 = {
    device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    device_fingerprint:
      "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1",
    device_name: "CREATOR-LAPTOP-02",
    platform: "windows",
    os_version: "10.0.22631",
    arch: "x86_64",
    app_version: "0.2.0",
  };

  const device3 = {
    device_id: "11111111-2222-4333-8444-555555555555",
    device_fingerprint:
      "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
    device_name: "WORKSTATION-03",
    platform: "windows",
    os_version: "10.0.26200",
    arch: "x86_64",
    app_version: "0.2.0",
  };

  function clientHeaders(extra?: Record<string, string>, now = baseNow) {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "StockStudioPro/0.2.0 (windows; x86_64)",
      "X-Client-Product": "com.stockstudiopro.desktop",
      "X-Client-Version": "0.2.0",
      "X-Request-Timestamp": String(Math.floor(now.getTime() / 1000)),
      "X-Request-Nonce": crypto.randomUUID(),
      ...(extra ?? {}),
    };
  }

  function adminHeaders(token = superAdminToken, extra?: Record<string, string>) {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(extra ?? {}),
    };
  }

  async function callApi(
    path: string,
    init: RequestInit = {},
    now = baseNow
  ): Promise<{ status: number; body: Record<string, any>; headers: Headers }> {
    const req = new Request(`https://license-api.test${path}`, init);
    const res = await handleRequest(req, env, now);
    const body = (await res.json()) as Record<string, any>;
    return { status: res.status, body, headers: res.headers };
  }

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script:
        "export default { fetch() { return new Response('miniflare-d1-host'); } }",
      d1Databases: {
        DB: "test-stockstudio-pro-d1",
      },
    });

    db = await mf.getD1Database("DB");

    // Apply all SQL statements from migration 0001
    const statements = splitSqlStatements(migrationSql);
    for (const stmt of statements) {
      await db.prepare(stmt).run();
    }

    // Generate ephemeral Ed25519 keypair in memory
    const keyPair = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;

    const privateJwk = (await crypto.subtle.exportKey(
      "jwk",
      keyPair.privateKey
    )) as JsonWebKey;
    const publicRaw = (await crypto.subtle.exportKey(
      "raw",
      keyPair.publicKey
    )) as ArrayBuffer;
    publicKeyBase64 = Buffer.from(new Uint8Array(publicRaw)).toString("base64");

    const licensePepper = randomHex(32);
    const adminPepper = randomHex(32);
    const ipSalt = randomHex(32);
    webhookSecret = randomHex(32);

    env = {
      DB: db,
      ENVIRONMENT: "development",
      PRODUCT_ID: "com.stockstudiopro.desktop",
      ISSUER: "stockstudiopro-license-server",
      DEFAULT_DEVICE_LIMIT: "2",
      LEASE_TTL_DAYS: "7",
      MAX_CLOCK_SKEW_SECONDS: "300",
      LICENSE_KEY_PEPPER_VERSION: "1",
      LICENSE_SIGNING_KID: "sspro-ed25519-test-01",
      LICENSE_KEY_PEPPER: licensePepper,
      ADMIN_TOKEN_PEPPER: adminPepper,
      IP_HASH_SALT: ipSalt,
      LICENSE_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(privateJwk),
      LICENSE_SIGNING_PUBLIC_KEY_BASE64: publicKeyBase64,
      BILLING_WEBHOOK_SECRETS_JSON: JSON.stringify({
        mock_gateway: webhookSecret,
      }),
    };
  });

  beforeEach(async () => {
    // Reset data tables before each test while preserving schema
    await db.batch([
      db.prepare("DELETE FROM license_events"),
      db.prepare("DELETE FROM billing_events"),
      db.prepare("DELETE FROM billing_subscriptions"),
      db.prepare("DELETE FROM activations"),
      db.prepare("DELETE FROM devices"),
      db.prepare("DELETE FROM licenses"),
      db.prepare("DELETE FROM admin_api_keys"),
      db.prepare("DELETE FROM signing_keys"),
      db.prepare("DELETE FROM rate_limit_buckets"),
    ]);

    // Seed signing key metadata & admin API keys (hashed only!)
    await db
      .prepare(
        "INSERT INTO signing_keys (kid, algorithm, public_key_base64, status, created_at) VALUES (?1, 'Ed25519', ?2, 'active', ?3)"
      )
      .bind("sspro-ed25519-test-01", publicKeyBase64, baseNow.toISOString())
      .run();

    const superId = generatePrefixedId("adm", baseNow.getTime());
    const superGenerated = generateAdminApiKey(superId);
    superAdminToken = superGenerated.adminApiKey;
    const superHash = await hashAdminApiKey(
      env.ADMIN_TOKEN_PEPPER,
      superAdminToken
    );

    const roId = generatePrefixedId("adm", baseNow.getTime() + 1);
    const roGenerated = generateAdminApiKey(roId);
    readOnlyAdminToken = roGenerated.adminApiKey;
    const roHash = await hashAdminApiKey(
      env.ADMIN_TOKEN_PEPPER,
      readOnlyAdminToken
    );

    await db.batch([
      db
        .prepare(
          `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, created_at)
           VALUES (?1, 'Test Super Admin', ?2, ?3, 'super_admin', 'active', ?4)`
        )
        .bind(
          superId,
          superGenerated.keyPrefix,
          superHash,
          baseNow.toISOString()
        ),
      db
        .prepare(
          `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, created_at)
           VALUES (?1, 'Test ReadOnly Admin', ?2, ?3, 'read_only', 'active', ?4)`
        )
        .bind(roId, roGenerated.keyPrefix, roHash, baseNow.toISOString()),
    ]);
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  it("1. Health check returns service metadata and public verifying key", async () => {
    const res = await callApi("/v1/health", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.product_id).toBe("com.stockstudiopro.desktop");
    expect(res.body.signing_kid).toBe("sspro-ed25519-test-01");
    expect(res.body.public_key_base64).toBe(publicKeyBase64);
  });

  it("2. Perpetual license full lifecycle: issue -> activate -> Ed25519 verify -> validate -> zero plaintext at rest", async () => {
    // 1. Issue perpetual license via Admin API
    const createRes = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken, {
        "Idempotency-Key": "idem-perpetual-001",
      }),
      body: JSON.stringify({
        plan_code: "lifetime",
        plan_name: "Lifetime",
        license_type: "perpetual",
        billing_interval: "lifetime",
        customer_email: "buyer@stockstudiopro.test",
        device_limit: 2,
      }),
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.ok).toBe(true);
    const licenseKey: string = createRes.body.license_key;
    const licenseId: string = createRes.body.license.license_id;
    expect(licenseKey).toMatch(
      /^SSPRO-[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}$/
    );
    expect(createRes.body.license.license_type).toBe("perpetual");
    expect(createRes.body.license.billing_interval).toBe("lifetime");
    expect(createRes.body.license.lifetime).toBe(true);
    expect(createRes.body.license.expires_at).toBeNull();
    expect(createRes.body.license.status).toBe("pending_activation");

    // Verify D1 does NOT store plaintext license key
    const dbRow = await db
      .prepare("SELECT key_prefix, key_hash FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<{ key_prefix: string; key_hash: string }>();
    expect(dbRow?.key_prefix).toBe(licenseKey.slice(0, 10));
    expect(dbRow?.key_hash).not.toBe(licenseKey);
    expect(dbRow?.key_hash).toMatch(/^[0-9a-f]{64}$/);

    // 2. Activate on device 1
    const actRes = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        license_key: licenseKey,
        device: device1,
      }),
    });

    expect(actRes.status).toBe(200);
    expect(actRes.body.ok).toBe(true);
    expect(actRes.body.activation_token).toMatch(/^ssact_/);
    expect(actRes.body.license.status).toBe("active");
    expect(actRes.body.license.devices_used).toBe(1);
    expect(actRes.body.license.device_limit).toBe(2);

    // Verify Ed25519 signature on lease_token
    const verification = await verifyEntitlementLease(
      actRes.body.lease_token,
      publicKeyBase64
    );
    expect(verification.valid).toBe(true);
    expect(verification.payload?.license_id).toBe(licenseId);
    expect(verification.payload?.device_id).toBe(device1.device_id);
    expect(verification.payload?.device_fingerprint).toBe(
      device1.device_fingerprint
    );
    expect(verification.payload?.license_type).toBe("perpetual");
    expect(verification.payload?.billing_interval).toBe("lifetime");
    expect(verification.payload?.expires_at).toBeNull();
    expect(verification.payload?.exp).toBe("2026-11-27T16:00:00Z"); // 7-day offline lease

    // Verify tampering with lease_token fails Ed25519 verification
    const parts = (actRes.body.lease_token as string).split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...verification.payload, device_limit: 999 })
    ).toString("base64url");
    const tamperedToken = `v1.${tamperedPayload}.${parts[2]}`;
    const tamperedVerify = await verifyEntitlementLease(
      tamperedToken,
      publicKeyBase64
    );
    expect(tamperedVerify.valid).toBe(false);

    // 3. Validate using activation_token 2 days later
    const twoDaysLater = new Date("2026-11-22T16:00:00Z");
    const valRes = await callApi(
      "/v1/licenses/validate",
      {
        method: "POST",
        headers: clientHeaders(
          {
            Authorization: `Bearer ${actRes.body.activation_token}`,
          },
          twoDaysLater
        ),
        body: JSON.stringify({
          activation_id: actRes.body.activation_id,
          device: {
            device_id: device1.device_id,
            device_fingerprint: device1.device_fingerprint,
            app_version: "0.2.0",
          },
        }),
      },
      twoDaysLater
    );

    expect(valRes.status).toBe(200);
    expect(valRes.body.ok).toBe(true);
    expect(valRes.body.lease.iat).toBe("2026-11-22T16:00:00Z");
    expect(valRes.body.lease.exp).toBe("2026-11-29T16:00:00Z");
  });

  it("3. Device limit enforcement (default=2), reinstall recovery on same fingerprint, and slot release via deactivate", async () => {
    const createRes = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        plan_code: "lifetime",
        plan_name: "Lifetime",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    const licenseKey: string = createRes.body.license_key;

    // Activate Device 1 (1/2)
    const act1 = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device1 }),
    });
    expect(act1.status).toBe(200);
    expect(act1.body.license.devices_used).toBe(1);

    // Re-install recovery on Device 1: new UUID v4, SAME hardware fingerprint -> must rebind without taking slot 2
    const reinstalledDevice1 = {
      ...device1,
      device_id: "99999999-8888-4777-8666-555555555555",
    };
    const rebindRes = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        license_key: licenseKey,
        device: reinstalledDevice1,
      }),
    });
    expect(rebindRes.status).toBe(200);
    expect(rebindRes.body.activation_id).toBe(act1.body.activation_id);
    expect(rebindRes.body.license.devices_used).toBe(1);
    expect(rebindRes.body.lease.device_id).toBe(reinstalledDevice1.device_id);

    // Activate Device 2 (2/2)
    const act2 = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device2 }),
    });
    expect(act2.status).toBe(200);
    expect(act2.body.license.devices_used).toBe(2);

    // Attempt Device 3 -> Must fail with 409 DEVICE_LIMIT_REACHED
    const act3Fail = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device3 }),
    });
    expect(act3Fail.status).toBe(409);
    expect(act3Fail.body.error.code).toBe("DEVICE_LIMIT_REACHED");
    expect(act3Fail.body.error.details.device_limit).toBe(2);
    expect(act3Fail.body.error.details.devices_used).toBe(2);

    // List active devices via X-License-Key header (from activation gate)
    const listRes = await callApi("/v1/licenses/devices", {
      method: "GET",
      headers: clientHeaders({ "X-License-Key": licenseKey }),
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.devices).toHaveLength(2);

    // Deactivate Device 1 remotely using license_key + target_activation_id
    const deactRes = await callApi("/v1/licenses/deactivate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        license_key: licenseKey,
        target_activation_id: act1.body.activation_id,
        reason: "replaced_old_pc",
      }),
    });
    expect(deactRes.status).toBe(200);
    expect(deactRes.body.devices_used).toBe(1);
    expect(deactRes.body.already_deactivated).toBe(false);

    // Calling deactivate again is idempotent and does NOT double-decrement
    const deactIdempotent = await callApi("/v1/licenses/deactivate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        license_key: licenseKey,
        target_activation_id: act1.body.activation_id,
      }),
    });
    expect(deactIdempotent.status).toBe(200);
    expect(deactIdempotent.body.already_deactivated).toBe(true);
    expect(deactIdempotent.body.devices_used).toBe(1);

    // Now Device 3 can activate into slot 2!
    const act3Success = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device3 }),
    });
    expect(act3Success.status).toBe(200);
    expect(act3Success.body.license.devices_used).toBe(2);
  });

  it("4. Subscription lifecycle: monthly creation, lease cap at expires_at, expiration transition, and idempotent webhook renewal", async () => {
    // Issue a monthly subscription expiring in 4 days (less than 7-day lease TTL)
    const periodStart = "2026-10-24T16:00:00Z";
    const periodEnd = "2026-11-24T16:00:00Z"; // 4 days after baseNow (2026-11-20)

    const createRes = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        plan_code: "pro_monthly",
        plan_name: "30 Days",
        license_type: "subscription",
        billing_interval: "monthly",
        billing_provider: "mock_gateway",
        external_subscription_id: "sub_mock_12345",
        current_period_start: periodStart,
        current_period_end: periodEnd,
        expires_at: periodEnd,
        device_limit: 2,
      }),
    });

    expect(createRes.status).toBe(201);
    const licenseKey: string = createRes.body.license_key;
    const licenseId: string = createRes.body.license.license_id;

    // Activate on 2026-11-20 -> Lease exp MUST be capped at 2026-11-24 (expires_at), NOT 2026-11-27
    const actRes = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device1 }),
    });
    expect(actRes.status).toBe(200);
    expect(actRes.body.lease.license_type).toBe("subscription");
    expect(actRes.body.lease.billing_interval).toBe("monthly");
    expect(actRes.body.lease.expires_at).toBe(periodEnd);
    expect(actRes.body.lease.exp).toBe(periodEnd);

    // Advance clock past expiration (2026-11-25) -> Validate must return 403 LICENSE_EXPIRED
    const expiredDate = new Date("2026-11-25T00:00:00Z");
    const valExpired = await callApi(
      "/v1/licenses/validate",
      {
        method: "POST",
        headers: clientHeaders(
          {
            Authorization: `Bearer ${actRes.body.activation_token}`,
          },
          expiredDate
        ),
        body: JSON.stringify({
          activation_id: actRes.body.activation_id,
          device: device1,
        }),
      },
      expiredDate
    );
    expect(valExpired.status).toBe(403);
    expect(valExpired.body.error.code).toBe("LICENSE_EXPIRED");

    // Send confirmed payment webhook to renew subscription until 2026-12-24
    const webhookPayload = JSON.stringify({
      event_id: "evt_pay_001",
      event_type: "payment.succeeded",
      external_subscription_id: "sub_mock_12345",
      external_invoice_id: "inv_001",
      amount_minor: 25000,
      currency: "IDR",
      period_start: "2026-11-24T16:00:00Z",
      period_end: "2026-12-24T16:00:00Z",
      occurred_at: "2026-11-25T01:00:00Z",
    });
    const webhookSig = await hmacSha256Hex(webhookSecret, webhookPayload);

    const whRes1 = await callApi(
      "/v1/billing/webhooks/mock_gateway",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": webhookSig,
        },
        body: webhookPayload,
      },
      expiredDate
    );
    expect(whRes1.status).toBe(200);
    expect(whRes1.body.ok).toBe(true);
    expect(whRes1.body.idempotent_replay).toBe(false);

    // Replay the exact same webhook event -> Must return 200 OK with idempotent_replay: true
    const whRes2 = await callApi(
      "/v1/billing/webhooks/mock_gateway",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": webhookSig,
        },
        body: webhookPayload,
      },
      expiredDate
    );
    expect(whRes2.status).toBe(200);
    expect(whRes2.body.idempotent_replay).toBe(true);
    expect(whRes2.body.billing_event_id).toBe(whRes1.body.billing_event_id);

    // Validate again on 2026-11-25 -> License is active again and expires_at is 2026-12-24!
    const valAfterRenew = await callApi(
      "/v1/licenses/validate",
      {
        method: "POST",
        headers: clientHeaders(
          {
            Authorization: `Bearer ${actRes.body.activation_token}`,
          },
          expiredDate
        ),
        body: JSON.stringify({
          activation_id: actRes.body.activation_id,
          device: device1,
        }),
      },
      expiredDate
    );
    expect(valAfterRenew.status).toBe(200);
    expect(valAfterRenew.body.license.status).toBe("active");
    expect(valAfterRenew.body.license.expires_at).toBe("2026-12-24T16:00:00Z");

    // Verify Admin GET license details includes billing subscription & events history
    const adminDetail = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "GET",
      headers: adminHeaders(readOnlyAdminToken),
    });
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.billing_subscription.current_period_end).toBe(
      "2026-12-24T16:00:00Z"
    );
    expect(adminDetail.body.events.length).toBeGreaterThanOrEqual(3);
  });

  it("5. Admin operations: RBAC enforcement, suspend, reinstate, force-deactivate device, and permanent revocation", async () => {
    // Read-only admin cannot create licenses
    const forbiddenCreate = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(readOnlyAdminToken),
      body: JSON.stringify({
        plan_code: "lifetime",
        plan_name: "Lifetime",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    expect(forbiddenCreate.status).toBe(403);
    expect(forbiddenCreate.body.error.code).toBe("FORBIDDEN_ROLE");

    // Super admin creates license
    const createRes = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "lifetime",
        plan_name: "Lifetime",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    const licenseKey: string = createRes.body.license_key;
    const licenseId: string = createRes.body.license.license_id;

    // Activate Device 1
    const act1 = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device1 }),
    });
    expect(act1.status).toBe(200);

    // Suspend license
    const suspendRes = await callApi(
      `/v1/admin/licenses/${licenseId}/suspend`,
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({ reason: "Compliance check" }),
      }
    );
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.license.status).toBe("suspended");

    // Validate while suspended -> 403 LICENSE_SUSPENDED
    const valSuspended = await callApi("/v1/licenses/validate", {
      method: "POST",
      headers: clientHeaders({
        Authorization: `Bearer ${act1.body.activation_token}`,
      }),
      body: JSON.stringify({
        activation_id: act1.body.activation_id,
        device: device1,
      }),
    });
    expect(valSuspended.status).toBe(403);
    expect(valSuspended.body.error.code).toBe("LICENSE_SUSPENDED");

    // Reinstate license
    const reinstateRes = await callApi(
      `/v1/admin/licenses/${licenseId}/reinstate`,
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({ reason: "Check cleared" }),
      }
    );
    expect(reinstateRes.status).toBe(200);
    expect(reinstateRes.body.license.status).toBe("active");

    // Admin force-deactivate device
    const forceDeact = await callApi(
      `/v1/admin/licenses/${licenseId}/devices/${act1.body.activation_id}`,
      {
        method: "DELETE",
        headers: adminHeaders(superAdminToken),
      }
    );
    expect(forceDeact.status).toBe(200);
    expect(forceDeact.body.devices_used).toBe(0);

    // Validate after device was force-deactivated -> 403 ACTIVATION_REVOKED
    const valDeactivated = await callApi("/v1/licenses/validate", {
      method: "POST",
      headers: clientHeaders({
        Authorization: `Bearer ${act1.body.activation_token}`,
      }),
      body: JSON.stringify({
        activation_id: act1.body.activation_id,
        device: device1,
      }),
    });
    expect(valDeactivated.status).toBe(403);
    expect(valDeactivated.body.error.code).toBe("ACTIVATION_REVOKED");

    // Permanent revocation
    const revokeRes = await callApi(`/v1/admin/licenses/${licenseId}/revoke`, {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({ reason: "Chargeback" }),
    });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.license.status).toBe("revoked");

    // Activate after revocation -> 403 LICENSE_REVOKED
    const actRevoked = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device1 }),
    });
    expect(actRevoked.status).toBe(403);
    expect(actRevoked.body.error.code).toBe("LICENSE_REVOKED");
  });

  it("6. Security controls: rejects Flowpilot product header, rejects clock skew > 300s, and enforces rate limiting", async () => {
    // 1. Reject wrong product identifier (e.g. legacy Flowpilot client)
    const badProduct = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: {
        ...clientHeaders(),
        "X-Client-Product": "com.flowpilot.desktop",
      },
      body: JSON.stringify({
        license_key: "SSPRO-1234-5678-9ABC-DEFG",
        device: device1,
      }),
    });
    expect(badProduct.status).toBe(400);
    expect(badProduct.body.error.code).toBe("PRODUCT_MISMATCH");

    // 2. Reject clock skew > 300 seconds
    const skewedHeaders = {
      ...clientHeaders(),
      "X-Request-Timestamp": String(baseEpochSec - 600),
    };
    const skewedRes = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: skewedHeaders,
      body: JSON.stringify({
        license_key: "SSPRO-1234-5678-9ABC-DEFG",
        device: device1,
      }),
    });
    expect(skewedRes.status).toBe(400);
    expect(skewedRes.body.error.code).toBe("CLOCK_SKEW_TOO_LARGE");

    // 3. Rate limit after 15 failed attempts on the same key_prefix
    for (let i = 0; i < 15; i++) {
      const res = await callApi("/v1/licenses/activate", {
        method: "POST",
        headers: clientHeaders(),
        body: JSON.stringify({
          license_key: "SSPRO-9999-8888-7777-6666",
          device: device1,
        }),
      });
      expect(res.status).toBe(401);
    }

    const rateLimitedRes = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        license_key: "SSPRO-9999-8888-7777-6666",
        device: device1,
      }),
    });
    expect(rateLimitedRes.status).toBe(429);
    expect(rateLimitedRes.body.error.code).toBe("RATE_LIMITED");
    expect(rateLimitedRes.headers.get("Retry-After")).toBeTruthy();
  });

  it("7. Admin Idempotency-Key conflict protection, PATCH device_limit & metadata update, manual subscription renewal, and webhook signature/refund/cancel handling", async () => {
    // 1. Create a yearly subscription license with Idempotency-Key
    const idemKey = "idem-sub-yearly-777";
    const create1 = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken, { "Idempotency-Key": idemKey }),
      body: JSON.stringify({
        plan_code: "pro_yearly",
        plan_name: "1 Year",
        license_type: "subscription",
        billing_interval: "yearly",
        billing_provider: "mock_gateway",
        external_subscription_id: "sub_yearly_777",
        current_period_start: "2026-11-20T16:00:00Z",
        current_period_end: "2027-11-20T16:00:00Z",
        expires_at: "2027-11-20T16:00:00Z",
        device_limit: 2,
      }),
    });
    expect(create1.status).toBe(201);
    const licenseId: string = create1.body.license.license_id;
    const licenseKey: string = create1.body.license_key;

    // Duplicate Idempotency-Key must be rejected with 409 IDEMPOTENCY_CONFLICT
    const createDup = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken, { "Idempotency-Key": idemKey }),
      body: JSON.stringify({
        plan_code: "pro_yearly",
        plan_name: "1 Year",
        license_type: "subscription",
        billing_interval: "yearly",
        current_period_start: "2026-11-20T16:00:00Z",
        current_period_end: "2027-11-20T16:00:00Z",
        expires_at: "2027-11-20T16:00:00Z",
      }),
    });
    expect(createDup.status).toBe(409);
    expect(createDup.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // 2. PATCH license to increase device_limit to 3
    const patchRes = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "PATCH",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        device_limit: 3,
        customer_email: "studio@stockstudiopro.test",
        notes: "Upgraded to 3 devices",
      }),
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.license.device_limit).toBe(3);

    // Activate all 3 devices (since device_limit is now 3)
    const a1 = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device1 }),
    });
    const a2 = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device2 }),
    });
    const a3 = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: licenseKey, device: device3 }),
    });
    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    expect(a3.status).toBe(200);
    expect(a3.body.license.devices_used).toBe(3);

    // Attempting to PATCH device_limit down to 2 while 3 devices are active must return 400
    const patchBelowActive = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "PATCH",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({ device_limit: 2 }),
    });
    expect(patchBelowActive.status).toBe(400);
    expect(patchBelowActive.body.error.code).toBe("INVALID_REQUEST");

    // 3. Manual Admin subscription renewal via POST /v1/admin/licenses/:id/renew (idempotent)
    const renewBody = JSON.stringify({
      billing_provider: "manual_bank_transfer",
      external_payment_id: "pay_manual_2027_001",
      amount_minor: 99000,
      currency: "IDR",
      new_period_start: "2027-11-20T16:00:00Z",
      new_period_end: "2028-11-20T16:00:00Z",
    });
    const renew1 = await callApi(`/v1/admin/licenses/${licenseId}/renew`, {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: renewBody,
    });
    expect(renew1.status).toBe(200);
    expect(renew1.body.idempotent_replay).toBe(false);
    expect(renew1.body.license.expires_at).toBe("2028-11-20T16:00:00Z");

    const renew2 = await callApi(`/v1/admin/licenses/${licenseId}/renew`, {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: renewBody,
    });
    expect(renew2.status).toBe(200);
    expect(renew2.body.idempotent_replay).toBe(true);

    // 4. Reject webhook with invalid signature
    const badWh = await callApi("/v1/billing/webhooks/mock_gateway", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "deadbeef",
      },
      body: JSON.stringify({
        event_id: "evt_bad_sig",
        event_type: "subscription.canceled",
        external_subscription_id: "sub_yearly_777",
      }),
    });
    expect(badWh.status).toBe(401);
    expect(badWh.body.error.code).toBe("UNAUTHORIZED_TOKEN");

    // 5. Process valid subscription.canceled webhook -> sets cancel_at_period_end = true
    const cancelPayload = JSON.stringify({
      event_id: "evt_cancel_777",
      event_type: "subscription.canceled",
      external_subscription_id: "sub_yearly_777",
      cancel_at_period_end: true,
    });
    const cancelSig = await hmacSha256Hex(webhookSecret, cancelPayload);
    const cancelWh = await callApi("/v1/billing/webhooks/mock_gateway", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": cancelSig,
      },
      body: cancelPayload,
    });
    expect(cancelWh.status).toBe(200);

    // 6. Process payment.refunded webhook -> automatically revokes license and all 3 active devices
    const refundPayload = JSON.stringify({
      event_id: "evt_refund_777",
      event_type: "payment.refunded",
      external_subscription_id: "sub_yearly_777",
    });
    const refundSig = await hmacSha256Hex(webhookSecret, refundPayload);
    const refundWh = await callApi("/v1/billing/webhooks/mock_gateway", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": refundSig,
      },
      body: refundPayload,
    });
    expect(refundWh.status).toBe(200);

    const detailAfterRefund = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(detailAfterRefund.body.license.status).toBe("revoked");
    expect(detailAfterRefund.body.license.devices_used).toBe(0);
  });
});
