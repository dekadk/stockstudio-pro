# TASK G-F: End-to-End Unified Licensing Integration & Acceptance Report

**Project:** StockStudio Pro Desktop (v0.3.0) + `Vectorize.ai Download v1`  
**Native Messaging Host:** `com.stockstudiopro.license` (`stockstudio-nmh.exe`)  
**Pinned Chrome Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk`  
**Staging API:** `https://stockstudio-pro-license-api-staging.dekadk00.workers.dev`  
**Status:** Accepted — All Automated Rust, Worker, Extension, and E2E Checks Passing (Zero Secrets Exposed)

---

## 1. Phase 1 Preflight Inspection & Confirmed Defects Fixed

During preflight inspection of G-A through G-E, two concrete integration defects were identified and fixed before final acceptance:

1. **Defect #1 — Hardening `content/content.js` Click & Auto-Click Guards:**
   - **Finding:** `applyLicenseGateToWidget()` disabled the floating widget buttons, but the click listeners (`btnSvg`, `btnPng2`, `btnPng4`, `btnCopy`, `btnRunAuto`, `btnPickFolder`, `btnPickFiles`) and `tryAutoClickVectorizeButton()` did not independently re-check `isLicenseAuthorized`.
   - **Fix:** Added explicit `if (!isLicenseAuthorized) return;` guards inside `tryAutoClickVectorizeButton()` and all 7 manual/batch click handlers in [content/content.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/content/content.js).
2. **Defect #2 — Normalized `products` List in `stockstudio-nmh`:**
   - **Finding:** When a license granted `vectorizer_extension` via `entitlements.features` (compatible with existing Cloudflare D1 rows), `NativeResponse.products` returned only raw `entitlements.products` (`[]`) instead of the effective entitled products.
   - **Fix:** Normalized `products` in [src-tauri/crates/stockstudio-nmh/src/host.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/src/host.rs) to reflect effective product entitlements (`desktop`, `vectorizer_extension`).

---

## 2. Phase 2 Build & Installation Verification

| Check | Result | Evidence |
| :--- | :--- | :--- |
| `stockstudio-nmh.exe` built & bundled via `externalBin` | **Passed** | Valid Windows PE (`MZ`) binary staged at `src-tauri/binaries/stockstudio-nmh-x86_64-pc-windows-msvc.exe` via `prepare-nmh-bundle.mjs`. |
| Pinned Extension ID in NSIS build config | **Passed** | `src-tauri/native-messaging/extension-id.nsh` defines `!define STOCKSTUDIO_EXTENSION_ID "ejcjoljemplfeenipjehlhhclbkpialk"` (exact 32-char `a-p` match). |
| Manifest JSON validity & path escaping | **Passed** | Verified via `manifest.rs` unit tests + `SSPRO_ESCAPE_JSON_PATH` in `installer-hooks.nsh`. |
| `HKCU` registration & safe upgrade/uninstall | **Passed** | `installer-hooks.nsh` registers `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license` (no admin required), preserves registration on `$UpdateMode = 1`, and removes **only** StockStudio Pro's key + manifest on true uninstall (`$UpdateMode <> 1`). |
| Full compiled NSIS `.exe` interactive install test | **Not run on dev host** | `makensis` is not installed on this local dev machine; interactive NSIS `.exe` install/upgrade/uninstall smoke test should be executed on the Windows GitHub Actions release artifact (`release.yml`). |

---

## 3. Phase 3 Unified Licensing E2E Scenario Matrix

