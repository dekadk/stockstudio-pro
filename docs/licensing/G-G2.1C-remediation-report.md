# TASK G-G2.1C: Independent Review Remediation Report

**Project:** StockStudio Pro Unified Licensing (`0.2.0`)  
**Reference Review:** `docs/licensing/G-G2.1B-independent-code-review-report.md`  
**Final Status:** **`PASS`** — All 5 G-G2.1B findings remediated and verified with 15+ regression test scenarios. Ready for user approval before G-G2.2.

---

## 1. Findings & Resolutions

| # | Severity | G-G2.1B Finding | Resolution Implemented |
| --- | :---: | :--- | :--- |
| 1 | **HIGH** | `bootstrap-production.mjs` overwrote live Cloudflare Production Secrets before checking D1 state. | Added mandatory **D1 Preflight** (`signing_keys`, `admin_api_keys`, `licenses` must all be `0`) AND **Cloudflare Secret Preflight** (`wrangler secret list --env production --format json` checking all 5 protected secret names) **before** generating or uploading any secret. Aborts safely with manual recovery instructions if any row or secret exists. |
| 2 | **HIGH** | `index.ts` fell back to spoofable `X-Forwarded-For` and `"127.0.0.1"` when `CF-Connecting-IP` was absent. | Added `resolveClientIp()` in `src/utils.ts`: in `production` and `staging`, trusts `CF-Connecting-IP` **exclusively** (never `X-Forwarded-For`, never `"127.0.0.1"`). Missing or invalid trusted IP fails closed (`403 FORBIDDEN_ROLE`) on allowlisted admin keys across all 8 `/v1/admin/*` routes. Development environment preserves `X-Forwarded-For` / `127.0.0.1` compatibility. |
| 3 | **MEDIUM** | `PATCH /v1/admin/licenses/:id` did not sync `updates_until` / `max_app_version` to top-level `licenses` columns. | Updated `handleAdminUpdateLicense()` to write `updates_until` and `max_app_version` to both `entitlements_json` and the top-level `licenses` columns (including `NULL` clearing), while preserving existing `products` and `features` on partial updates. |
| 4 | **MEDIUM** | `bootstrap-production.mjs` relied on POSIX `mode: 0o600` (ignored on Windows NTFS), logged raw subprocess errors, and lacked an encrypted offline recovery backup. | Replaced raw error logging with sanitized `BootstrapStepError` (step ID + safe message only; never echoes secret values or raw wrangler stderr). Added **AES-256-GCM + scrypt** encrypted offline recovery bundle (`bootstrap-production-recovery.enc.json`, requiring `BOOTSTRAP_RECOVERY_PASSPHRASE >= 16 chars`, written before secret upload) + Windows NTFS ACL lockdown (`icacls <file> /inheritance:r /grant:r "<USER>:(R,W)"` on `win32`). |
| 5 | **LOW** | `allowed_ips_json` lacked IPv4/IPv6 canonicalization and entry validation. | Added `canonicalizeIpAddress()` in `src/utils.ts` validating strict IPv4 dotted-decimal and canonical 8-hextet lowercase IPv6 (supporting `::` compression and IPv4-mapped IPv6). Malformed allowlist entries fail closed with `403 FORBIDDEN_ROLE`. |

---

## 2. Files Modified / Added

| File | Action | Purpose |
| --- | :---: | --- |
| `workers/license-api/src/types.ts` | Modified | Typed `RequestContext.clientIp` as `string \| null`. |
| `workers/license-api/src/utils.ts` | Modified | Added `canonicalizeIpAddress()` (IPv4 + IPv6) and `resolveClientIp()` (strict `CF-Connecting-IP` in prod/staging). |
| `workers/license-api/src/index.ts` | Modified | Switched IP extraction to `resolveClientIp(request, env)`. |
| `workers/license-api/src/admin-handlers.ts` | Modified | Canonicalized/validated `allowed_ips_json` entries + fail-closed on missing `ctx.clientIp`; synchronized `updates_until` and `max_app_version` columns in `handleAdminUpdateLicense()`. |
| `workers/license-api/scripts/bootstrap-production.mjs` | Modified | Added D1 preflight, Cloudflare secret list preflight, AES-256-GCM encrypted offline recovery backup, Windows `icacls` ACL restriction, sanitized `BootstrapStepError`, and testable exports. |
| `workers/license-api/scripts/migrate-production.mjs` | Modified | Added rejection of conflicting environment flags (`--local`, `--env`, `staging`, `development`) and testable exports. |
| `workers/license-api/tests/license-api.test.ts` | Modified | Added Test 11 (IP trust, anti-spoofing, dev compat, IPv4/IPv6 canonicalization) and Test 12 (partial `PATCH` preservation, `updates_until`/`max_app_version` column sync, and `null` clearing). |
| `workers/license-api/tests/production-scripts.test.ts` | Created | Added 6 mocked safeguard tests covering D1 preflight aborts, existing secret aborts, partial-failure + rerun protection, zero secret leakage + AES-256-GCM recovery roundtrip, and migration wrong-ID/wrong-env rejections. |
| `docs/licensing/G-G2.1C-remediation-report.md` | Created | This report. |

