// =============================================================================
// StockStudio Pro License API — Production Bootstrap & Migration Safeguard Tests
//
// Uses 100% mocked Cloudflare/Wrangler dependencies. NEVER touches Cloudflare,
// NEVER writes real production files, and NEVER generates real prod secrets.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  BootstrapStepError,
  decryptRecoveryBundle,
  PROTECTED_PRODUCTION_SECRETS,
  runProductionBootstrap,
  // @ts-expect-error ESM operational script tested with mocked dependencies
} from "../scripts/bootstrap-production.mjs";
// @ts-expect-error ESM operational script tested with mocked dependencies
import { runProductionMigration } from "../scripts/migrate-production.mjs";

const SYNTHETIC_PROD_D1_ID = "11111111-2222-4333-8444-555555555555";
const STAGING_D1_ID = "870f9578-82ab-4516-b45f-5300ed3f5e29";
const TEST_PASSPHRASE = "Synthetic-Test-Recovery-Passphrase-2026!";

function makeToml(prodDbId: string): string {
  return `
[env.production]
name = "stockstudio-pro-license-api-prod"
workers_dev = false

[[env.production.d1_databases]]
binding = "DB"
database_name = "stockstudio-pro-licenses-prod"
database_id = "${prodDbId}"
migrations_dir = "migrations"
`;
}

