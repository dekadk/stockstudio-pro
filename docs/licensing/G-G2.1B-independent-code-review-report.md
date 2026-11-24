# TASK G-G2.1B: Independent Code Review & Security Verification Report

**Project:** StockStudio Pro Unified Licensing (`0.2.0`)  
**Reviewed Change Set:** G-G2.1 (`workers/license-api/` — 8 modified files, 2 new scripts)  
**Review Mode:** Strict Read-Only Code Review & Local Test Execution (no source/test edits, no Cloudflare calls, no remote migrations/bootstraps, no Git commit/push)

---

## Final Verdict: **`NEEDS FIX`**

The core `entitlements.products` implementation, `IP_HASH_SALT` fail-closed check, and `migrate-production.mjs` safeguards are well-structured and pass all 10 automated tests. However, **two High-severity security/operational defects** were confirmed in the actual implementation and must be fixed before G-G2.2 production provisioning:
1. **`bootstrap-production.mjs` unconditionally overwrites all 5 Cloudflare Production Secrets before checking whether D1 is already bootstrapped** — a partial-failure retry or accidental re-run would destroy live `LICENSE_KEY_PEPPER`, `ADMIN_TOKEN_PEPPER`, and Ed25519 signing keys while preserving mismatched D1 rows.
2. **`index.ts` falls back to spoofable `X-Forwarded-For` and `"127.0.0.1"` when `CF-Connecting-IP` is absent** — weakening `allowed_ips_json` enforcement in production/staging if `CF-Connecting-IP` is ever missing.

---

## 1. Actual Files & Functions Inspected

| File | Functions / Sections Reviewed |
| --- | --- |
| `workers/license-api/src/types.ts` | `Env`, `ProductEntitlementId`, `SUPPORTED_PRODUCT_ENTITLEMENTS`, `LicenseEntitlements`, `RequestContext` |
| `workers/license-api/src/utils.ts` | `validateAndNormalizeProducts()`, `validateEntitlementsInput()`, `parseEntitlements()`, `buildSignedLeasePayload()`, `formatLicenseSummary()` |
| `workers/license-api/src/admin-handlers.ts` | `authenticateAdmin()`, `handleAdminCreateLicense()`, `handleAdminGetLicense()`, `handleAdminUpdateLicense()`, and route auth coverage across all 8 admin handlers |
| `workers/license-api/src/crypto.ts` | `hashClientIp()`, `signEntitlementLease()`, `verifyEntitlementLease()` |
| `workers/license-api/src/index.ts` | `enforceTlsInProduction()`, `handleRequest()` (IP extraction & route dispatch) |
| `workers/license-api/wrangler.toml` | `[vars]`, `[env.staging]`, `[env.production]`, `[[env.production.d1_databases]]` |
| `workers/license-api/package.json` | `db:migrate:prod`, `prod:bootstrap` |
| `workers/license-api/scripts/bootstrap-production.mjs` | Full script (lines 1–299) |
| `workers/license-api/scripts/migrate-production.mjs` | Full script (lines 1–105) |
| `workers/license-api/tests/license-api.test.ts` | Tests 1–10 (focusing on new Tests 8, 9, 10) |

---

## 2. Security & Code Findings (with Severity)

### Finding 1 — **HIGH:** `bootstrap-production.mjs` Overwrites Live Secrets Before Checking Existing D1 State
- **Location:** `workers/license-api/scripts/bootstrap-production.mjs` lines 181–250.
- **Confirmed Behavior:** The script generates fresh `LICENSE_KEY_PEPPER`, `ADMIN_TOKEN_PEPPER`, `IP_HASH_SALT`, and Ed25519 keypair and uploads all 5 via `putProdSecret()` (lines 221–224) **before** querying D1 `signing_keys` (line 230) and `admin_api_keys` (line 244).
- **Impact:** On a retry after partial failure (or accidental re-run on a live production environment), Cloudflare Secrets are overwritten with new peppers and a new Ed25519 private key while D1 preserves the old `signing_keys` and `admin_api_keys` rows (`preserved_existing`). This permanently breaks all existing license key hashes, locks out all existing admin API keys, and creates a private/public signing key mismatch.
- **Required Fix:** Query remote D1 (`signing_keys`, `admin_api_keys`, `licenses`) **first** and abort immediately if any production rows already exist, before generating or uploading any secrets.

