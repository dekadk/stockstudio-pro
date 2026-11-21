#!/usr/bin/env node
// =============================================================================
// StockStudio Pro License API — Guarded Production D1 Migration Runner
//
// Safety Guarantees:
//   - NEVER creates Cloudflare Workers, D1 databases, or domains.
//   - Refuses to run if `[env.production]` in `wrangler.toml` still contains
//     a placeholder `database_id` or matches the staging/dev D1 ID.
//   - Requires explicit `--confirm-production` CLI flag AND
//     `CONFIRM_PRODUCTION_D1_ID=<exact-prod-d1-uuid>` environment variable.
//   - Hardcodes `--env production --remote` (rejects any conflicting env flags).
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_IDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "870f9578-82ab-4516-b45f-5300ed3f5e29", // staging D1 ID
  "replace_with_production_d1_database_id",
]);

export function extractProductionD1Id(tomlContent) {
  const prodD1Match = tomlContent.match(
    /\[\[env\.production\.d1_databases\]\][\s\S]*?database_id\s*=\s*"([^"]+)"/
  );
  if (!prodD1Match) {
    throw new Error(
      "Missing [[env.production.d1_databases]] database_id in wrangler.toml."
    );
  }
  return prodD1Match[1].trim();
}

export function runProductionMigration(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const toml = options.tomlContent ?? readFileSync(wranglerTomlPath, "utf8");
  const execFn =
    options.execFn ??
    ((cmd, args) =>
      execFileSync(cmd, args, {
        cwd: workerRoot,
        stdio: "inherit",
      }));
  const log = options.log ?? ((msg) => console.log(msg));

  // Reject any attempt to override target environment or run locally
  for (const arg of argv) {
    if (
      arg === "--local" ||
      arg === "--env" ||
      arg.startsWith("--env=") ||
      arg === "staging" ||
      arg === "development"
    ) {
      throw new Error(
        `Refusing unsupported environment argument '${arg}'. This script targets '--env production --remote' exclusively.`
      );
    }
  }

  const args = new Set(argv);
  const isDryRun = args.has("--dry-run");
  const hasConfirmFlag = args.has("--confirm-production");

  const prodD1Id = extractProductionD1Id(toml);

  if (
    FORBIDDEN_IDS.has(prodD1Id.toLowerCase()) ||
    !UUID_REGEX.test(prodD1Id)
  ) {
    throw new Error(
      `Refusing to migrate production: invalid or placeholder database_id ('${prodD1Id}'). Provision production D1 and update wrangler.toml first.`
    );
  }

  const confirmedId = (env.CONFIRM_PRODUCTION_D1_ID ?? "").trim();
  if (!hasConfirmFlag || confirmedId !== prodD1Id) {
    throw new Error(
      "Production safety gate blocked execution. Re-run with both '--confirm-production' and CONFIRM_PRODUCTION_D1_ID=<exact-wrangler-prod-d1-id>."
    );
  }

  const cmdArgs = [
    wranglerBin,
    "d1",
    "migrations",
    "apply",
    "DB",
    "--env",
    "production",
    "--remote",
  ];

  if (isDryRun) {
    log(
      `[db:migrate:prod] DRY RUN OK — validated production D1 target (${prodD1Id}).`
    );
    return { dryRun: true, databaseId: prodD1Id, cmdArgs };
  }

  log(
    `[db:migrate:prod] Applying remote migrations to production D1 (${prodD1Id})...`
  );
  execFn(process.execPath, cmdArgs);
  return { dryRun: false, databaseId: prodD1Id, cmdArgs };
}

const isMainModule =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    runProductionMigration();
  } catch (err) {
    console.error("[db:migrate:prod] Aborted:", err.message || err);
    process.exit(1);
  }
}
