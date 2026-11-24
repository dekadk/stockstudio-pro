# TASK G-G1: Production Readiness Verification Report

**Project:** StockStudio Pro Desktop (v0.3.0) + `Vectorize.ai Download v1`  
**Native Messaging Host:** `com.stockstudiopro.license`  
**Pinned Chrome Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk`  
**Final Recommendation:** **BLOCKED** (Interactive NSIS installer smoke test blocked by missing `makensis.exe` on this local workstation; all automated tests and security audits passed)

---

## 1. NSIS Availability & Interactive Smoke-Test Results

- **Status:** **BLOCKED**
- **Exact Missing Prerequisite:** `makensis.exe` (NSIS 3.x) is not installed on this workstation (checked `PATH`, `C:\Program Files (x86)\NSIS\makensis.exe`, `C:\Program Files\NSIS\makensis.exe`, and `%LOCALAPPDATA%\tauri\NSIS\makensis.exe` → `MAKENSIS_NOT_FOUND`).
- **Compliance:** Per TASK G-G1 rules, installation was **not** simulated and no registry entries were mutated on the host Windows environment.

## 2. Fresh Install, Upgrade, and Uninstall Results

| Installer Test | Result | Notes |
| :--- | :--- | :--- |
| **Fresh installation** | **BLOCKED** | Requires `makensis.exe` / Windows CI NSIS build + isolated Windows test environment (VM / Windows Sandbox). |
| **Upgrade installation (`$UpdateMode = 1`)** | **BLOCKED** | Static inspection of [installer-hooks.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/installer-hooks.nsh) confirms `NSIS_HOOK_PREUNINSTALL` skips deletion when `$UpdateMode = 1` and `NSIS_HOOK_POSTINSTALL` idempotently refreshes the manifest and `HKCU` value; interactive verification pending NSIS build. |
| **Uninstallation (`$UpdateMode <> 1`)** | **BLOCKED** | Static inspection confirms `DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license"` removes only StockStudio Pro's key and manifest; interactive verification pending NSIS build. |

---

## 3. Production Configuration Inventory

