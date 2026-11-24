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
const migration0002Sql = readFileSync(
  resolve(__dirname, "..", "migrations", "0002_admin_listing_indexes.sql"),
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

    // Apply all SQL statements from migrations 0001 and 0002
    for (const sql of [migrationSql, migration0002Sql]) {
      for (const stmt of splitSqlStatements(sql)) {
        await db.prepare(stmt).run();
      }
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

  // ---------------------------------------------------------------------------
  // TEST 8: Native entitlements.products (Unified, Desktop-only, Extension-only,
  // Legacy features-only, Validation & Malformed Data)
  // ---------------------------------------------------------------------------
  it("8. Preserves entitlements.products across create, DB storage, retrieval, update, and signed leases while keeping legacy compatibility", async () => {
    // 8a. Unified Desktop + Extension license (products without using features as workaround)
    const unifiedCreate = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "pro_unified_lifetime",
        plan_name: "StockStudio Pro Unified Lifetime",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: {
          products: ["desktop", "vectorizer_extension"],
          features: [],
        },
      }),
    });
    expect(unifiedCreate.status).toBe(201);
    expect(unifiedCreate.body.license.entitlements.products).toEqual([
      "desktop",
      "vectorizer_extension",
    ]);
    expect(unifiedCreate.body.license.entitlements.features).toEqual([]);

    const unifiedId = unifiedCreate.body.license.license_id as string;
    const unifiedKey = unifiedCreate.body.license_key as string;

    // Verify D1 persistence in entitlements_json
    const dbUnified = await db
      .prepare("SELECT entitlements_json FROM licenses WHERE id = ?1")
      .bind(unifiedId)
      .first<{ entitlements_json: string }>();
    expect(dbUnified).not.toBeNull();
    const persistedUnified = JSON.parse(dbUnified!.entitlements_json);
    expect(persistedUnified.products).toEqual(["desktop", "vectorizer_extension"]);

    // Verify retrieval via GET /v1/admin/licenses/:id
    const unifiedDetail = await callApi(`/v1/admin/licenses/${unifiedId}`, {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(unifiedDetail.status).toBe(200);
    expect(unifiedDetail.body.license.entitlements.products).toEqual([
      "desktop",
      "vectorizer_extension",
    ]);

    // Verify signed lease payload on activate and validate
    const actRes = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: unifiedKey, device: device1 }),
    });
    expect(actRes.status).toBe(200);
    const verifiedAct = await verifyEntitlementLease(
      actRes.body.lease_token,
      publicKeyBase64
    );
    expect(verifiedAct.valid).toBe(true);
    expect(verifiedAct.payload?.entitlements.products).toEqual([
      "desktop",
      "vectorizer_extension",
    ]);
    expect(verifiedAct.payload?.entitlements.features).toEqual([]);

    const valRes = await callApi("/v1/licenses/validate", {
      method: "POST",
      headers: clientHeaders({
        Authorization: `Bearer ${actRes.body.activation_token}`,
      }),
      body: JSON.stringify({ device: device1 }),
    });
    expect(valRes.status).toBe(200);
    const verifiedVal = await verifyEntitlementLease(
      valRes.body.lease_token,
      publicKeyBase64
    );
    expect(verifiedVal.valid).toBe(true);
    expect(verifiedVal.payload?.entitlements.products).toEqual([
      "desktop",
      "vectorizer_extension",
    ]);

    // 8b. Desktop-only license
    const desktopOnly = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "desktop_only",
        plan_name: "Desktop Only",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: { products: ["desktop"] },
      }),
    });
    expect(desktopOnly.status).toBe(201);
    expect(desktopOnly.body.license.entitlements.products).toEqual(["desktop"]);

    // 8c. Extension-only license
    const extOnly = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "ext_only",
        plan_name: "Extension Only",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: { products: ["vectorizer_extension"], features: [] },
      }),
    });
    expect(extOnly.status).toBe(201);
    expect(extOnly.body.license.entitlements.products).toEqual([
      "vectorizer_extension",
    ]);

    // 8d. Legacy features-only license (no products field invented)
    const legacyCreate = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "legacy_desktop",
        plan_name: "Legacy Desktop",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: { features: ["google_flow_workspace"] },
      }),
    });
    expect(legacyCreate.status).toBe(201);
    expect(legacyCreate.body.license.entitlements.products).toBeUndefined();
    expect(legacyCreate.body.license.entitlements.features).toEqual([
      "google_flow_workspace",
    ]);

    const legacyAct = await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        license_key: legacyCreate.body.license_key,
        device: device2,
      }),
    });
    expect(legacyAct.status).toBe(200);
    const verifiedLegacy = await verifyEntitlementLease(
      legacyAct.body.lease_token,
      publicKeyBase64
    );
    expect(verifiedLegacy.valid).toBe(true);
    expect(verifiedLegacy.payload?.entitlements.products).toBeUndefined();

    // 8e. Reject unsupported product identifiers, empty products array, and malformed entitlements
    const badProd = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "bad_prod",
        plan_name: "Bad Product",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: { products: ["desktop", "unknown_product"] },
      }),
    });
    expect(badProd.status).toBe(400);
    expect(badProd.body.error.code).toBe("INVALID_REQUEST");

    const emptyProd = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "empty_prod",
        plan_name: "Empty Product",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: { products: [] },
      }),
    });
    expect(emptyProd.status).toBe(400);

    const malformedEnt = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "malformed_ent",
        plan_name: "Malformed Entitlements",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: "not-an-object",
      }),
    });
    expect(malformedEnt.status).toBe(400);

    // PATCH update rejects unsupported product and preserves valid products
    const badPatch = await callApi(`/v1/admin/licenses/${unifiedId}`, {
      method: "PATCH",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        entitlements: { products: ["invalid_id"] },
      }),
    });
    expect(badPatch.status).toBe(400);

    // Corrupted entitlements_json in D1 falls back safely without granting vectorizer_extension
    await db
      .prepare("UPDATE licenses SET entitlements_json = '{corrupted-json' WHERE id = ?1")
      .bind(legacyCreate.body.license.license_id)
      .run();
    const corruptedDetail = await callApi(
      `/v1/admin/licenses/${legacyCreate.body.license.license_id}`,
      {
        method: "GET",
        headers: adminHeaders(superAdminToken),
      }
    );
    expect(corruptedDetail.status).toBe(200);
    expect(corruptedDetail.body.license.entitlements.products).toBeUndefined();
    expect(corruptedDetail.body.license.entitlements.features).not.toContain(
      "vectorizer_extension"
    );
  });

  // ---------------------------------------------------------------------------
  // TEST 9: IP_HASH_SALT Required (No Insecure Default Fallback)
  // ---------------------------------------------------------------------------
  it("9. Fails closed with 503 when IP_HASH_SALT is missing or too short and succeeds when configured", async () => {
    const req = new Request("https://license-api.test/v1/health", {
      method: "GET",
    });

    // Missing IP_HASH_SALT
    const envMissingSalt: Env = { ...env, IP_HASH_SALT: "" };
    const missingRes = await handleRequest(req, envMissingSalt, baseNow);
    expect(missingRes.status).toBe(503);
    const missingBody = (await missingRes.json()) as Record<string, any>;
    expect(missingBody.ok).toBe(false);
    expect(missingBody.error.code).toBe("SERVICE_UNAVAILABLE");

    // Too-short IP_HASH_SALT
    const envShortSalt: Env = { ...env, IP_HASH_SALT: "short-salt" };
    const shortRes = await handleRequest(req, envShortSalt, baseNow);
    expect(shortRes.status).toBe(503);

    // Valid IP_HASH_SALT succeeds
    const validRes = await handleRequest(req, env, baseNow);
    expect(validRes.status).toBe(200);
    const validBody = (await validRes.json()) as Record<string, any>;
    expect(validBody.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // TEST 10: Admin API allowed_ips_json Enforcement
  // ---------------------------------------------------------------------------
  it("10. Enforces admin_api_keys.allowed_ips_json while keeping unset/empty allowlists unrestricted", async () => {
    // Seed three admin keys: restricted IP, empty allowlist [], and malformed allowlist
    const mkAdmin = async (name: string, allowedIpsJson: string | null) => {
      const id = generatePrefixedId("adm", baseNow.getTime() + Math.floor(Math.random() * 10000));
      const { adminApiKey, keyPrefix } = generateAdminApiKey(id);
      const keyHash = await hashAdminApiKey(env.ADMIN_TOKEN_PEPPER, adminApiKey);
      await db
        .prepare(
          `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, allowed_ips_json, created_at)
           VALUES (?1, ?2, ?3, ?4, 'super_admin', 'active', ?5, ?6)`
        )
        .bind(id, name, keyPrefix, keyHash, allowedIpsJson, baseNow.toISOString())
        .run();
      return adminApiKey;
    };

    const restrictedToken = await mkAdmin(
      "IP Restricted Admin",
      JSON.stringify(["203.0.113.10", "198.51.100.5"])
    );
    const emptyListToken = await mkAdmin("Empty Allowlist Admin", JSON.stringify([]));
    const malformedListToken = await mkAdmin("Malformed Allowlist Admin", "{bad-json");

    // Allowed IP -> succeeds (201)
    const allowedRes = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(restrictedToken, { "CF-Connecting-IP": "203.0.113.10" }),
      body: JSON.stringify({
        plan_code: "ip_ok",
        plan_name: "IP Allowed",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    expect(allowedRes.status).toBe(201);

    // Denied IP -> rejected (403 FORBIDDEN_ROLE)
    const deniedRes = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(restrictedToken, { "CF-Connecting-IP": "192.0.2.99" }),
      body: JSON.stringify({
        plan_code: "ip_denied",
        plan_name: "IP Denied",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.error.code).toBe("FORBIDDEN_ROLE");

    // Unset (null) allowlist (superAdminToken) -> unrestricted from any IP
    const unrestrictedNull = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken, { "CF-Connecting-IP": "192.0.2.77" }),
      body: JSON.stringify({
        plan_code: "ip_null",
        plan_name: "IP Unrestricted Null",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    expect(unrestrictedNull.status).toBe(201);

    // Empty allowlist [] -> unrestricted from any IP
    const unrestrictedEmpty = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(emptyListToken, { "CF-Connecting-IP": "192.0.2.88" }),
      body: JSON.stringify({
        plan_code: "ip_empty",
        plan_name: "IP Unrestricted Empty",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    expect(unrestrictedEmpty.status).toBe(201);

    // Malformed allowlist JSON -> fail closed (403)
    const malformedRes = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(malformedListToken, { "CF-Connecting-IP": "203.0.113.10" }),
      body: JSON.stringify({
        plan_code: "ip_malformed",
        plan_name: "IP Malformed",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    expect(malformedRes.status).toBe(403);
    expect(malformedRes.body.error.code).toBe("FORBIDDEN_ROLE");
  });

  // ---------------------------------------------------------------------------
  // TEST 11: Trusted Client IP (No XFF Spoofing in Prod/Staging, Dev Compat,
  // IPv4 & IPv6 Canonical/Equivalent Matching)
  // ---------------------------------------------------------------------------
  it("11. Trusts CF-Connecting-IP exclusively in production/staging, blocks X-Forwarded-For spoofing, preserves dev compatibility, and matches canonical IPv4/IPv6", async () => {
    const mkAdmin = async (name: string, allowedIpsJson: string) => {
      const id = generatePrefixedId(
        "adm",
        baseNow.getTime() + Math.floor(Math.random() * 100000)
      );
      const { adminApiKey, keyPrefix } = generateAdminApiKey(id);
      const keyHash = await hashAdminApiKey(env.ADMIN_TOKEN_PEPPER, adminApiKey);
      await db
        .prepare(
          `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, allowed_ips_json, created_at)
           VALUES (?1, ?2, ?3, ?4, 'super_admin', 'active', ?5, ?6)`
        )
        .bind(id, name, keyPrefix, keyHash, allowedIpsJson, baseNow.toISOString())
        .run();
      return adminApiKey;
    };

    const ipv4Token = await mkAdmin("Prod IPv4 Admin", JSON.stringify(["203.0.113.10"]));
    const ipv6Token = await mkAdmin(
      "Prod IPv6 Admin",
      JSON.stringify(["2001:0db8:0000:0000:0000:0000:0000:0001"])
    );
    const badEntryToken = await mkAdmin(
      "Bad Entry Admin",
      JSON.stringify(["203.0.113.10", "not-an-ip"])
    );
    const prodEnv: Env = { ...env, ENVIRONMENT: "production" };
    const stagingEnv: Env = { ...env, ENVIRONMENT: "staging" };

    const callWithEnv = async (targetEnv: Env, token: string, headers: Record<string, string>) => {
      const req = new Request("https://license.stockstudiopro.test/v1/admin/licenses", {
        method: "POST",
        headers: adminHeaders(token, headers),
        body: JSON.stringify({
          plan_code: "ip_test",
          plan_name: "IP Test",
          license_type: "perpetual",
          billing_interval: "lifetime",
        }),
      });
      const res = await handleRequest(req, targetEnv, baseNow);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    // 11a. X-Forwarded-For spoofing CANNOT bypass allowlist in production (missing CF-Connecting-IP)
    const spoofProd = await callWithEnv(prodEnv, ipv4Token, {
      "X-Forwarded-For": "203.0.113.10",
    });
    expect(spoofProd.status).toBe(403);
    expect(spoofProd.body.error.code).toBe("FORBIDDEN_ROLE");

    // 11b. X-Forwarded-For spoofing CANNOT override CF-Connecting-IP in staging
    const spoofStaging = await callWithEnv(stagingEnv, ipv4Token, {
      "CF-Connecting-IP": "198.51.100.99",
      "X-Forwarded-For": "203.0.113.10",
    });
    expect(spoofStaging.status).toBe(403);

    // 11c. Missing CF-Connecting-IP in production fails closed even if allowlist contains 127.0.0.1
    const localhostToken = await mkAdmin("Localhost Admin", JSON.stringify(["127.0.0.1"]));
    const missingCfProd = await callWithEnv(prodEnv, localhostToken, {});
    expect(missingCfProd.status).toBe(403);

    // 11d. Local development environment preserves X-Forwarded-For / 127.0.0.1 compatibility
    const devLocalhost = await callWithEnv(env, localhostToken, {});
    expect(devLocalhost.status).toBe(201);
    const devXff = await callWithEnv(env, ipv4Token, {
      "X-Forwarded-For": "203.0.113.10, 10.0.0.1",
    });
    expect(devXff.status).toBe(201);

    // 11e. IPv4 allowlist match & mismatch in production via CF-Connecting-IP
    const ipv4Match = await callWithEnv(prodEnv, ipv4Token, {
      "CF-Connecting-IP": "203.0.113.10",
    });
    expect(ipv4Match.status).toBe(201);
    const ipv4Mismatch = await callWithEnv(prodEnv, ipv4Token, {
      "CF-Connecting-IP": "203.0.113.11",
    });
    expect(ipv4Mismatch.status).toBe(403);

    // 11f. IPv6 canonical & equivalent compressed/uppercase representation matching
    const ipv6Compressed = await callWithEnv(prodEnv, ipv6Token, {
      "CF-Connecting-IP": "2001:DB8::1",
    });
    expect(ipv6Compressed.status).toBe(201);
    const ipv6Mismatch = await callWithEnv(prodEnv, ipv6Token, {
      "CF-Connecting-IP": "2001:db8::2",
    });
    expect(ipv6Mismatch.status).toBe(403);

    // 11g. Malformed allowlist entry fails closed even if another entry matches
    const badEntryRes = await callWithEnv(prodEnv, badEntryToken, {
      "CF-Connecting-IP": "203.0.113.10",
    });
    expect(badEntryRes.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // TEST 12: Partial PATCH Entitlement Preservation & Top-Level Column Sync
  // ---------------------------------------------------------------------------
  it("12. Preserves products/features on partial PATCH and synchronizes updates_until and max_app_version columns including clearing", async () => {
    const created = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "patch_sync_pro",
        plan_name: "Patch Sync Pro",
        license_type: "perpetual",
        billing_interval: "lifetime",
        entitlements: {
          products: ["desktop", "vectorizer_extension"],
          features: ["google_flow_workspace", "multi_account_manager"],
          max_accounts: 10,
          updates_until: "2027-01-01T00:00:00Z",
          max_app_version: "0.9.0",
        },
      }),
    });
    expect(created.status).toBe(201);
    const licenseId = created.body.license.license_id as string;

    // 12a. Partial PATCH updating only max_accounts preserves products, features, updates_until, max_app_version
    const partialPatch = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "PATCH",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        entitlements: { max_accounts: 25 },
      }),
    });
    expect(partialPatch.status).toBe(200);

    const afterPartial = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(afterPartial.body.license.entitlements).toEqual({
      products: ["desktop", "vectorizer_extension"],
      features: ["google_flow_workspace", "multi_account_manager"],
      max_accounts: 25,
      updates_until: "2027-01-01T00:00:00Z",
      max_app_version: "0.9.0",
    });

    // 12b. PATCH updates_until and max_app_version updates BOTH top-level DB columns and parsed entitlements
    const syncPatch = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "PATCH",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        entitlements: {
          updates_until: "2028-06-30T00:00:00Z",
          max_app_version: "1.5.0",
        },
      }),
    });
    expect(syncPatch.status).toBe(200);

    const dbRowAfterSync = await db
      .prepare("SELECT updates_until, max_app_version FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<{ updates_until: string | null; max_app_version: string | null }>();
    expect(dbRowAfterSync?.updates_until).toBe("2028-06-30T00:00:00Z");
    expect(dbRowAfterSync?.max_app_version).toBe("1.5.0");

    const afterSync = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(afterSync.body.license.entitlements.updates_until).toBe(
      "2028-06-30T00:00:00Z"
    );
    expect(afterSync.body.license.entitlements.max_app_version).toBe("1.5.0");
    expect(afterSync.body.license.entitlements.products).toEqual([
      "desktop",
      "vectorizer_extension",
    ]);

    // 12c. Clearing optional values (null) clears BOTH top-level columns and parsed entitlements
    const clearPatch = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "PATCH",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        entitlements: {
          updates_until: null,
          max_app_version: null,
          max_accounts: null,
        },
      }),
    });
    expect(clearPatch.status).toBe(200);

    const dbRowAfterClear = await db
      .prepare("SELECT updates_until, max_app_version FROM licenses WHERE id = ?1")
      .bind(licenseId)
      .first<{ updates_until: string | null; max_app_version: string | null }>();
    expect(dbRowAfterClear?.updates_until).toBeNull();
    expect(dbRowAfterClear?.max_app_version).toBeNull();

    const afterClear = await callApi(`/v1/admin/licenses/${licenseId}`, {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(afterClear.body.license.entitlements.updates_until).toBeNull();
    expect(afterClear.body.license.entitlements.max_app_version).toBeNull();
    expect(afterClear.body.license.entitlements.max_accounts).toBeNull();
    expect(afterClear.body.license.entitlements.products).toEqual([
      "desktop",
      "vectorizer_extension",
    ]);
  });

  // ---------------------------------------------------------------------------
  // TEST 13 (LM-02): GET /v1/admin/me — Identity, RBAC Permissions & Sanitization
  // ---------------------------------------------------------------------------
  it("13. GET /v1/admin/me returns sanitized admin identity/permissions and rejects unauthorized requests", async () => {
    const unauth = await callApi("/v1/admin/me", { method: "GET" });
    expect(unauth.status).toBe(401);

    const badToken = await callApi("/v1/admin/me", {
      method: "GET",
      headers: adminHeaders("ssadm_invalid_token"),
    });
    expect(badToken.status).toBe(401);

    const superMe = await callApi("/v1/admin/me", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(superMe.status).toBe(200);
    expect(superMe.body.ok).toBe(true);
    expect(superMe.body.admin.role).toBe("super_admin");
    expect(superMe.body.admin.permissions).toContain("licenses:create");
    expect(superMe.body.admin.permissions).toContain("licenses:revoke");
    expect(superMe.body.environment).toBe(env.ENVIRONMENT ?? "development");
    expect(superMe.body.signing_kid).toBe("sspro-ed25519-test-01");
    expect("key_hash" in superMe.body.admin).toBe(false);
    expect(JSON.stringify(superMe.body)).not.toContain(superAdminToken);

    const roMe = await callApi("/v1/admin/me", {
      method: "GET",
      headers: adminHeaders(readOnlyAdminToken),
    });
    expect(roMe.status).toBe(200);
    expect(roMe.body.admin.role).toBe("read_only");
    expect(roMe.body.admin.permissions).toEqual([
      "licenses:read",
      "stats:read",
      "events:read",
    ]);
  });

  // ---------------------------------------------------------------------------
  // TEST 14 (LM-02): GET /v1/admin/licenses — Cursor Pagination, Search, Filters,
  // Tampering, SQL Injection Protection & Sensitive Field Exclusion
  // ---------------------------------------------------------------------------
  it("14. GET /v1/admin/licenses enforces cursor pagination, filters, search, SQLi safety, and strips sensitive fields", async () => {
    const unauth = await callApi("/v1/admin/licenses", { method: "GET" });
    expect(unauth.status).toBe(401);

    const t1 = new Date("2026-11-20T16:00:01Z");
    const t2 = new Date("2026-11-20T16:00:02Z");
    const t3 = new Date("2026-11-20T16:00:03Z");
    const t4 = new Date("2026-11-20T16:00:04Z");

    const c1 = await callApi(
      "/v1/admin/licenses",
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({
          plan_code: "lifetime",
          plan_name: "Lifetime Pro",
          license_type: "perpetual",
          billing_interval: "lifetime",
          customer_email: "alice@studio.test",
          customer_name: "Alice Creator",
          external_order_id: "ORD-1001",
          entitlements: { products: ["desktop", "vectorizer_extension"] },
        }),
      },
      t1
    );
    const c2 = await callApi(
      "/v1/admin/licenses",
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({
          plan_code: "pro_monthly",
          plan_name: "Pro Monthly",
          license_type: "subscription",
          billing_interval: "monthly",
          current_period_start: "2026-11-20T16:00:00Z",
          current_period_end: "2026-11-25T16:00:00Z",
          customer_email: "bob@studio.test",
          customer_name: "Bob Designer",
          external_order_id: "ORD-1002",
          entitlements: { products: ["desktop"] },
        }),
      },
      t2
    );
    const c3 = await callApi(
      "/v1/admin/licenses",
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({
          plan_code: "pro_yearly",
          plan_name: "Pro Yearly",
          license_type: "subscription",
          billing_interval: "yearly",
          current_period_start: "2026-11-20T16:00:00Z",
          current_period_end: "2027-11-20T16:00:00Z",
          customer_email: "carol@studio.test",
          external_order_id: "ORD-1003",
          entitlements: { products: ["desktop", "vectorizer_extension"] },
        }),
      },
      t3
    );
    const c4 = await callApi(
      "/v1/admin/licenses",
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({
          plan_code: "lifetime",
          plan_name: "Lifetime Legacy",
          license_type: "perpetual",
          billing_interval: "lifetime",
          customer_email: "dave@studio.test",
        }),
      },
      t4
    );

    const idsDesc = [
      c4.body.license.license_id,
      c3.body.license.license_id,
      c2.body.license.license_id,
      c1.body.license.license_id,
    ];

    // Stable keyset cursor pagination (limit=2 -> 2 pages, deterministic order, no duplicates)
    const p1 = await callApi("/v1/admin/licenses?limit=2&sort=created_desc", {
      method: "GET",
      headers: adminHeaders(readOnlyAdminToken),
    });
    expect(p1.status).toBe(200);
    expect(p1.body.items.length).toBe(2);
    expect(p1.body.pagination.has_more).toBe(true);
    expect(typeof p1.body.pagination.next_cursor).toBe("string");

    const p2 = await callApi(
      `/v1/admin/licenses?limit=2&sort=created_desc&cursor=${encodeURIComponent(
        p1.body.pagination.next_cursor
      )}`,
      { method: "GET", headers: adminHeaders(readOnlyAdminToken) }
    );
    expect(p2.status).toBe(200);
    expect(p2.body.items.length).toBe(2);
    expect(p2.body.pagination.has_more).toBe(false);
    expect(p2.body.pagination.next_cursor).toBeNull();

    const collectedIds = [
      ...p1.body.items.map((x: any) => x.license_id),
      ...p2.body.items.map((x: any) => x.license_id),
    ];
    expect(collectedIds).toEqual(idsDesc);

    // Sensitive-field exclusion check
    for (const item of [...p1.body.items, ...p2.body.items]) {
      expect("key_hash" in item).toBe(false);
      expect("license_key" in item).toBe(false);
      expect("key_pepper_version" in item).toBe(false);
      expect("idempotency_key" in item).toBe(false);
    }
    const serialized = JSON.stringify(p1.body) + JSON.stringify(p2.body);
    expect(serialized).not.toContain(c1.body.license_key);
    expect(serialized).not.toContain(c2.body.license_key);

    // Filters: product=vectorizer_extension (c1 & c3 only), product=desktop (all 4 incl legacy c4)
    const extOnly = await callApi("/v1/admin/licenses?product=vectorizer_extension", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(extOnly.status).toBe(200);
    expect(extOnly.body.items.map((x: any) => x.license_id)).toEqual([
      c3.body.license.license_id,
      c1.body.license.license_id,
    ]);

    const deskOnly = await callApi("/v1/admin/licenses?product=desktop", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(deskOnly.status).toBe(200);
    expect(deskOnly.body.items.length).toBe(4);

    // Filters: plan_code, license_type, billing_interval, search q
    const byEmail = await callApi("/v1/admin/licenses?q=alice@studio.test", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(byEmail.body.items.map((x: any) => x.license_id)).toEqual([
      c1.body.license.license_id,
    ]);

    const byOrder = await callApi("/v1/admin/licenses?q=ORD-1002", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(byOrder.body.items.map((x: any) => x.license_id)).toEqual([
      c2.body.license.license_id,
    ]);

    // Cursor tampering & sort-mismatch & invalid limit
    const tampered = await callApi("/v1/admin/licenses?cursor=not_valid_base64!!!", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(tampered.status).toBe(400);

    const sortMismatch = await callApi(
      `/v1/admin/licenses?sort=created_asc&cursor=${encodeURIComponent(
        p1.body.pagination.next_cursor
      )}`,
      { method: "GET", headers: adminHeaders(superAdminToken) }
    );
    expect(sortMismatch.status).toBe(400);

    const badLimit = await callApi("/v1/admin/licenses?limit=999", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(badLimit.status).toBe(400);

    // SQL injection payload in search q returns 200 with 0 matches & leaves DB intact
    const sqli = await callApi(
      `/v1/admin/licenses?q=${encodeURIComponent("' OR '1'='1'; DROP TABLE licenses;--")}`,
      { method: "GET", headers: adminHeaders(superAdminToken) }
    );
    expect(sqli.status).toBe(200);
    expect(sqli.body.items).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // TEST 15 (LM-02): GET /v1/admin/stats — Real D1 Aggregate Counts
  // ---------------------------------------------------------------------------
  it("15. GET /v1/admin/stats returns real aggregate license, subscription, and active device counts", async () => {
    const unauth = await callApi("/v1/admin/stats", { method: "GET" });
    expect(unauth.status).toBe(401);

    // Issue 1 perpetual (activated), 1 monthly (expiring within 7d, activated), 1 yearly (suspended), 1 perpetual (revoked)
    const lPerp = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "lifetime",
        plan_name: "Lifetime",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });
    const lMon = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "pro_monthly",
        plan_name: "Monthly",
        license_type: "subscription",
        billing_interval: "monthly",
        current_period_start: "2026-11-20T00:00:00Z",
        current_period_end: "2026-11-24T00:00:00Z",
      }),
    });
    const lYear = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "pro_yearly",
        plan_name: "Yearly",
        license_type: "subscription",
        billing_interval: "yearly",
        current_period_start: "2026-11-20T00:00:00Z",
        current_period_end: "2027-11-20T00:00:00Z",
      }),
    });
    const lRev = await callApi("/v1/admin/licenses", {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({
        plan_code: "lifetime",
        plan_name: "Lifetime Rev",
        license_type: "perpetual",
        billing_interval: "lifetime",
      }),
    });

    await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: lPerp.body.license_key, device: device1 }),
    });
    await callApi("/v1/licenses/activate", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ license_key: lMon.body.license_key, device: device2 }),
    });
    await callApi(`/v1/admin/licenses/${lYear.body.license.license_id}/suspend`, {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({ reason: "test suspend" }),
    });
    await callApi(`/v1/admin/licenses/${lRev.body.license.license_id}/revoke`, {
      method: "POST",
      headers: adminHeaders(superAdminToken),
      body: JSON.stringify({ reason: "test revoke" }),
    });

    const statsRes = await callApi("/v1/admin/stats", {
      method: "GET",
      headers: adminHeaders(readOnlyAdminToken),
    });
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.stats.total_licenses).toBe(4);
    expect(statsRes.body.stats.by_status.active).toBe(2);
    expect(statsRes.body.stats.by_status.suspended).toBe(1);
    expect(statsRes.body.stats.by_status.revoked).toBe(1);
    expect(statsRes.body.stats.by_status.pending_activation).toBe(0);
    expect(statsRes.body.stats.by_license_type.perpetual).toBe(2);
    expect(statsRes.body.stats.by_license_type.subscription).toBe(2);
    expect(statsRes.body.stats.by_billing_interval.monthly).toBe(1);
    expect(statsRes.body.stats.by_billing_interval.yearly).toBe(1);
    expect(statsRes.body.stats.active_device_activations).toBe(2);
    expect(statsRes.body.stats.expiring_within_7d).toBe(1);
    expect(statsRes.body.stats.issued_last_30d).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // TEST 16 (LM-02): GET /v1/admin/events — Pagination, Filters, RBAC & Sanitization
  // ---------------------------------------------------------------------------
  it("16. GET /v1/admin/events supports cursor pagination, filters, RBAC enforcement, and metadata sanitization", async () => {
    const unauth = await callApi("/v1/admin/events", { method: "GET" });
    expect(unauth.status).toBe(401);

    // Create a billing_system admin key -> must be forbidden (403) on /v1/admin/events
    const billingAdminId = generatePrefixedId("adm", baseNow.getTime() + 99);
    const { adminApiKey: billingToken, keyPrefix: billingPrefix } =
      generateAdminApiKey(billingAdminId);
    const billingHash = await hashAdminApiKey(env.ADMIN_TOKEN_PEPPER, billingToken);
    await db
      .prepare(
        `INSERT INTO admin_api_keys (id, name, key_prefix, key_hash, role, status, created_at)
         VALUES (?1, 'Billing Test', ?2, ?3, 'billing_system', 'active', ?4)`
      )
      .bind(billingAdminId, billingPrefix, billingHash, baseNow.toISOString())
      .run();

    const forbidden = await callApi("/v1/admin/events", {
      method: "GET",
      headers: adminHeaders(billingToken),
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN_ROLE");

    // Generate 3 distinct events on one license across sequential timestamps
    const lic = await callApi(
      "/v1/admin/licenses",
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({
          plan_code: "lifetime",
          plan_name: "Lifetime",
          license_type: "perpetual",
          billing_interval: "lifetime",
        }),
      },
      new Date("2026-11-20T16:01:00Z")
    );
    const licId = lic.body.license.license_id as string;

    await callApi(
      `/v1/admin/licenses/${licId}/suspend`,
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({ reason: "audit check" }),
      },
      new Date("2026-11-20T16:02:00Z")
    );
    await callApi(
      `/v1/admin/licenses/${licId}/reinstate`,
      {
        method: "POST",
        headers: adminHeaders(superAdminToken),
        body: JSON.stringify({ reason: "audit clear" }),
      },
      new Date("2026-11-20T16:03:00Z")
    );

    // Paginate limit=2 then page 2
    const e1 = await callApi(`/v1/admin/events?license_id=${licId}&limit=2`, {
      method: "GET",
      headers: adminHeaders(readOnlyAdminToken),
    });
    expect(e1.status).toBe(200);
    expect(e1.body.items.length).toBe(2);
    expect(e1.body.pagination.has_more).toBe(true);
    expect(e1.body.items[0].event_type).toBe("license.reinstated");
    expect(e1.body.items[1].event_type).toBe("license.suspended");
    expect(e1.body.items[0].ip_hash_prefix?.length ?? 0).toBeLessThanOrEqual(12);
    expect("ip_hash" in e1.body.items[0]).toBe(false);

    const e2 = await callApi(
      `/v1/admin/events?license_id=${licId}&limit=2&cursor=${encodeURIComponent(
        e1.body.pagination.next_cursor
      )}`,
      { method: "GET", headers: adminHeaders(readOnlyAdminToken) }
    );
    expect(e2.status).toBe(200);
    expect(e2.body.items.length).toBe(1);
    expect(e2.body.items[0].event_type).toBe("license.issued");
    expect(e2.body.pagination.has_more).toBe(false);

    // Filter by event_type + date range
    const filtered = await callApi(
      `/v1/admin/events?license_id=${licId}&event_type=license.suspended&from=2026-11-20T16:01:30Z&to=2026-11-20T16:02:30Z`,
      { method: "GET", headers: adminHeaders(superAdminToken) }
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.length).toBe(1);
    expect(filtered.body.items[0].event_type).toBe("license.suspended");

    // Invalid date range & tampered cursor rejected with 400
    const badRange = await callApi(
      "/v1/admin/events?from=2026-11-21T00:00:00Z&to=2026-11-20T00:00:00Z",
      { method: "GET", headers: adminHeaders(superAdminToken) }
    );
    expect(badRange.status).toBe(400);

    const badCursor = await callApi("/v1/admin/events?cursor=tampered!!!", {
      method: "GET",
      headers: adminHeaders(superAdminToken),
    });
    expect(badCursor.status).toBe(400);
  });
});