describe("Production Bootstrap Safeguards (Mocked Wrangler/D1)", () => {
  const validEnv = {
    CONFIRM_PRODUCTION_D1_ID: SYNTHETIC_PROD_D1_ID,
    BOOTSTRAP_RECOVERY_PASSPHRASE: TEST_PASSPHRASE,
  };

  it("1. Aborts before uploading any secrets when D1 already contains signing_keys", async () => {
    const uploaded: string[] = [];
    await expect(
      runProductionBootstrap({
        argv: ["--confirm-production"],
        env: validEnv,
        tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
        runRemoteProdD1Json: (sql: string) =>
          sql.includes("signing_keys") ? [{ count: 1 }] : [{ count: 0 }],
        listProdSecretNames: () => [],
        putProdSecret: (name: string) => uploaded.push(name),
        writeRecoveryFile: () => {},
        lockFileAcl: () => {},
        log: () => {},
      })
    ).rejects.toThrow(/non-empty production D1/i);
    expect(uploaded).toEqual([]);
  });

  it("2. Aborts before uploading any secrets when D1 contains admin_api_keys or licenses", async () => {
    const uploaded: string[] = [];
    await expect(
      runProductionBootstrap({
        argv: ["--confirm-production"],
        env: validEnv,
        tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
        runRemoteProdD1Json: (sql: string) =>
          sql.includes("admin_api_keys") ? [{ count: 1 }] : [{ count: 0 }],
        listProdSecretNames: () => [],
        putProdSecret: (name: string) => uploaded.push(name),
        writeRecoveryFile: () => {},
        lockFileAcl: () => {},
        log: () => {},
      })
    ).rejects.toThrow(/non-empty production D1/i);

    await expect(
      runProductionBootstrap({
        argv: ["--confirm-production"],
        env: validEnv,
        tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
        runRemoteProdD1Json: (sql: string) =>
          sql.includes("licenses") ? [{ count: 2 }] : [{ count: 0 }],
        listProdSecretNames: () => [],
        putProdSecret: (name: string) => uploaded.push(name),
        writeRecoveryFile: () => {},
        lockFileAcl: () => {},
        log: () => {},
      })
    ).rejects.toThrow(/non-empty production D1/i);

    expect(uploaded).toEqual([]);
  });

  it("3. Aborts before uploading when ANY protected production secret already exists", async () => {
    for (const secretName of PROTECTED_PRODUCTION_SECRETS) {
      const uploaded: string[] = [];
      await expect(
        runProductionBootstrap({
          argv: ["--confirm-production"],
          env: validEnv,
          tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
          runRemoteProdD1Json: () => [{ count: 0 }],
          listProdSecretNames: () => [secretName],
          putProdSecret: (name: string) => uploaded.push(name),
          writeRecoveryFile: () => {},
          lockFileAcl: () => {},
          log: () => {},
        })
      ).rejects.toThrow(new RegExp(secretName));
      expect(uploaded).toEqual([]);
    }
  });

  it("4. Handles partial upload failure safely and blocks rerun from overwriting uploaded secrets", async () => {
    const cloudflareSecrets = new Map<string, string>();
    const logs: string[] = [];
    let recoveryWritten = "";

    // Run 1: fails on the 3rd secret (IP_HASH_SALT)
    await expect(
      runProductionBootstrap({
        argv: ["--confirm-production"],
        env: validEnv,
        tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
        runRemoteProdD1Json: () => [{ count: 0 }],
        listProdSecretNames: () => [...cloudflareSecrets.keys()],
        putProdSecret: (name: string, value: string) => {
          if (name === "IP_HASH_SALT") {
            throw new Error(`simulated network drop with secret=${value}`);
          }
          cloudflareSecrets.set(name, value);
        },
        writeRecoveryFile: (_p: string, content: string) => {
          recoveryWritten = content;
        },
        lockFileAcl: () => {},
        log: (m: string) => logs.push(m),
      })
    ).rejects.toThrow(/step:secret_upload/);

    expect([...cloudflareSecrets.keys()]).toEqual([
      "LICENSE_KEY_PEPPER",
      "ADMIN_TOKEN_PEPPER",
    ]);
    expect(recoveryWritten.length).toBeGreaterThan(0);

    // Run 2 (retry): MUST abort during secret_preflight and NOT overwrite existing secrets
    const originalPepper = cloudflareSecrets.get("LICENSE_KEY_PEPPER");
    await expect(
      runProductionBootstrap({
        argv: ["--confirm-production"],
        env: validEnv,
        tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
        runRemoteProdD1Json: () => [{ count: 0 }],
        listProdSecretNames: () => [...cloudflareSecrets.keys()],
        putProdSecret: (name: string, value: string) => {
          cloudflareSecrets.set(name, value);
        },
        writeRecoveryFile: () => {},
        lockFileAcl: () => {},
        log: () => {},
      })
    ).rejects.toThrow(/Refusing to overwrite existing production secrets/i);

    expect(cloudflareSecrets.get("LICENSE_KEY_PEPPER")).toBe(originalPepper);
  });

  it("5. Never leaks secrets in logs or errors and produces a decryptable AES-256-GCM recovery bundle", async () => {
    const uploadedValues = new Map<string, string>();
    const logs: string[] = [];
    let recoveryJson = "";
    let aclLocked = false;

    const result = await runProductionBootstrap({
      argv: ["--confirm-production"],
      env: validEnv,
      tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
      runRemoteProdD1Json: (sql: string) =>
        sql.startsWith("SELECT COUNT") ? [{ count: 0 }] : [],
      listProdSecretNames: () => [],
      putProdSecret: (name: string, value: string) => {
        uploadedValues.set(name, value);
      },
      writeRecoveryFile: (_p: string, content: string) => {
        recoveryJson = content;
      },
      lockFileAcl: () => {
        aclLocked = true;
      },
      log: (m: string) => logs.push(m),
    });

    expect(aclLocked).toBe(true);
    expect(result.uploadedSecrets).toEqual([...PROTECTED_PRODUCTION_SECRETS]);

    // Encrypted recovery file must NOT contain plaintext secrets
    const licensePepper = uploadedValues.get("LICENSE_KEY_PEPPER")!;
    const adminPepper = uploadedValues.get("ADMIN_TOKEN_PEPPER")!;
    const ipSalt = uploadedValues.get("IP_HASH_SALT")!;
    const privJwk = uploadedValues.get("LICENSE_SIGNING_PRIVATE_KEY_JWK")!;

    const allLogs = logs.join("\n");
    for (const secret of [licensePepper, adminPepper, ipSalt, privJwk, TEST_PASSPHRASE]) {
      expect(allLogs).not.toContain(secret);
      expect(recoveryJson).not.toContain(secret);
    }

    // Encrypted bundle decrypts cleanly with recovery passphrase
    const decrypted = decryptRecoveryBundle(
      JSON.parse(recoveryJson),
      TEST_PASSPHRASE
    );
    expect(decrypted.LICENSE_KEY_PEPPER).toBe(licensePepper);
    expect(decrypted.ADMIN_TOKEN_PEPPER).toBe(adminPepper);
    expect(decrypted.IP_HASH_SALT).toBe(ipSalt);
    expect(decrypted.admin_api_key).toMatch(/^ssadm_/);
    expect(allLogs).not.toContain(decrypted.admin_api_key);

    // Verify sanitized error never leaks raw secret value if upload fails
    let caughtErr: unknown;
    try {
      await runProductionBootstrap({
        argv: ["--confirm-production"],
        env: validEnv,
        tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
        runRemoteProdD1Json: () => [{ count: 0 }],
        listProdSecretNames: () => [],
        putProdSecret: (_name: string, value: string) => {
          throw new Error(`raw wrangler leak: ${value}`);
        },
        writeRecoveryFile: () => {},
        lockFileAcl: () => {},
        log: () => {},
      });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(BootstrapStepError);
    expect((caughtErr as Error).message).not.toContain("raw wrangler leak");
  });
});

describe("Production Migration Safeguards (Mocked Wrangler)", () => {
  it("6. Rejects placeholder, staging, dev, wrong confirmation ID, and wrong environment arguments", () => {
    const execCalls: string[][] = [];
    const mockExec = (_cmd: string, args: string[]) => execCalls.push(args);

    // Rejects placeholder ID
    expect(() =>
      runProductionMigration({
        argv: ["--confirm-production"],
        env: { CONFIRM_PRODUCTION_D1_ID: "REPLACE_WITH_PRODUCTION_D1_DATABASE_ID" },
        tomlContent: makeToml("REPLACE_WITH_PRODUCTION_D1_DATABASE_ID"),
        execFn: mockExec,
        log: () => {},
      })
    ).toThrow(/invalid or placeholder database_id/i);

    // Rejects staging D1 ID
    expect(() =>
      runProductionMigration({
        argv: ["--confirm-production"],
        env: { CONFIRM_PRODUCTION_D1_ID: STAGING_D1_ID },
        tomlContent: makeToml(STAGING_D1_ID),
        execFn: mockExec,
        log: () => {},
      })
    ).toThrow(/invalid or placeholder database_id/i);

    // Rejects dev zero UUID
    expect(() =>
      runProductionMigration({
        argv: ["--confirm-production"],
        env: { CONFIRM_PRODUCTION_D1_ID: "00000000-0000-0000-0000-000000000000" },
        tomlContent: makeToml("00000000-0000-0000-0000-000000000000"),
        execFn: mockExec,
        log: () => {},
      })
    ).toThrow(/invalid or placeholder database_id/i);

    // Rejects mismatched CONFIRM_PRODUCTION_D1_ID
    expect(() =>
      runProductionMigration({
        argv: ["--confirm-production"],
        env: { CONFIRM_PRODUCTION_D1_ID: "99999999-9999-4999-8999-999999999999" },
        tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
        execFn: mockExec,
        log: () => {},
      })
    ).toThrow(/Production safety gate blocked/i);

    // Rejects wrong environment flags (--local, --env staging, staging)
    for (const badArg of ["--local", "--env", "--env=staging", "staging", "development"]) {
      expect(() =>
        runProductionMigration({
          argv: ["--confirm-production", badArg],
          env: { CONFIRM_PRODUCTION_D1_ID: SYNTHETIC_PROD_D1_ID },
          tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
          execFn: mockExec,
          log: () => {},
        })
      ).toThrow(/unsupported environment argument/i);
    }

    expect(execCalls).toEqual([]);

    // Accepts exact valid UUID + confirmation in --dry-run targeting --env production --remote
    const dryRes = runProductionMigration({
      argv: ["--confirm-production", "--dry-run"],
      env: { CONFIRM_PRODUCTION_D1_ID: SYNTHETIC_PROD_D1_ID },
      tomlContent: makeToml(SYNTHETIC_PROD_D1_ID),
      execFn: mockExec,
      log: () => {},
    });
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.cmdArgs).toContain("--env");
    expect(dryRes.cmdArgs).toContain("production");
    expect(dryRes.cmdArgs).toContain("--remote");
    expect(execCalls).toEqual([]);
  });
});
