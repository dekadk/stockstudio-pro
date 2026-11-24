# TASK G-G2.1: Production Readiness Code Preparation Report

**Project:** StockStudio Pro Unified Licensing (`0.2.0`)  
**Scope:** Code-level production preparation in `workers/license-api` (no Cloudflare resources created, no remote migrations/deployments executed, no version bump, no Git commit/push).  
**Status:** **COMPLETE — ALL AUTOMATED TESTS & SAFEGUARDS PASSED**

---

## 1. Files Changed

| File | Change Type | Purpose |
| --- | :---: | --- |
| `workers/license-api/src/types.ts` | Modified | Added `ProductEntitlementId`, `SUPPORTED_PRODUCT_ENTITLEMENTS`, optional `products?: ProductEntitlementId[]` on `LicenseEntitlements`, required `IP_HASH_SALT: string` on `Env`, and `clientIp: string` on `RequestContext`. |
| `workers/license-api/src/utils.ts` | Modified | Added `validateAndNormalizeProducts()` and `validateEntitlementsInput()`, and updated `parseEntitlements()` to preserve validated `products` without inventing `products` for legacy feature-only rows. |
| `workers/license-api/src/admin-handlers.ts` | Modified | Enforced `admin_api_keys.allowed_ips_json` in `authenticateAdmin()`; wired `validateEntitlementsInput()` into `POST /v1/admin/licenses` and `PATCH /v1/admin/licenses/:id`; returned `entitlements` in the `201` creation response. |
| `workers/license-api/src/crypto.ts` | Modified | Removed insecure `"default-salt"` fallback in `hashClientIp()`; fails closed with `503 SERVICE_UNAVAILABLE` when `IP_HASH_SALT` is missing or `< 16` chars. |
| `workers/license-api/src/index.ts` | Modified | Populated `ctx.clientIp` from the resolved client IP for admin allowlist enforcement. |
| `workers/license-api/wrangler.toml` | Modified | Added `[env.production]`, `[env.production.vars]`, and `[[env.production.d1_databases]]` with explicit placeholder `database_id` (`REPLACE_WITH_PRODUCTION_D1_DATABASE_ID`) while leaving `development` and `[env.staging]` unchanged. |
| `workers/license-api/package.json` | Modified | Added `db:migrate:prod` and `prod:bootstrap` scripts pointing to guarded Node wrappers. |
| `workers/license-api/scripts/migrate-production.mjs` | Created | Guarded production D1 migration runner with placeholder/staging ID rejection and explicit `--confirm-production` + `CONFIRM_PRODUCTION_D1_ID` gate. |
| `workers/license-api/scripts/bootstrap-production.mjs` | Created | Guarded production secrets + initial D1 `signing_keys` / `super_admin` bootstrap script (never creates Cloudflare resources, never prints secrets). |
| `workers/license-api/tests/license-api.test.ts` | Modified | Added Tests 8, 9, and 10 covering `entitlements.products`, `IP_HASH_SALT` fail-closed behavior, and `allowed_ips_json` enforcement. |
| `docs/licensing/G-G2.1-code-preparation-report.md` | Created | This report. |

---

## 2. Technical Changes & Entitlement Data Flow

### Before (G-G2A Audit Finding)
1. `POST /v1/admin/licenses` copied only `{ features, max_accounts, updates_until, max_app_version }`, silently dropping `entitlements.products`.
2. `PATCH /v1/admin/licenses/:id` wrote raw `body.entitlements` without validating product identifiers.
3. `parseEntitlements()` (used by `GET /v1/admin/licenses/:id`, `POST /v1/licenses/activate`, and `POST /v1/licenses/validate`) stripped `products` when building `SignedLeasePayload.entitlements`.
4. As a result, unified licenses issued with `products: ["desktop", "vectorizer_extension"]` would have been denied (`PRODUCT_NOT_ENTITLED`) by `stockstudio-nmh.exe` unless `"vectorizer_extension"` was stuffed into `features`.

