# TASK G-G2.1D: Final Independent Security Review Report

**Project:** StockStudio Pro Unified Licensing (`0.2.0`)  
**Reviewed Remediation:** G-G2.1C (`docs/licensing/G-G2.1C-remediation-report.md`)  
**Review Mode:** Strictly Read-Only Inspection & Local Test Verification (zero source/config/test modifications, zero Cloudflare API calls, zero secret generation, zero commits/pushes)

---

## Final Verdict: **`ACCEPTED`**

All High, Medium, and Low findings from G-G2.1B have been verified as properly remediated in the actual source code and Git diff, and all automated test suites pass (`18/18` Worker tests, `48/48` Rust workspace tests, and the full Unified Licensing E2E suite). **Zero Critical, High, or Medium defects remain.** Three **LOW / operational** notes are documented below for G-G2.2 runbook awareness.

---

## 1. Source & Git Diff Inspection Summary

Verified `git diff --stat workers/license-api`: 8 modified files (`+995 / -41` lines), plus 3 new files (`scripts/bootstrap-production.mjs`, `scripts/migrate-production.mjs`, `tests/production-scripts.test.ts`).

Inspected directly:
- `workers/license-api/scripts/bootstrap-production.mjs` (lines 1–545): `encryptRecoveryBundle()`, `decryptRecoveryBundle()`, `defaultRunRemoteProdD1Json()`, `defaultListProdSecretNames()`, `defaultPutProdSecret()`, `defaultLockFileAcl()`, `runProductionBootstrap()`.
- `workers/license-api/scripts/migrate-production.mjs`: environment-flag rejection, `FORBIDDEN_IDS`, `UUID_REGEX`, confirmation gate.
- `workers/license-api/src/utils.ts`, `src/index.ts`, `src/admin-handlers.ts`, `src/types.ts`: `canonicalizeIpAddress()`, `resolveClientIp()`, `authenticateAdmin()`, `handleAdminUpdateLicense()`.
- `workers/license-api/.gitignore`: verified via `git check-ignore -v workers/license-api/bootstrap-production-recovery.enc.json` → matched by `workers/license-api/.gitignore:7:bootstrap*.json`.

---

## 2. Review Focus Findings (with Severity)

| # | Area | Severity | Finding & Assessment |
| --- | :--- | :---: | :--- |
| 1 | **Bootstrap Concurrency / TOCTOU** | **LOW** | Between D1/secret preflights (lines 363–394) and secret upload / D1 `INSERT` (lines 468–503), there is no distributed lock. Two concurrent operator runs launched simultaneously could both pass preflight and race on `wrangler secret put`. **Mitigation:** Execute `prod:bootstrap` strictly as a single-operator manual step (never from concurrent CI jobs); optional future hardening is a D1 lock row or exclusive local lockfile (`wx`). |
| 2 | **Windows ACL Edge Case (`USERNAME` unset)** | **LOW** | `defaultLockFileAcl()` (`bootstrap-production.mjs` lines 291–308) safely invokes `execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", "${user}:(R,W)"])` without a shell (safe for paths with spaces like `E:\2. Microstock\...`) and runs **before** secret upload so ACL failures abort safely. However, line 294 (`if (!user) return;`) silently skips ACL locking if `process.env.USERNAME` is unset; failing closed when `USERNAME` is missing (or qualifying `%USERDOMAIN%\%USERNAME%`) would be stricter. |
| 3 | **Recovery Bundle KDF & Passphrase Handling** | **LOW** | Output path (`workers/license-api/bootstrap-production-recovery.enc.json`) is confirmed gitignored (`bootstrap*.json`). Uses 16-byte salt, 12-byte IV, `scryptSync` (`N=16384, r=8, p=1`), `aes-256-gcm` authenticated encryption, and zeroes key/plaintext buffers. Passphrase is read from `BOOTSTRAP_RECOVERY_PASSPHRASE` env var (never CLI args, never logged). Operational note: operators should supply the passphrase without recording it in shell history (e.g., `Read-Host -AsSecureString`), and `N` may be raised to `32768` in a future iteration. |
| 4 | **Cloudflare Secret Preflight on Brand-New Worker** | **INFO** | `defaultListProdSecretNames()` fails closed (`BootstrapStepError("secret_preflight")`) on any `wrangler secret list` error, auth failure, or malformed JSON, preventing secret generation or overwrite. Note for G-G2.2 sequencing: if the production Worker script has never been deployed yet, `wrangler secret list --env production` will error and fail closed — deploy the initial production Worker (or create the Worker target) before running `prod:bootstrap`. |