| Configuration Item | Location | Classification | Findings |
| :--- | :--- | :--- | :--- |
| Production License API URL (`STOCKSTUDIO_LICENSE_API_URL`) | [config.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/config.rs), [.github/workflows/release.yml](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/.github/workflows/release.yml) | **NEEDS_CONFIGURATION** | Not yet set in `release.yml`. Production (`!debug_assertions`) builds fail closed with `License API Not Configured` rather than falling back to staging. |
| `EMBEDDED_PROD_VERIFYING_KEYS` | [config.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/config.rs#L24-L25) | **NEEDS_CONFIGURATION** | Intentionally empty `&[]` in release builds until production Ed25519 keypair is provisioned in G-G2. |
| Ed25519 Key ID & Public Key Env Vars (`STOCKSTUDIO_LICENSE_SIGNING_KID`, `STOCKSTUDIO_LICENSE_PUBLIC_KEY_BASE64`) | [config.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/config.rs), [.github/workflows/release.yml](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/.github/workflows/release.yml) | **NEEDS_CONFIGURATION** | Supported by `stockstudio-license-core`, not yet wired as secrets/vars in `release.yml`. |
| Production Cloudflare Worker & D1 Environment | [workers/license-api/wrangler.toml](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/workers/license-api/wrangler.toml) | **NEEDS_CONFIGURATION** | Currently defines `development` and `staging` only; production custom domain, D1 binding, and secrets are deferred to G-G2. |
| Staging API URL & Staging Public Key (`sspro-ed25519-staging-01`, `dekadk00.workers.dev`) | [config.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/config.rs#L8-L20) | **DEVELOPMENT_ONLY** | Strictly gated behind `#[cfg(debug_assertions)]`. Verified never compiled into production release binaries. |
| Developer Staging DNS Override | Local Windows developer workstation | **DEVELOPMENT_ONLY** | Not required by production configuration (production will use an official HTTPS custom domain); developer's local override was left untouched. |
| Build Staging Script (`prepare-nmh-bundle.mjs`) | [scripts/prepare-nmh-bundle.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/prepare-nmh-bundle.mjs) | **READY** | Builds release `stockstudio-nmh.exe`, stages to `src-tauri/binaries/`, validates exact 32-char `a-p` Extension ID. Note: pass `STOCKSTUDIO_EXTENSION_ID` explicitly in `release.yml` for CI determinism. |
| Tauri Bundling & NSIS Hooks | [tauri.conf.json](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/tauri.conf.json), [installer-hooks.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/installer-hooks.nsh) | **BLOCKED** | Configuration is complete and statically verified, but interactive NSIS `.exe` install/upgrade/uninstall smoke test is blocked locally by missing `makensis.exe`. |
| Tauri Updater Endpoint | [tauri.conf.json](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/tauri.conf.json#L12) | **NEEDS_CONFIGURATION** | Still points to legacy `https://github.com/masplangga/flowpilot/releases/latest/download/latest.json` (unrelated to license API, which strictly rejects `flowpilot` hosts, but should be reviewed before public v0.3.0 release). |
| Pinned Chrome Extension ID & Manifest Public Key | `manifest.json`, [extension-id.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/native-messaging/extension-id.nsh) | **READY** | Exact ID `ejcjoljemplfeenipjehlhhclbkpialk` verified across manifest, NSIS config, and tests. |
| Native Messaging Host Name & Registry Key | [manifest.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/src/manifest.rs), [installer-hooks.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/installer-hooks.nsh), `license-client.js` | **READY** | Consistently `com.stockstudiopro.license` and `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license`. |

---

## 4. Staging vs. Production Separation

- `DEFAULT_DEV_API_BASE_URL` (`https://stockstudio-pro-license-api-staging.dekadk00.workers.dev`) and `EMBEDDED_DEV_VERIFYING_KEYS` (`sspro-ed25519-staging-01`) are strictly compiled under `#[cfg(debug_assertions)]` only.
- `validate_api_base_url()` enforces HTTPS in release builds (local HTTP loopback allowed only under `debug_assertions`) and rejects any URL containing `flowpilot`.
- Verified by unit test `license_store::tests::isolates_development_staging_defaults_from_production_builds`.

## 5. Signing Key Readiness (No Private Material Exposed)

- **Staging Ed25519 Key:** Public key only (`sspro-ed25519-staging-01`) is embedded in `debug_assertions` builds; private key remains solely in Cloudflare Secrets.
- **Production Ed25519 Key:** Not yet provisioned (`EMBEDDED_PROD_VERIFYING_KEYS = &[]`). Zero private signing keys exist in the Desktop repository or Chrome Extension directory.
- **Extension RSA Key:** Public SPKI key pinned in `manifest.json`; private PEM stored strictly outside the repository and extension folder.

## 6. Extension ID & Native Messaging Consistency

- Pinned Extension ID `ejcjoljemplfeenipjehlhhclbkpialk` matches identically across:
  - `E:\2. Microstock\TOOL\Chrome Extension\Vectorize.ai Download v1\manifest.json` (`SHA-256(key)` verified)
  - `src-tauri/native-messaging/extension-id.nsh`
  - `scripts/test-extension-license-client.mjs` and `scripts/test-e2e-unified-licensing.mjs`
- Native Messaging Host name `com.stockstudiopro.license` matches identically across `manifest.rs`, `com.stockstudiopro.license.template.json`, `installer-hooks.nsh`, and `background/license-client.js`.

## 7. Security Findings

- **No private keys or admin tokens** in Desktop or Extension artifacts.
- **No license secrets exposed to Chrome Extension** (`license_key`, `activation_token`, `lease_token`, `device_fingerprint` never cross Native Messaging).
- **Session-only caching** (`chrome.storage.session` + volatile memory; zero `chrome.storage.local` writes for license verdicts).
- **Legacy Desktop compatibility & explicit extension entitlement:** Legacy licenses continue working for `desktop` while `vectorizer_extension` remains denied (`PRODUCT_NOT_ENTITLED`) unless explicitly granted.
- **Fail-closed gates:** Verified across `stockstudio-license-core`, `stockstudio-nmh`, `license-client.js`, `popup.js`, and `content.js`.

## 8. Regression Test Results

| Command | Result |
| :--- | :--- |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | **Passed** |
| `cargo check --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**0 warnings**) |
| `cargo test --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**48 passed, 0 failed**: 6 `stockstudio-license-core` + 5 `stockstudio-nmh` + 37 `stockstudio-pro`) |
| `npm run typecheck` | **Passed** |
| `npm run build` | **Passed** (`dist/` built in 1.44s) |
| `npm --prefix workers/license-api test` | **Passed** (**7 passed, 0 failed**) |
| `node scripts/test-extension-license-client.mjs` | **Passed** (**7/7 groups**) |
| `node scripts/test-e2e-unified-licensing.mjs` | **Passed** (`ALL_TASK_GF_E2E_CHECKS_PASSED`) |
| `node --check` on all 5 extension JS files (`license-client.js`, `service-worker.js`, `popup.js`, `content.js`, `inject.js`) | **Passed** |

## 9. Defects Fixed & Changed Files

- **Defects Fixed in G-G1:** None (0 new defects found).
- **Changed Files:** Only this report (`docs/licensing/G-G1-production-readiness-report.md`). Zero application, extension, installer, or backend source files were modified.

## 10. Exact Remaining Blockers Before Production Provisioning (G-G2)

1. **Interactive NSIS Installer Smoke Test (`BLOCKED`):** Install NSIS (`makensis.exe`) on a Windows build/test machine—or run `tauri build` on GitHub Actions `windows-latest`—and execute interactive fresh install, upgrade, and uninstall verification inside an isolated Windows Sandbox / VM.
2. **Production Configuration Values (`NEEDS_CONFIGURATION` — handled in G-G2):** Provision production custom domain, production Cloudflare Worker + D1 database, production Ed25519 keypair, and wire `STOCKSTUDIO_LICENSE_API_URL`, `STOCKSTUDIO_LICENSE_SIGNING_KID`, `STOCKSTUDIO_LICENSE_PUBLIC_KEY_BASE64`, and `STOCKSTUDIO_EXTENSION_ID` into `.github/workflows/release.yml` (plus update `tauri.conf.json` updater endpoint if moving off the legacy repo URL).

## 11. Final Recommendation

> ### **BLOCKED**
>
> All automated code, cryptographic, extension, and regression checks pass with zero defects, and staging/production separation is verified clean. However, per G-G1 Acceptance Criteria, the overall readiness gate remains **BLOCKED** until the compiled NSIS `.exe` installer undergoes interactive fresh-install, upgrade, and uninstall verification on a Windows environment with `makensis.exe` available (or via the Windows CI release artifact in Windows Sandbox/VM).
