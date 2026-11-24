# TASK G-A: Unified Licensing Implementation Roadmap

**Status:** Architecture Roadmap (No implementation performed in G-A)  
**Target Release:** StockStudio Pro v0.3.x + `Vectorize.ai Download` v1.1.0

---

## 1. Backward Compatibility Assessment

| Component | Compatibility Impact | Notes |
| :--- | :--- | :--- |
| **Cloudflare D1 Database** | **100% Backward-Compatible (Zero Migrations Required)** | Uses existing `licenses.entitlements_json` JSON column. Existing `licenses`, `devices`, and `activations` rows work unchanged. |
| **Cloudflare Worker API (`workers/license-api/`)** | **100% Backward-Compatible** | Additive optional `products` field inside `entitlements` (defaults to `["desktop", "vectorizer_extension"]` when absent). `X-Client-Product` remains `com.stockstudiopro.desktop`. |
| **Existing Desktop v0.2.0 / v0.3.0 Clients** | **100% Backward-Compatible** | Existing `LicenseState` fields and Tauri commands are preserved verbatim. Unknown JSON fields in `SignedLeasePayload.entitlements` are safely ignored by older clients (`serde` default). |
| **Windows Device Slot Quota** | **Zero Slot Increase** | Desktop and Extension share 1 `device_id`, 1 `device_fingerprint`, and 1 `activations` row. |
| **7-Day Offline Grace & Clock Rollback** | **Identical Policy** | Both Desktop and `stockstudio-nmh.exe` execute the exact same verification logic from `stockstudio-license-core`. |

---

## 2. Phased Implementation Plan

### Phase 1: Extract Shared Rust Licensing Core (`stockstudio-license-core`)
- **Scope:** Refactor non-Tauri logic from `src-tauri/src/license_store.rs` into a shared internal Rust module/crate (`src-tauri/crates/license-core/` or library target) used by both `stockstudio-pro` and `stockstudio-nmh`.
- **Key Improvements:**
  - Atomic write-then-rename for `license-state.json` (prevents concurrent Desktop + NMH corruption).
  - Add `#[serde(default = "default_products")] pub products: Vec<String>` to `LicenseEntitlements`.
  - Add `check_product_entitlement(product: &str, force_refresh: bool) -> EntitlementVerdict` helper (local Ed25519 verify first; online `/v1/licenses/validate` refresh if lease age > 12h or `force_refresh`; automatic 7-day offline grace fallback; immediate credential wipe on terminal 401/403).
- **Acceptance Criteria:** All existing 37+ Rust tests pass unchanged; new unit tests cover atomic state writes, `products` entitlement matching, stale lease refresh, offline grace, and terminal revocation.

### Phase 2: Build Native Messaging Host (`stockstudio-nmh.exe`) & NSIS Installer Hooks
- **Scope:**
  - Add `[[bin]] name = "stockstudio-nmh"` in `src-tauri/Cargo.toml` (lean binary, no WebView2/Tauri GUI runtime).
  - Implement 4-byte little-endian length-prefixed JSON stdio framing, 64 KB inbound cap, caller origin check (`argv[1]`), `nonce`/`request_id` echo, and `check_entitlement` / `ping` handlers.
  - Bundle `stockstudio-nmh.exe` in `src-tauri/tauri.conf.json` (`externalBin` or NSIS resource) and update `src-tauri/installer-hooks.nsh` to write `com.stockstudiopro.license_bridge.json` and register/unregister `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license_bridge`.
- **Acceptance Criteria:** Automated Rust stdin/stdout framing tests pass; manual test confirms `stockstudio-nmh.exe` returns valid verdict both when Desktop is open and when Desktop is closed.

### Phase 3: Additive Backend Entitlement Enhancement (`workers/license-api/`)
- **Scope:**
  - Update `LicenseEntitlements` in `workers/license-api/src/types.ts` and `DEFAULT_ENTITLEMENTS` / `parseEntitlements()` in `src/utils.ts` to include `products: ["desktop", "vectorizer_extension"]`.
  - Optionally record `X-Client-Component` in `license_events.metadata_json` during `/v1/licenses/validate`.
  - Add unit tests in `workers/license-api/tests/license-api.test.ts` verifying legacy rows without `products` default cleanly and custom admin-restricted `products` are preserved in the signed Ed25519 lease.
- **Acceptance Criteria:** Existing Worker test suite passes 100%; staging deployment verified without touching production data.

### Phase 4: Chrome Extension ID Pinning & Thin License Gate
- **Prerequisite Blocker to Resolve First:** Pin a deterministic 32-character Chrome Extension ID (either via `"key"` in `manifest.json` for unpacked/enterprise installs or via Chrome Web Store publication).
- **Scope (`Vectorize.ai Download v1`):**
  - Add `"nativeMessaging"` to `manifest.json` `"permissions"`.
  - In `background/service-worker.js`: add `checkLicenseEntitlement(forceRefresh)` calling `chrome.runtime.sendNativeMessage("com.stockstudiopro.license_bridge", ...)` with a 128-bit `nonce`, caching the verdict in `chrome.storage.session` (TTL 10 min) — never `chrome.storage.local`.
  - In `popup/popup.js` and `content/content.js`: query background for entitlement status before enabling export/batch actions; show a clean locked state ("Activate StockStudio Pro Desktop to unlock") when `authorized === false`.
- **Acceptance Criteria:** Extension unlocks automatically when Desktop is activated, stays unlocked offline for up to 7 days, locks immediately after Desktop deactivation or server revocation, and never stores any license key or token in Chrome storage.

### Phase 5: End-to-End Verification Matrix
1. **Single Key, Single Slot:** Activate Desktop -> open Extension -> verify `devices_used === 1` in D1 and `/v1/licenses/devices`.
2. **Desktop Closed:** Close StockStudio Pro Desktop completely -> trigger Extension check -> verify `stockstudio-nmh.exe` validates cleanly.
3. **Offline Grace (7 Days):** Disconnect network -> verify both Desktop and Extension remain authorized within 7 days and lock after 7 days or clock rollback (>5 min).
4. **Immediate Revocation:** Revoke license via `/v1/admin/licenses/:id/revoke` -> trigger validation -> verify both Desktop and Extension lock immediately and local credentials are wiped.
5. **Multi-Profile Chrome:** Open 2 Chrome profiles under the same Windows user -> verify both work on the same 1 device slot.

---

## 3. Unresolved Technical Blockers

1. **Unpinned Chrome Extension ID:** `Vectorize.ai Download v1/manifest.json` currently has no `"key"` field and is distributed unpacked. Chrome Native Messaging requires an exact `chrome-extension://<id>/` in `allowed_origins`. **Action needed before Phase 2/4:** Decide whether to pin an RSA public key in `manifest.json` or publish to Chrome Web Store first to obtain the permanent ID.
2. **Production Ed25519 Public Key & Domain Provisioning:** `src-tauri/src/license_store.rs` (`EMBEDDED_PROD_VERIFYING_KEYS`) currently has an empty production key list until the production custom domain and production Ed25519 keypair are provisioned. Both `stockstudio-pro.exe` and `stockstudio-nmh.exe` will inherit the production key automatically once configured in `stockstudio-license-core`.