---

## 3. Confirmed Behavior vs. Unverified Assumptions

| Area | Status | Evidence |
| --- | :---: | :--- |
| Recovery bundle path & Git ignore coverage | **CONFIRMED** | `git check-ignore -v` matched `workers/license-api/.gitignore:7:bootstrap*.json` |
| Recovery bundle restores exact generated secrets after partial failure | **CONFIRMED** | Written in Step 5 before Step 6 secret upload; verified via `decryptRecoveryBundle()` in `production-scripts.test.ts` Test 5 |
| Passphrase absent from CLI args, logs, and recovery file | **CONFIRMED** | Read via env var; `production-scripts.test.ts` Test 5 verifies absence from logs and encrypted JSON |
| `wrangler secret list` error / malformed JSON / auth failure fails closed | **CONFIRMED** | Caught in `defaultListProdSecretNames()` and rethrown as `BootstrapStepError("secret_preflight")` before Step 4 |
| Existing protected secrets (`5/5`) never overwritten | **CONFIRMED** | Verified in `production-scripts.test.ts` Tests 3 & 4 |
| ACL failure aborts before secret upload | **CONFIRMED (CODE)** | `lockFileAcl(recoveryPath)` at line 465 executes before Step 6 (`putProdSecret` at line 477) |
| Real Windows `icacls.exe` execution on NTFS | **NOT EXECUTED (MOCKED ONLY)** | Mocked in `production-scripts.test.ts` Test 5; no real NTFS file or `icacls.exe` call was executed during G-G2.1C |
| Production/staging `CF-Connecting-IP` trust & anti-spoofing | **CONFIRMED** | Verified in `resolveClientIp()` and `license-api.test.ts` Test 11 |
| Partial `PATCH` preservation & `updates_until`/`max_app_version` column sync | **CONFIRMED** | Verified in `handleAdminUpdateLicense()` and `license-api.test.ts` Test 12 |
| IPv4 & IPv6 canonicalization & malformed allowlist rejection | **CONFIRMED** | Verified in `canonicalizeIpAddress()` and `license-api.test.ts` Test 11 |
| Migration script wrong-ID & wrong-env rejections | **CONFIRMED** | Verified in `migrate-production.mjs` and `production-scripts.test.ts` Test 6 |

---

## 4. Test Execution Results (Independently Re-Run)

| Command | Result | Actual Output |
| --- | :---: | :--- |
| `npm --prefix workers/license-api run typecheck` | **PASS** | `tsc --noEmit` exited `0` (0 errors) |
| `npm --prefix workers/license-api test` | **PASS** | `2 passed (2)` files, `18 passed (18)` tests (`tests/license-api.test.ts` 12/12 + `tests/production-scripts.test.ts` 6/6) |
| `cargo test --manifest-path src-tauri/Cargo.toml --workspace --quiet` | **PASS** | `48 passed, 0 failed` (`6` core + `5` nmh + `37` desktop) |
| `node scripts/test-e2e-unified-licensing.mjs` | **PASS** | `ALL_TASK_GF_E2E_CHECKS_PASSED` |

---

## 5. Windows-Specific Verification Status

- **Static / Argv Safety:** `execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", "${user}:(R,W)"])` avoids shell parsing, safely handling paths with spaces.
- **Runtime Verification:** **Mocked only** in unit tests (real `icacls.exe` was not run against a live recovery file). Recommend verifying the ACL on `bootstrap-production-recovery.enc.json` (`icacls workers\license-api\bootstrap-production-recovery.enc.json`) immediately after running `prod:bootstrap` in G-G2.2, then moving the encrypted file to an offline vault and securely deleting the local copy.

---

*Review complete. Verdict: **ACCEPTED** for proceeding to G-G2.2 upon user approval. Zero source, configuration, or test files were modified.*