### After (G-G2.1)
1. **Validation (`validateEntitlementsInput` / `validateAndNormalizeProducts`):**
   - Accepts supported product identifiers: `desktop`, `vectorizer_extension` (normalized lowercase, deduplicated, order-preserved).
   - Rejects unsupported product IDs, empty `products: []`, non-array `products`, or non-object `entitlements` with `400 INVALID_REQUEST`.
   - Allows `desktop` + `vectorizer_extension` to coexist with `features: []` (no `features` workaround).
2. **Persistence & Retrieval:**
   - `entitlements_json` stores `products` natively when provided.
   - `POST /v1/admin/licenses` (`201`), `GET /v1/admin/licenses/:id`, and `PATCH /v1/admin/licenses/:id` all preserve and return `entitlements.products` without data loss.
3. **Signed Leases:**
   - `buildSignedLeasePayload()` includes `entitlements.products` inside the Ed25519-signed `v1.<payload>.<sig>` lease token on both `/v1/licenses/activate` and `/v1/licenses/validate`.
4. **Backward Compatibility:**
   - Legacy licenses created without `products` (features-only) do **not** have a `products` field synthesized, preserving `stockstudio-license-core`'s legacy rule (authorized for `desktop`, denied for `vectorizer_extension`).
   - Corrupted `entitlements_json` in D1 falls back safely to `DEFAULT_ENTITLEMENTS` without granting `vectorizer_extension`.

### Security Hardening
- **`IP_HASH_SALT`:** Removed `salt ?? "default-salt"` fallback in `hashClientIp()`. Missing or `< 16`-character `IP_HASH_SALT` fails closed with `503 SERVICE_UNAVAILABLE` and never logs secret values.
- **`admin_api_keys.allowed_ips_json`:** Enforced in `authenticateAdmin()` for all `/v1/admin/*` endpoints. `NULL`, empty string, or `[]` remain unrestricted; non-empty allowlists permit only listed IPs and reject others with `403 FORBIDDEN_ROLE`; malformed JSON fails closed with `403 FORBIDDEN_ROLE`.

---

## 3. Production Configuration Prepared (`wrangler.toml`)

Added isolated `[env.production]` without altering `development` or `[env.staging]`:

```toml
[env.production]
name = "stockstudio-pro-license-api-prod"
workers_dev = false

[env.production.vars]
ENVIRONMENT = "production"
PRODUCT_ID = "com.stockstudiopro.desktop"
ISSUER = "stockstudiopro-license-server"
DEFAULT_DEVICE_LIMIT = "2"
LEASE_TTL_DAYS = "7"
MAX_CLOCK_SKEW_SECONDS = "300"
LICENSE_KEY_PEPPER_VERSION = "1"
LICENSE_SIGNING_KID = "sspro-ed25519-prod-01"

[[env.production.d1_databases]]
binding = "DB"
database_name = "stockstudio-pro-licenses-prod"
database_id = "REPLACE_WITH_PRODUCTION_D1_DATABASE_ID"
migrations_dir = "migrations"
```

---

## 4. Migration, Bootstrap & Backup/Restore Prerequisites

### Script Safeguards (`migrate-production.mjs` & `bootstrap-production.mjs`)
- **No resource creation:** Neither script creates Cloudflare Workers, D1 databases, or DNS routes.
- **Hard environment guards:** Both parse `[[env.production.d1_databases]]` from `wrangler.toml` and abort with exit code `1` if:
  - `database_id` is a placeholder (`REPLACE_WITH_PRODUCTION_D1_DATABASE_ID`), dev ID (`00000000-...`), staging ID (`870f9578-82ab-4516-b45f-5300ed3f5e29`), or not a valid UUID.
  - `--confirm-production` CLI flag is omitted, OR `CONFIRM_PRODUCTION_D1_ID` env var does not exactly match the configured production `database_id`.