---

## 3. Bootstrap Failure & Rerun Safety Model

1. **Strict Ordering:**
   - `config_validation` → `confirmation_gate` → `recovery_passphrase` → `d1_preflight` (`signing_keys`, `admin_api_keys`, `licenses` == 0) → `secret_preflight` (none of the 5 protected secrets exist) → key generation → encrypted offline recovery bundle written + Windows ACL locked → secret upload → D1 seed.
2. **Partial Failure Behavior:**
   - If secret upload fails midway (e.g., on secret #3 of 5), execution halts immediately with a sanitized `[step:secret_upload]` error, and the encrypted offline recovery bundle already holds the exact generated values.
   - Any subsequent re-run hits `secret_preflight`, detects the already-uploaded secrets, and **aborts before generating or overwriting anything**.
   - If D1 seeding fails after secrets are uploaded, the operator recovers deterministically from the encrypted recovery bundle rather than regenerating/overwriting live peppers or keys.

---

## 4. Client IP Trust Model

| Environment | Trusted Source | Fallback When Missing | Allowlisted Admin Key Behavior |
| --- | :--- | :--- | :--- |
| `production` | `CF-Connecting-IP` ONLY | `null` (never `X-Forwarded-For`, never `127.0.0.1`) | Fails closed with `403 FORBIDDEN_ROLE` |
| `staging` | `CF-Connecting-IP` ONLY | `null` (never `X-Forwarded-For`, never `127.0.0.1`) | Fails closed with `403 FORBIDDEN_ROLE` |
| `development` | `CF-Connecting-IP` → `X-Forwarded-For` (1st) → `127.0.0.1` | `127.0.0.1` | Local dev / test compatible |

All 8 `/v1/admin/*` handlers invoke `authenticateAdmin()`, enforcing canonical IPv4/IPv6 matching whenever `allowed_ips_json` is non-empty.

---

## 5. Verification Commands & Actual Results

| Check | Command | Result | Actual Output |
| --- | :--- | :---: | :--- |
| Worker Typecheck | `npm --prefix workers/license-api run typecheck` | **PASS** | `tsc --noEmit` exited `0` (0 errors) |
| Worker Test Suite (API + Mocked Bootstrap/Migration) | `npm --prefix workers/license-api test` | **PASS** | `2 passed (2)` files, `18 passed (18)` tests (`tests/license-api.test.ts` 12/12, `tests/production-scripts.test.ts` 6/6) |
| Script Syntax Checks | `node --check workers/license-api/scripts/migrate-production.mjs` & `bootstrap-production.mjs` | **PASS** | Both exited `0` |
| CLI Safeguard Checks | Unguarded execution of `migrate-production.mjs` & `bootstrap-production.mjs` | **PASS** | Both aborted with exit code `1` on placeholder `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID` |
| Rust Workspace Tests | `cargo test --manifest-path src-tauri/Cargo.toml --workspace` | **PASS** | `48 passed, 0 failed` (`6` core + `5` nmh + `37` desktop) |
| Unified Licensing E2E | `node scripts/test-e2e-unified-licensing.mjs` | **PASS** | `ALL_TASK_GF_E2E_CHECKS_PASSED` |

---

## 6. Remaining Risks & Pre-G-G2.2 Decisions

- **CIDR Ranges:** `allowed_ips_json` enforces exact canonical IPv4/IPv6 addresses (CIDR notation is intentionally rejected fail-closed; acceptable for static operator IPs, expandable later if needed).
- **Production Provisioning Decisions Still Required Before G-G2.2:** Production HTTPS custom domain, Chrome Web Store vs. unpacked Extension ID distribution, Tauri updater endpoint (`github.com/masplangga/flowpilot`), and Windows Authenticode signing scope.

---

## 7. Restrictions Confirmation

- Zero Cloudflare API calls, zero real production secrets generated, zero remote migrations/bootstraps, zero deployments, zero resource creation.
- Version remains `0.2.0`; no Git commit or push occurred.
- **Status: `PASS` — Stopping after G-G2.1C and awaiting user approval before G-G2.2.**