### Finding 2 — **HIGH:** Client IP Fallback Trusts Spoofable `X-Forwarded-For` and `"127.0.0.1"`
- **Location:** `workers/license-api/src/index.ts` lines 52–55 (`handleRequest`).
- **Confirmed Behavior:**
  ```ts
  const rawIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "127.0.0.1";
  ```
- **Impact:** Behind Cloudflare Edge, `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by external clients. However, if `CF-Connecting-IP` is ever absent (misconfigured route/proxy or non-CF ingress), trusting `X-Forwarded-For` allows trivial IP spoofing to bypass `allowed_ips_json`, and falling back to `"127.0.0.1"` could match a localhost allowlist entry.
- **Required Fix:** In `ENVIRONMENT === "production"` and `"staging"`, derive `ctx.clientIp` strictly from `CF-Connecting-IP` only (no `X-Forwarded-For` or `"127.0.0.1"` fallback). If `CF-Connecting-IP` is missing when `allowed_ips_json` is configured, fail closed (`403 FORBIDDEN_ROLE`).

### Finding 3 — **MEDIUM:** Partial `PATCH` Updates to `updates_until` / `max_app_version` Can Be Shadowed by Top-Level Columns
- **Location:** `workers/license-api/src/admin-handlers.ts` lines 682–706 (`handleAdminUpdateLicense`) and `workers/license-api/src/utils.ts` lines 409–413 (`parseEntitlements`).
- **Confirmed Behavior:** `handleAdminUpdateLicense` updates `entitlements_json` (properly preserving existing `products` and `features`), but does **not** update the top-level `licenses.updates_until` and `licenses.max_app_version` columns. Because `parseEntitlements()` prefers `license.updates_until ?? obj.updates_until`, updating those fields via `PATCH` is silently overridden if the top-level columns already hold non-null values.

### Finding 4 — **MEDIUM:** `bootstrap-production.mjs` File Permissions on Windows & Secret Recovery
- **Location:** `workers/license-api/scripts/bootstrap-production.mjs` lines 254–278.
- **Confirmed Behavior:**
  1. `writeFileSync(..., { mode: 0o600 })` is a no-op on Windows NTFS (file inherits directory ACLs).
  2. `putProdSecret` uploads `LICENSE_KEY_PEPPER`, `ADMIN_TOKEN_PEPPER`, `IP_HASH_SALT`, and `LICENSE_SIGNING_PRIVATE_KEY_JWK` directly to Cloudflare Secrets without an offline encrypted backup procedure — Cloudflare Secrets cannot be read back for disaster recovery.
  3. In `main().catch`, raw `err` is logged if `execFileSync` throws; sanitizing to log only the failed step/secret name avoids any accidental subprocess error leakage.

### Finding 5 — **LOW:** IPv6 Canonicalization Not Performed in `allowed_ips_json` Matching
- **Location:** `workers/license-api/src/admin-handlers.ts` lines 148–152.
- **Confirmed Behavior:** Uses exact lowercase trimmed string equality (`normalizedAllowlist.includes(normalizedClientIp)`). Non-canonical IPv6 forms (e.g., `2001:0db8::1` vs `2001:db8::1`) will not match, and malformed IP strings are not rejected at allowlist parse time (safe/fail-closed, but operationally brittle for IPv6).

### Finding 6 — **INFO:** Production Route / Custom Domain Intentionally Unconfigured
- **Location:** `workers/license-api/wrangler.toml` lines 65–84.
- **Confirmed Behavior:** `[env.production]` sets `workers_dev = false` with no `routes` / custom domain yet, and `database_id = "REPLACE_WITH_PRODUCTION_D1_DATABASE_ID"`. Staging (`[env.staging]`) is completely unchanged. Must add production route/custom domain and real D1 UUID in G-G2.2 before deployment.

---

## 3. Confirmed Behavior vs. Unverified Assumptions

| Area | Status | Notes |
| --- | :---: | --- |
| `entitlements.products` survives `POST`, `GET`, `activate`, `validate`, signed leases | **CONFIRMED** | Verified in source and Test 8 (`verifyEntitlementLease` roundtrip). |
| Partial `PATCH` preserves `products` & `features` | **CONFIRMED (CODE ONLY)** | Verified in `validateEntitlementsInput(body.entitlements, parseEntitlements(license))`, **not covered by an automated test**. |
| Legacy features-only licenses remain backward compatible | **CONFIRMED** | Verified in source (`products` omitted when absent) and Test 8d. |
| Malformed `entitlements_json` never grants `vectorizer_extension` | **CONFIRMED** | Verified in `parseEntitlements()` catch fallback and Test 8e. |
| All 8 `/v1/admin/*` routes call `authenticateAdmin()` | **CONFIRMED** | Verified across `Create`, `Get`, `Update`, `Suspend`, `Reinstate`, `Revoke`, `Renew`, `ForceDeactivateDevice`. |
| `IP_HASH_SALT` fails closed (`503`) when missing or `< 16` chars | **CONFIRMED** | Verified in `crypto.ts` and Test 9. |
| `migrate-production.mjs` blocks placeholder, dev, staging, and unconfirmed runs | **CONFIRMED** | Verified in code (`FORBIDDEN_IDS` + `UUID_REGEX` + `--confirm-production` + `CONFIRM_PRODUCTION_D1_ID`); `--env production --remote` is hardcoded (no local/staging path). |
| Cloudflare Edge always sets `CF-Connecting-IP` | **UNVERIFIED ASSUMPTION** | True for standard Cloudflare proxied routes, but code still falls back to spoofable `X-Forwarded-For` / `127.0.0.1` if absent. |
| `bootstrap-production.mjs` retry safety on partial failure | **FAILED (DEFECT)** | Overwrites live Cloudflare Secrets before checking D1 state (Finding 1). |

---

## 4. Test Commands & Actual Results

| Command | Result | Actual Output Summary |
| --- | :---: | --- |
| `npm --prefix workers/license-api run typecheck` | **PASS** | `tsc --noEmit` exited `0` (0 errors) |
| `npm --prefix workers/license-api test` | **PASS** | `1 passed (1)` test file, `10 passed (10)` tests (`3.41s`) |

---

## 5. Missing Test Cases

The following scenarios are **not** currently covered by automated tests in `workers/license-api/tests/license-api.test.ts`:
1. **Partial `PATCH` entitlement preservation:** Updating only `features` or `max_accounts` via `PATCH /v1/admin/licenses/:id` while verifying existing `products` are preserved (and verifying `updates_until` / `max_app_version` column sync once fixed).
2. **IP header spoofing:** Sending `X-Forwarded-For: <allowed-ip>` with a different `CF-Connecting-IP` (and with missing `CF-Connecting-IP` in `ENVIRONMENT="production"`) to prove `X-Forwarded-For` cannot bypass `allowed_ips_json`.
3. **IPv4 and IPv6 allowlists:** Explicit IPv6 allowlist match/mismatch (including mixed case and canonicalization edge cases) plus missing/malformed IP handling.
4. **Bootstrap secret leakage:** Automated check verifying `bootstrap-production.mjs` stdout/stderr never contains peppers, private JWK material, or `ssadm_` tokens (including on failure).
5. **Bootstrap partial failure / re-run safety:** Verifying `bootstrap-production.mjs` aborts **before** calling `wrangler secret put` when D1 already contains `signing_keys`, `admin_api_keys`, or `licenses`.
6. **Migration script wrong-ID & wrong-environment scenarios:** Automated unit tests for `migrate-production.mjs` verifying rejection of staging D1 ID, dev `0000...` ID, malformed UUID, mismatched `CONFIRM_PRODUCTION_D1_ID`, and missing `--confirm-production`.

---

*Review complete. Zero project source, config, or test files were modified.*
