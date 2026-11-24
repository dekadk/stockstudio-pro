# TASK G-C: Phase 2 — Native Messaging Host (`stockstudio-nmh.exe`) Report

**Project:** StockStudio Pro (v0.3.0)  
**Binary Crate:** `src-tauri/crates/stockstudio-nmh/` (`stockstudio-nmh.exe`)  
**Status:** Completed & Verified (Zero warnings, 47/47 workspace tests passing)

---

## 1. Architecture & Source Files Created

| File | Responsibility |
| :--- | :--- |
| [Cargo.toml](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/Cargo.toml) | Standalone binary crate (`stockstudio-nmh`) depending on `stockstudio-license-core`, `keyring` (`windows-native`), `chrono`, `serde`, `serde_json`, `uuid` — **zero** Tauri or WebView2 dependencies. |
| [src/framing.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/src/framing.rs) | Chrome Native Messaging 4-byte little-endian `u32` length-prefixed UTF-8 framing (`read_frame` / `write_frame`), 64 KiB inbound cap (`MAX_INBOUND_MESSAGE_BYTES`), Chrome 1 MiB outbound cap (`MAX_OUTBOUND_MESSAGE_BYTES`), zero-length and EOF guards. |
| [src/protocol.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/src/protocol.rs) | Typed `NativeRequest` (`request_id`, `command: "get_license_status"`, `product: "vectorizer_extension"`) and strictly sanitized `NativeResponse` (`request_id`, `authorized`, `license_status`, `plan_name`, `expires_at`, `offline_grace_until`, `products`, `error_code`). |
| [src/host.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/src/host.rs) | Windows Credential Manager (`KeyringSecretStore` reusing service `StockStudioPro`), `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json` resolution, Windows `MachineGuid` lookup, `handle_request_json()`, `run_once()`, and `run_stdio_host()`. |
| [src/main.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/src/main.rs) | Thin stdio entrypoint: writes **only** framed JSON responses to `stdout`; routes diagnostics strictly to `stderr`. |
| [tests/nmh_tests.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/tests/nmh_tests.rs) | Automated framing, protocol, authorization, secret-leakage, and standalone `stockstudio-nmh.exe` stdin/stdout process integration tests. |

Workspace registration updated in [src-tauri/Cargo.toml](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/Cargo.toml).

---

## 2. Security & Protocol Guarantees

- **Strict Product & Command Validation:** Only `command == "get_license_status"` and `product == "vectorizer_extension"` with a valid printable `request_id` (≤128 chars) are accepted. All other inputs fail closed with `MALFORMED_JSON`, `INVALID_REQUEST_ID`, `UNSUPPORTED_COMMAND`, or `UNSUPPORTED_PRODUCT`.
- **Single Source of Truth:** Delegates all Ed25519 signature verification, 7-day offline grace, 5-minute clock rollback protection, subscription expiration cap, and product entitlement checks to `stockstudio-license-core`.
- **Zero Secret Leakage:** Wire responses never include `license_key`, `activation_token`, `lease_token`, `device_fingerprint`, Credential Manager contents, private keys, or admin credentials (explicitly asserted in `nmh_tests.rs`).
- **Desktop Closed Support:** Reads the current Windows user's Credential Manager (`StockStudioPro`) and `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json` directly without requiring StockStudio Pro Desktop to be running and without creating a second device activation.

---

## 3. Verification Results

| Check | Result |
| :--- | :--- |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml` | **Passed** |
| `cargo check --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**0 warnings**, 0 errors) |
| `cargo test --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**47 passed, 0 failed**: 6 `stockstudio-license-core` + 4 `stockstudio-nmh` + 37 `stockstudio-pro`) |
| `npm run typecheck` | **Passed** |
| `npm run build` | **Passed** (`dist/` built in 1.39s) |

---

## 4. Remaining Blockers (Out of Phase 2 Scope)

1. **Chrome Extension ID Pinning (Phase 4):** `Vectorize.ai Download v1\manifest.json` still requires a pinned `"key"` or Chrome Web Store ID before `allowed_origins` can be finalized in the Native Messaging host manifest and NSIS registry hooks.
2. **Backend `products` Entitlement (Phase 3):** Existing licenses without `"vectorizer_extension"` in `entitlements.products` / `entitlements.features` are intentionally denied (`PRODUCT_NOT_ENTITLED`) until Phase 3 adds unified product entitlements on the backend.
3. **Production Ed25519 Public Key & Domain:** Still pending production domain/key provisioning in `stockstudio-license-core`.