- **Secret hygiene:** `bootstrap-production.mjs` pipes generated secrets directly to `wrangler secret put --env production` without echoing them, stores only public keys and HMAC hashes in D1, and writes the one-time initial admin key to gitignored `workers/license-api/bootstrap-production-admin.json` (`0o600`).

### Backup & Restore Prerequisites (Before G-G2.2 Go-Live)
1. **Pre-migration snapshot:** Before any future schema migration (`0002+`), export production D1 via:
   `npx wrangler d1 export stockstudio-pro-licenses-prod --env production --remote --output=backup-YYYYMMDD.sql` (stored encrypted outside Git).
2. **Cloudflare D1 Time Travel:** Verify D1 Time Travel bookmarking (`wrangler d1 time-travel info`) is active on the production Cloudflare account for point-in-time recovery (PITR).
3. **Secret & Key Vaulting:** Archive the production Ed25519 private JWK, `LICENSE_KEY_PEPPER`, `ADMIN_TOKEN_PEPPER`, `IP_HASH_SALT`, and initial `super_admin` key in an encrypted password vault; shred `bootstrap-production-admin.json` after vaulting.

---

## 5. Test Commands & Actual Results

| Command | Result | Details |
| --- | :---: | --- |
| `npm --prefix workers/license-api run typecheck` | **PASS** | `tsc --noEmit` exited `0` (0 errors) |
| `npm --prefix workers/license-api test` | **PASS** | `10 passed, 0 failed` (Tests 1–7 legacy + Test 8 `entitlements.products` + Test 9 `IP_HASH_SALT` + Test 10 `allowed_ips_json`) |
| `node --check workers/license-api/scripts/migrate-production.mjs` | **PASS** | Valid ESM syntax |
| `node --check workers/license-api/scripts/bootstrap-production.mjs` | **PASS** | Valid ESM syntax |
| `node workers/license-api/scripts/migrate-production.mjs` (unguarded run) | **PASS** | Aborted with exit code `1`: refused placeholder `database_id` |
| `node workers/license-api/scripts/bootstrap-production.mjs` (unguarded run) | **PASS** | Aborted with exit code `1`: refused placeholder `database_id` |
| `cargo test --manifest-path src-tauri/Cargo.toml --workspace` | **PASS** | `48 passed, 0 failed` (`6` core + `5` nmh + `37` desktop) |
| `node scripts/test-e2e-unified-licensing.mjs` | **PASS** | `ALL_TASK_GF_E2E_CHECKS_PASSED` |

---

## 6. Remaining Production Provisioning Requirements (G-G2.2+)

1. Provision production D1 database (`stockstudio-pro-licenses-prod`) and replace `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID` in `wrangler.toml`.
2. Configure production custom HTTPS domain route (`routes` / custom domain) in `wrangler.toml`.
3. Run `npm --prefix workers/license-api run db:migrate:prod -- --confirm-production` (with `CONFIRM_PRODUCTION_D1_ID`) and `npm --prefix workers/license-api run prod:bootstrap -- --confirm-production`.
4. Deploy production Worker (`wrangler deploy --env production`) and verify `GET /v1/health`.
5. Embed `("sspro-ed25519-prod-01", "<prod_pub_b64>")` in `EMBEDDED_PROD_VERIFYING_KEYS` (`src-tauri/crates/stockstudio-license-core/src/config.rs`) and wire `STOCKSTUDIO_LICENSE_API_URL`, `STOCKSTUDIO_EXTENSION_ID`, and CI test gates into `.github/workflows/release.yml`.

## 7. Known Risks & Unresolved Decisions

- **Production Domain & Chrome Web Store ID:** Still pending user decision before G-G2.2 provisioning and final production installer build.
- **Tauri Updater Endpoint:** `src-tauri/tauri.conf.json` still references `github.com/masplangga/flowpilot`.
- **Rate-Limit Table Pruning:** `rate_limit_buckets` has no scheduled cleanup cron yet (low risk at launch; plan periodic pruning as traffic grows).
- **Windows Authenticode Code Signing:** Not yet configured for the Windows NSIS installer.