| # | Scenario | Status | Verified By |
| :--- | :--- | :--- | :--- |
| **1** | **Valid unified license (1 key → 1 device slot → Desktop + Extension)** | **Passed** | `license-api.test.ts` (atomic single device slot), `license_store::tests` (Desktop Ed25519 activation), `nmh_tests.rs` & `test-e2e-unified-licensing.mjs` (Extension authorization via `stockstudio-nmh.exe`). |
| **2** | **Desktop closed** | **Passed** | `nmh_tests.rs` (`executes_standalone_nmh_binary_via_framed_stdin_stdout_without_desktop_running`) + `test-e2e-unified-licensing.mjs` (real `stockstudio-nmh.exe` reads shared `license-state.json` + Credential Manager with Desktop closed). |
| **3** | **Missing extension entitlement** | **Passed** | `license_core_tests.rs`, `nmh_tests.rs`, and `test-extension-license-client.mjs` (`desktop` allowed; `vectorizer_extension` denied with `PRODUCT_NOT_ENTITLED`). |
| **4** | **Offline grace (7-day ceiling + 5-min clock rollback)** | **Passed** | `license_core_tests.rs` & `nmh_tests.rs` (passes within 7 days; fails closed with `OFFLINE_GRACE_EXPIRED` after 7 days and `CLOCK_ROLLBACK_DETECTED` on >5-min rollback). |
| **5** | **Expired subscription** | **Passed** | `license_core_tests.rs` & `nmh_tests.rs` (both Desktop core and Extension reject with `LICENSE_EXPIRED` once `now >= expires_at`, even within 7-day lease window). |
| **6** | **Revoked & suspended license** | **Passed** | `license_store::tests::falls_back_to_offline_grace_on_5xx_and_timeout_but_revokes_on_403_terminal` (403 wipes local credentials/state immediately) + `test-extension-license-client.mjs` (`LICENSE_REVOKED` / `LICENSE_SUSPENDED` fail closed). |
| **7** | **Native Messaging Host unavailable** | **Passed** | `test-extension-license-client.mjs` & `test-e2e-unified-licensing.mjs` (missing binary / disconnected port returns `NATIVE_HOST_UNAVAILABLE` and shows Desktop install/activation guidance). |
| **8** | **Malformed or unexpected response** | **Passed** | `nmh_tests.rs` (0-length, >64 KiB, invalid JSON, unknown command, unsupported product) + `test-extension-license-client.mjs` (`MALFORMED_RESPONSE`, `REQUEST_ID_MISMATCH`). |
| **9** | **Session & Chrome restart behavior** | **Passed** | `test-extension-license-client.mjs` & `test-e2e-unified-licensing.mjs` (verdict stored ONLY in volatile memory + `chrome.storage.session`, zero `chrome.storage.local` writes; clearing session triggers fresh Native Messaging query). |
| **10** | **Existing extension workflow & unauthorized gate** | **Passed** | Verified all popup exports (`Download SVG`, `PNG 1x/2x/4x`, `Copy SVG`), floating widget buttons, auto-click, auto-download, and batch folder processing are gated when unauthorized and preserved when authorized. |

---

## 4. Phase 4 Regression & Security Suite Results

| Test Suite | Result |
| :--- | :--- |
| `cargo fmt --all` & `cargo check --workspace` | **Passed** (**0 warnings**, 0 errors) |
| `cargo test --workspace` | **Passed** (**48 passed, 0 failed**: 6 `stockstudio-license-core` + 5 `stockstudio-nmh` + 37 `stockstudio-pro`) |
| `npm --prefix workers/license-api test` | **Passed** (**7 passed, 0 failed**) |
| `node scripts/test-extension-license-client.mjs` | **Passed** (**7/7 groups**) |
| `node scripts/test-e2e-unified-licensing.mjs` | **Passed** (**ALL_TASK_GF_E2E_CHECKS_PASSED**) |
| `npm run typecheck` & `npm run build` | **Passed** (`dist/` built in 1.66s) |

### Security & Preservation Confirmation
- Zero real license keys, activation tokens, private keys, or device fingerprints exposed in logs, wire responses, Chrome storage, or reports.
- Zero production signing keys, production endpoints, or unrelated Windows Registry entries modified.
- Existing Desktop features (Google Flow multi-account workspace, Background/Mascot/Pattern Studios, Download Manager, and License UI) remain 100% intact.
