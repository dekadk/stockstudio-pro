# TASK G-B: Phase 1 — Shared Rust License Core Extraction Report

**Project:** StockStudio Pro (v0.3.0)  
**Crate Path:** `src-tauri/crates/stockstudio-license-core/`  
**Status:** Completed & Verified (Zero warnings, 43/43 tests passing)

---

## 1. Extracted Crate Structure & Modules

Created reusable, platform-agnostic Rust library crate `stockstudio-license-core` (zero Tauri, WebView, HTTP, or OS keyring dependencies):

| File | Responsibilities |
| :--- | :--- |
| [Cargo.toml](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/Cargo.toml) | Pure Rust dependencies already locked in the workspace (`ed25519-dalek`, `base64`, `chrono`, `serde`, `serde_json`, `sha2`, `url`, `uuid`). |
| [src/lib.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/lib.rs) | Shared constants (`PRODUCT_ID`, `PRODUCT_DESKTOP`, `PRODUCT_VECTORIZER_EXTENSION`, `EXPECTED_ISSUER`, `CLOCK_ROLLBACK_TOLERANCE_SECONDS = 300`, `OFFLINE_GRACE_MAX_SECONDS = 7d`, keyring service/account names) and public re-exports. |
| [src/error.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/error.rs) | Typed `LicenseCoreError` enum preserving exact Desktop UI error messages (`Display`), `is_terminal_error_code()`, and `map_error_code_to_user_message()`. |
| [src/models.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/models.rs) | `ProductEntitlement` (`desktop`, `vectorizer_extension`), `LicenseEntitlements` (with `is_product_entitled()`), `LicenseState`, `SignedLeasePayload`, `LicenseDeviceInfo`, `LicenseDevicesResponse`, `DeactivateLicenseResponse`, `DeviceIdentity`, and sanitized `ExtensionAuthVerdict` (zero secrets). |
| [src/storage.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/storage.rs) | Platform-neutral `SecretStore` trait, atomic `write_state_file_atomic()` (same-directory `.tmp` + `sync_all()` + rename), validated `read_state_file()` (rejects empty/corrupted JSON with `CorruptedPersistedState`), `ensure_device_id()`, `compute_device_fingerprint()`, `sanitize_device_name()`, `record_clock_anchor()`, `read_clock_anchor()`, and `clear_license_credentials_preserving_device_id()`. |
| [src/verify.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/verify.rs) | Single source of truth for `verify_signed_lease_token()` (Ed25519 + explicit `UnknownSigningKeyId` rejection), `evaluate_offline_lease()` (7-day hard ceiling, 5-minute clock rollback tolerance against `iat` and `clock-anchor`, subscription `expires_at` cap), `lease_to_license_state()`, and `evaluate_product_verdict()`. |
| [src/config.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/src/config.rs) | `validate_api_base_url()`, `resolve_api_base_url_for_mode()`, and `resolve_verifying_keys_for_mode()` preserving strict dev/staging vs. production key isolation. |
| [tests/license_core_tests.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-license-core/tests/license_core_tests.rs) | 6 comprehensive unit tests covering all TASK G-B Section 6 requirements. |

---

## 2. Modified Desktop Files

- **[src-tauri/Cargo.toml](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/Cargo.toml):** Configured Cargo workspace (`members = [".", "crates/stockstudio-license-core"]`) and added `stockstudio-license-core` path dependency.
- **[src-tauri/src/license_store.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/src/license_store.rs):** Refactored to delegate all cryptographic verification, offline grace, clock rollback, entitlement parsing, device fingerprinting, and atomic `license-state.json` persistence to `stockstudio_license_core::*`. Kept platform-specific `KeyringSecretStore` (Windows Credential Manager), Windows `MachineGuid` lookup, `reqwest` HTTP client, Tauri `AppHandle` path resolution, and all 7 `#[tauri::command]` handlers unchanged.

---

## 3. Compatibility & Security Findings

1. **Existing Activated Installations:** 100% compatible. Windows Credential Manager service (`StockStudioPro`) and account names (`device-id`, `license-key`, `activation-token`, `clock-anchor`) and `license-state.json` schema are unchanged.
2. **Product Entitlements Without Silent Extension Grant:** `LicenseEntitlements::is_product_entitled()` allows `desktop` on legacy licenses that omit `products`, while `vectorizer_extension` returns `false` (`PRODUCT_NOT_ENTITLED`) unless explicitly present in `products` or `features`.
3. **Zero Credential Exposure:** `ExtensionAuthVerdict` contains only non-sensitive status and display metadata (`authorized`, `product`, `license_status`, `license_type`, `plan_name`, `expires_at`, `offline_grace_until`, `is_offline_grace`, `error_code`, `error_message`).
4. **Atomic Persistence:** `write_state_file_atomic()` writes to a unique `.tmp` file in `%LOCALAPPDATA%\com.stockstudiopro.desktop\`, calls `sync_all()`, renames atomically, and cleans up on failure.

---

## 4. Verification Results

| Check | Result |
| :--- | :--- |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml` | **Passed** |
| `cargo check --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (0 warnings, 0 errors) |
| `cargo test --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**6** `stockstudio-license-core` tests + **37** `stockstudio-pro` tests = **43 passed, 0 failed**) |
| `npm run typecheck` | **Passed** |
| `npm run build` | **Passed** (`dist/` built in 1.45s) |

---

## 5. Remaining Blockers (For Future Phases)

1. **Chrome Extension ID Pinning (Phase 2/4):** `Vectorize.ai Download v1\manifest.json` still needs a pinned `"key"` or Chrome Web Store ID before `allowed_origins` can be finalized in `stockstudio-nmh.exe` and NSIS hooks.
2. **Production Ed25519 Key & Domain Provisioning:** `EMBEDDED_PROD_VERIFYING_KEYS` in `stockstudio-license-core/src/config.rs` remains intentionally empty until production keys and domain are provisioned.
