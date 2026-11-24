# PROJECT LM-06: Security Findings Register

**Date:** 2026-11-23  
**Scope:** `apps/license-manager/` (`com.stockstudiopro.licensemanager`) & Staging Worker Admin API  
**Summary:** 6 findings identified during LM-06 audit — **4 fixed and regression-tested** (`1 HIGH`, `1 MEDIUM`, `2 LOW`), **2 remaining limitations** (`1 LOW dev-dependency advisory`, `1 INFORMATIONAL distribution/promotion readiness`).

---

## LM06-01 — `issue_license` Lacked Hard Rust Production Mutation Guard

- **Severity:** `HIGH`
- **Affected Files:** `apps/license-manager/src-tauri/src/commands.rs`, `apps/license-manager/src/pages/IssueLicensePage.tsx`
- **Description:** In LM-05, `revoke_license` and `force_deactivate_device` enforced `enforce_staging_only_lifecycle` (blocking `Environment::Production` with `PRODUCTION_MUTATION_BLOCKED`), whereas `issue_license` (from LM-04) only checked `env != input.expected_environment`.
- **Security / Operational Impact:** Under the strict pre-promotion Staging-only policy, an operator switching to Production could have issued a live Production license prior to explicit Production promotion sign-off.
- **Remediation Applied:** Updated `issue_license` in `commands.rs` to call `enforce_staging_only_lifecycle(env, input.expected_environment)` before any HTTP request, and disabled Production submission in `IssueLicensePage.tsx` with an explicit tooltip.
- **Status:** **FIXED**
- **Regression Test:** `commands::tests::blocks_production_lifecycle_mutations_in_lm05` (Rust).

---

## LM06-02 — Unlocked Session Was Not Automatically Locked on `401 UNAUTHORIZED_TOKEN`

- **Severity:** `MEDIUM`
- **Affected Files:** `apps/license-manager/src-tauri/src/security.rs`, `apps/license-manager/src-tauri/src/commands.rs`
- **Description:** If an admin key was revoked or expired server-side while a desktop session was unlocked, `fetch_admin_me`, `fetch_dashboard_stats`, `fetch_licenses`, `fetch_license_details`, and `fetch_events` returned the `401 UNAUTHORIZED_TOKEN` error without locking and zeroizing `AppSecurityState`.
- **Security / Operational Impact:** A revoked credential remained in volatile RAM until idle auto-lock or manual lock.
- **Remediation Applied:** Added `AppSecurityState::lock_if_unauthorized(&mut self, err: &str)` in `security.rs` and wired it into all `fetch_*` commands in `commands.rs` so any `401 UNAUTHORIZED_TOKEN` immediately drops and zeroizes `active_key`.
- **Status:** **FIXED**
- **Regression Test:** `security::tests::locks_and_zeroizes_session_on_401_unauthorized` (Rust).

---

## LM06-03 — Missing Explicit Unit Test for Corrupted Vault Ciphertext & Tampered GCM Tag

- **Severity:** `LOW`
- **Affected File:** `apps/license-manager/src-tauri/src/vault.rs`
- **Description:** `vault.rs` verified round-trip encryption/decryption, wrong passphrase rejection, short passphrase rejection, and overwrite protection, but lacked an explicit test flipping bits in `ciphertext_b64` and `auth_tag_b64`.
- **Remediation Applied:** Added `vault::tests::rejects_corrupted_ciphertext_and_tampered_auth_tag`.
- **Status:** **FIXED**
- **Regression Test:** `vault::tests::rejects_corrupted_ciphertext_and_tampered_auth_tag` (Rust).

---

## LM06-04 — Clippy `-D warnings` Lints in Rust Backend

- **Severity:** `LOW`
- **Affected Files:** `apps/license-manager/src-tauri/src/api.rs`, `commands.rs`, `security.rs`
- **Description:** `cargo clippy --all-targets --all-features -- -D warnings` flagged 4 lints (`clippy::large_enum_variant` on `CreateLicenseOutcome`, `clippy::new_without_default` on `IssuanceRuntimeState` and `InMemoryCredentialStore`, and `clippy::derivable_impls` on `Environment`).
- **Remediation Applied:** Boxed `LicenseSummaryDto` inside `CreateLicenseOutcome::Created`, derived `Default` on `Environment`, and implemented `Default` on `IssuanceRuntimeState` and `InMemoryCredentialStore`.
- **Status:** **FIXED**
- **Regression Test:** `cargo clippy --manifest-path apps/license-manager/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` passes with `0` errors and `0` warnings.

---

## LM06-05 — Dev-Only `npm audit` Advisories in `vitest` / `@vitest/mocker`

- **Severity:** `LOW` (Dev-tooling only; `0` production runtime vulnerabilities)
- **Affected File:** `apps/license-manager/package.json` (`devDependencies`)
- **Description:** `npm audit` reported moderate advisories in `@vitest/mocker <=4.1.11` / `vitest <=4.1.10`. `npm audit --omit=dev --audit-level=low` confirmed **`0` vulnerabilities** in all production runtime dependencies (`react`, `react-dom`, `lucide-react`, `@tauri-apps/api`).
- **Security / Operational Impact:** Zero impact on the compiled Tauri desktop binary or `dist/` bundle; affects only local Vitest dev server tooling.
- **Recommended Remediation:** Upgrade `vitest`/`vite` in a dedicated maintenance PR (deferred per LM-06 no-broad-dependency-upgrade boundary).
- **Status:** **OPEN (ACCEPTED DEV-ONLY LIMITATION)**

---

## LM06-06 — Controlled Distribution Packaging & Signing Not Yet Enabled

- **Severity:** `INFORMATIONAL`
- **Affected File:** `apps/license-manager/src-tauri/tauri.conf.json`
- **Description:** `bundle.active` is intentionally `false`, no Windows Authenticode code-signing certificate is configured for the standalone License Manager executable, and the LM-05/LM-06 `PRODUCTION_MUTATION_BLOCKED` guard remains active.
- **Recommended Remediation:** In the future Production promotion / distribution phase (LM-07), explicitly lift `PRODUCTION_MUTATION_BLOCKED` behind Production promotion sign-off, apply `0002_admin_listing_indexes.sql` + Worker deploy to Production, configure Authenticode signing, and enable private local installer bundling (`bundle.active: true`).
- **Status:** **OPEN (INTENTIONAL PRE-DISTRIBUTION GATE)**
