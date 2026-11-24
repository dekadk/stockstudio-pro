# TASK G-E: Phase 4 — Chrome Extension Unified License Integration Report

**Project:** StockStudio Pro (v0.3.0) + `Vectorize.ai Download v1`  
**Native Messaging Host:** `com.stockstudiopro.license`  
**Final Pinned Chrome Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk`  
**Status:** Completed & Verified (All Phase 4 Extension Tests + 48/48 Rust Workspace Tests + Frontend Build Passing)

---

## 1. Stable Extension Identity Decision

- **Distribution Model:** Private distribution with RSA-2048 public key pinned in `manifest.json` (`"key"`). Not published to Chrome Web Store.
- **Pinned Chrome Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk` (mathematically derived from `SHA-256(SPKI DER)` mapped to Chrome's `a-p` alphabet).
- **Private Key Storage (Out-of-Repo):** Stored exclusively outside the repository and extension folder at `C:\Users\ok\AppData\Local\StockStudioPro-DevKeys\vectorizer-extension-private.pem`. Never committed to Git or bundled with StockStudio Pro or the extension.
- **Desktop Build Environment Configuration:** Staged in [src-tauri/native-messaging/extension-id.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/native-messaging/extension-id.nsh) via `STOCKSTUDIO_EXTENSION_ID=ejcjoljemplfeenipjehlhhclbkpialk node scripts/prepare-nmh-bundle.mjs`.

---

## 2. Changed & Created Files

### Chrome Extension (`E:\2. Microstock\TOOL\Chrome Extension\Vectorize.ai Download v1`)
| File | Changes |
| :--- | :--- |
| [manifest.json](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/manifest.json) | Added pinned RSA-2048 `"key"` (`ejcjoljemplfeenipjehlhhclbkpialk`) and `"nativeMessaging"` permission. Preserved all existing permissions, host permissions, background worker, and content scripts. |
| [background/license-client.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/background/license-client.js) | New thin, independently testable Native Messaging client (`connectNative("com.stockstudiopro.license")`), request ID generation & correlation, 5-second timeout, strict response schema validation, session-only caching (`chrome.storage.session` + memory, 5-min TTL capped by `offline_grace_until` / `expires_at`, never `chrome.storage.local`), and fail-closed error handling. |
| [background/service-worker.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/background/service-worker.js) | Loaded `license-client.js`, added startup/install revalidation, and exposed `GET_LICENSE_STATUS` message handler to popup and content scripts. |
| [popup/popup.html](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/popup/popup.html), [popup/popup.css](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/popup/popup.css), [popup/popup.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/popup/popup.js) | Added StockStudio Pro license status banner + locked guidance panel (never asks for a License Key inside Chrome) and gated all export actions (`Download SVG`, `PNG 1x/2x/4x`, `Copy SVG`) behind verified authorization. |
| [content/content.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/content/content.js) | Added boot-time `GET_LICENSE_STATUS` check and fail-closed authorization gate across floating widget controls, auto-click, auto-download, batch processing, and popup download relays. |

### StockStudio Pro Repository (`E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main`)
| File | Changes |
| :--- | :--- |
| [src-tauri/native-messaging/extension-id.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/native-messaging/extension-id.nsh) | Configured exact pinned Extension ID `ejcjoljemplfeenipjehlhhclbkpialk`. |
| [scripts/test-extension-license-client.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/test-extension-license-client.mjs) | Automated Phase 4 test suite verifying stable ID derivation, manifest permissions, session-only caching, fail-closed error states, malformed/mismatched responses, and live framed stdio round-trip against `stockstudio-nmh.exe`. |

---

## 3. Verification Results

| Check | Result |
| :--- | :--- |
| `node --check` on all 4 extension JS files | **Passed** |
| `node scripts/test-extension-license-client.mjs` | **Passed** (7/7 test groups passing, including live `stockstudio-nmh.exe` stdio round-trip with Desktop closed) |
| `cargo test --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**48 passed, 0 failed**: 6 `stockstudio-license-core` + 5 `stockstudio-nmh` + 37 `stockstudio-pro`) |
| `npm run typecheck` & `npm run build` | **Passed** (`dist/` built in 1.43s) |

---

## 4. Remaining Blockers / Next Phase Notes

1. **Backend `products` Entitlement (Future Backend Phase):** Existing licenses on Cloudflare D1 that do not explicitly include `"vectorizer_extension"` in `entitlements.products` or `entitlements.features` will accurately return `PRODUCT_NOT_ENTITLED` until the backend additive entitlement update is deployed.
2. **Live Chrome + Installed NSIS Smoke Test:** Once the NSIS installer is built with `STOCKSTUDIO_EXTENSION_ID=ejcjoljemplfeenipjehlhhclbkpialk` and installed on Windows, load the unpacked extension in `chrome://extensions` to confirm Chrome displays ID `ejcjoljemplfeenipjehlhhclbkpialk` and connects live to `com.stockstudiopro.license`.
