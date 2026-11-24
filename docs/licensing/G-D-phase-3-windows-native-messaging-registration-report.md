# TASK G-D: Phase 3 — Windows Native Messaging Host Registration Report

**Project:** StockStudio Pro (v0.3.0)  
**Host Name:** `com.stockstudiopro.license`  
**Registry Target:** `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license`  
**Status:** Completed & Verified (Zero warnings, 48/48 workspace tests passing)

---

## 1. Changed & Created Files

| File | Purpose |
| :--- | :--- |
| [scripts/prepare-nmh-bundle.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/prepare-nmh-bundle.mjs) | Builds `stockstudio-nmh.exe` in release mode, stages it to `src-tauri/binaries/stockstudio-nmh-<target-triple>.exe`, and generates `src-tauri/native-messaging/extension-id.nsh` from `STOCKSTUDIO_EXTENSION_ID` (validating exact 32-char `a-p` format or preserving the safe placeholder). Never mutates Windows Registry. |
| [src-tauri/tauri.conf.json](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/tauri.conf.json) | Added `"externalBin": ["binaries/stockstudio-nmh"]` so Tauri NSIS installs `stockstudio-nmh.exe` directly into `$INSTDIR\stockstudio-nmh.exe` alongside `stockstudio-pro.exe`; updated `beforeBuildCommand` to `"npm run build && node scripts/prepare-nmh-bundle.mjs"`. |
| [src-tauri/installer-hooks.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/installer-hooks.nsh) | Preserved all existing Start Menu / Desktop shortcuts and uninstall data prompts; added JSON-path escaping (`SSPRO_ESCAPE_JSON_PATH`), conditional `com.stockstudiopro.license.json` manifest generation + `HKCU` registration in `NSIS_HOOK_POSTINSTALL`, and safe cleanup in `NSIS_HOOK_PREUNINSTALL` (`${If} $UpdateMode <> 1`). |
| [src-tauri/native-messaging/com.stockstudiopro.license.template.json](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/native-messaging/com.stockstudiopro.license.template.json) | Checked-in reference Native Messaging Host manifest template (`type: "stdio"`, placeholder ID, zero secrets). |
| [src-tauri/native-messaging/extension-id.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/native-messaging/extension-id.nsh) | Default NSIS include defining `!define STOCKSTUDIO_EXTENSION_ID "__STOCKSTUDIO_EXTENSION_ID_PLACEHOLDER__"`. |
| [src-tauri/crates/stockstudio-nmh/src/manifest.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/src/manifest.rs) & [tests/nmh_tests.rs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/crates/stockstudio-nmh/tests/nmh_tests.rs) | Added `NATIVE_HOST_NAME`, `NATIVE_HOST_REGISTRY_SUBKEY`, `is_valid_chrome_extension_id()`, `build_host_manifest_json()`, and unit tests verifying exact 32-char `a-p` validation and wildcard/placeholder rejection. |
| [.gitignore](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/.gitignore) | Ignored `/src-tauri/binaries/*.exe` so staged compiled executables are never committed. |

---

## 2. Installer & Registry Behavior

| Lifecycle Scenario | Behavior |
| :--- | :--- |
| **Fresh Install (with `STOCKSTUDIO_EXTENSION_ID` configured)** | Installs `$INSTDIR\stockstudio-nmh.exe`, writes `$INSTDIR\native-messaging\com.stockstudiopro.license.json` with JSON-escaped executable path and exact `chrome-extension://<id>/` origin, and sets `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license` default value to the manifest path. Requires no administrator privileges. |
| **Fresh Install (placeholder ID — ID not yet pinned)** | Bundles `$INSTDIR\stockstudio-nmh.exe` safely, but **skips** writing a placeholder manifest and **skips** writing `HKCU` registry entries so Chrome never receives a broken registration. |
| **Upgrade (`$UpdateMode = 1`)** | `NSIS_HOOK_PREUNINSTALL` skips deletion when `$UpdateMode = 1`; `NSIS_HOOK_POSTINSTALL` idempotently refreshes `stockstudio-nmh.exe`, the manifest JSON, and the `HKCU` registry value. |
| **Uninstall (`$UpdateMode <> 1`)** | Removes **only** `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license`, `$INSTDIR\native-messaging\com.stockstudiopro.license.json`, and empty `$INSTDIR\native-messaging`. Never touches registrations belonging to other applications. |
| **Reinstall** | Cleanly recreates `$INSTDIR\stockstudio-nmh.exe`, manifest JSON, and `HKCU` key. |
| **Development Builds (`cargo test`, `npm run dev`)** | Zero Windows Registry mutations occur during development or test runs. |

---

## 3. Build-Time Chrome Extension ID Configuration

When the final Chrome Extension ID is decided (Phase 4), pass it at release build time (or configure it as a GitHub Actions secret/var in `.github/workflows/release.yml`):

```powershell
$env:STOCKSTUDIO_EXTENSION_ID = "<exact-32-lowercase-a-p-chrome-extension-id>"
npm run tauri build
```

`scripts/prepare-nmh-bundle.mjs` rejects any ID that does not match `/^[a-p]{32}$/` (no wildcards, no uppercase, no placeholders).

---

## 4. Verification Results

| Check | Result |
| :--- | :--- |
| `node scripts/prepare-nmh-bundle.mjs` | **Passed** — compiled release `stockstudio-nmh.exe` and staged `src-tauri/binaries/stockstudio-nmh-x86_64-pc-windows-msvc.exe` |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml` | **Passed** |
| `cargo check --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**0 warnings**, 0 errors) |
| `cargo test --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**48 passed, 0 failed**: 6 `stockstudio-license-core` + 5 `stockstudio-nmh` + 37 `stockstudio-pro`) |
| `npm run typecheck` | **Passed** |
| `npm run build` | **Passed** (`dist/` built in 1.41s) |

---

## 5. Remaining Blockers

1. **Final Chrome Extension ID Not Yet Decided:** `STOCKSTUDIO_EXTENSION_ID` currently defaults to `__STOCKSTUDIO_EXTENSION_ID_PLACEHOLDER__` (by design in Phase 3). Live NSIS `HKCU` registration activates automatically once the final 32-character Extension ID is pinned and passed at build time.
2. **Full NSIS `.exe` Installer Smoke Test:** Because `makensis` / full `tauri build` packaging was not executed on this dev machine (and the final Extension ID is not yet pinned), fresh install / upgrade / uninstall verification of the compiled NSIS `.exe` should be run in Windows CI or local NSIS test once the Extension ID is supplied.
