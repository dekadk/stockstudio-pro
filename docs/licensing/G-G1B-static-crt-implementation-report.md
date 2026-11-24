# TASK G-G1B FIX: Static CRT Linking Implementation Report

**Project:** StockStudio Pro Desktop (v0.3.0) + `stockstudio-nmh.exe`  
**Modified Build Script:** [scripts/prepare-nmh-bundle.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/prepare-nmh-bundle.mjs)  
**Status:** Implemented, Built & Verified Locally (Pending Clean Windows Sandbox Re-Test)

---

## 1. Exact Compiler Configuration Used

In [scripts/prepare-nmh-bundle.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/prepare-nmh-bundle.mjs):
- Preserves any existing `process.env.RUSTFLAGS` and appends `-C target-feature=+crt-static` (avoiding duplication if already set).
- Invokes Cargo with explicit target isolation:
  ```text
  RUSTFLAGS="<existing> -C target-feature=+crt-static"
  cargo build --release --target x86_64-pc-windows-msvc --manifest-path "src-tauri/Cargo.toml" -p stockstudio-nmh --bin stockstudio-nmh
  ```
- Output binary path: `src-tauri\target\x86_64-pc-windows-msvc\release\stockstudio-nmh.exe`, staged to `src-tauri\binaries\stockstudio-nmh-x86_64-pc-windows-msvc.exe`.

## 2. Evidence That Static CRT Was Applied to NMH Only

- No `.cargo/config.toml` or workspace-wide `RUSTFLAGS` was added.
- `RUSTFLAGS="-C target-feature=+crt-static"` is scoped exclusively to the child `execSync` environment for `-p stockstudio-nmh --bin stockstudio-nmh` with `--target x86_64-pc-windows-msvc`, keeping its target directory and artifacts completely isolated from `stockstudio-pro.exe` (`src-tauri/target/release/stockstudio-pro.exe`).

## 3. Before / After PE Import Table Comparison

| Metric | Before (Dynamic CRT) | After (Static CRT) |
| :--- | :--- | :--- |
| **Binary Size** | `699,392` bytes | `796,160` bytes (`+96.8 KiB`) |
| **Total Imported DLLs** | `12` | **`5`** |
| **Dynamic VC++ CRT DLLs** | **`VCRUNTIME140.dll`** | **None (`0`)** |
| **UCRT API-Set Forwarders** | 6 (`api-ms-win-crt-*-l1-1-0.dll`) | **None (`0`)** |
| **OS System DLLs Imported** | `bcryptprimitives.dll`, `kernel32.dll`, `advapi32.dll`, `api-ms-win-core-synch-l1-2-0.dll`, `ntdll.dll` | `bcryptprimitives.dll`, `kernel32.dll`, `advapi32.dll`, `api-ms-win-core-synch-l1-2-0.dll`, `ntdll.dll` |

## 4. Automated Dependency Guard Behavior

Added a zero-external-dependency PE32/PE32+ import directory parser (`readPeImportedDlls` + `assertNoForbiddenCrtImports`) inside [scripts/prepare-nmh-bundle.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/prepare-nmh-bundle.mjs):
- Parses both the built `stockstudio-nmh.exe` and the staged `src-tauri\binaries\stockstudio-nmh-x86_64-pc-windows-msvc.exe`.
- Fails the build with a clear error listing the offending DLL(s) and full import list if any of `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, or `MSVCP140.dll` is imported.
- Observed build log:
  ```text
  [prepare-nmh-bundle] PE import check passed (5 OS imports, 0 dynamic VC++ CRT DLLs): bcryptprimitives.dll, kernel32.dll, advapi32.dll, api-ms-win-core-synch-l1-2-0.dll, ntdll.dll
  ```

## 5. New NMH Binary Details

- **Path:** `src-tauri\binaries\stockstudio-nmh-x86_64-pc-windows-msvc.exe`
- **Size:** `796,160` bytes
- **Timestamp:** `2026-11-21 22:16:59`
- **Imports:** `bcryptprimitives.dll`, `kernel32.dll`, `advapi32.dll`, `api-ms-win-core-synch-l1-2-0.dll`, `ntdll.dll`

## 6. NSIS Rebuild Result

- **Command:** `npm run tauri -- build --bundles nsis` (with staging environment variables and pinned Extension ID `ejcjoljemplfeenipjehlhhclbkpialk`).
- **Compiled Installer:** `src-tauri\target\release\bundle\nsis\StockStudio Pro_0.2.0_x64-setup.exe`
- **Size:** `3,877,685` bytes (`+30.2 KiB` vs. prior `3,847,443` bytes)
- **Timestamp:** `2026-11-21 22:17:59`
- **NSIS Bundling Confirmation:** `makensis` bundled the newly staged static-CRT `stockstudio-nmh-x86_64-pc-windows-msvc.exe` as `$INSTDIR\stockstudio-nmh.exe`.

## 7. Regression Test Results

| Command | Result |
| :--- | :--- |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | **Passed** |
| `cargo check --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**0 warnings**) |
| `cargo test --workspace --manifest-path src-tauri/Cargo.toml` | **Passed** (**48 passed, 0 failed**) |
| `npm run typecheck` | **Passed** |
| `npm run build` | **Passed** (`dist/` built in 1.54s) |
| `npm --prefix workers/license-api test` | **Passed** (**7 passed, 0 failed**) |
| `node scripts/test-extension-license-client.mjs` | **Passed** (**7/7 groups**) |
| `node scripts/test-e2e-unified-licensing.mjs` | **Passed** (`ALL_TASK_GF_E2E_CHECKS_PASSED`) |
| `node --check` on all 5 extension JS files | **Passed** |

## 8. Changed Files

- [scripts/prepare-nmh-bundle.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/prepare-nmh-bundle.mjs) — Static CRT `RUSTFLAGS` + automated PE import-table validation.
- [docs/licensing/G-G1B-static-crt-implementation-report.md](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/docs/licensing/G-G1B-static-crt-implementation-report.md) — This implementation report.

## 9. Remaining Blockers

1. **Clean-Windows Runtime Verification Pending:** Re-run the newly built `StockStudio Pro_0.2.0_x64-setup.exe` inside Windows Sandbox to confirm `stockstudio-nmh.exe` launches cleanly without `0xC0000135` and responds to a framed `get_license_status` request on clean Windows without VC++ Redistributable.
2. **True Earlier-Build Upgrade Test:** Still requires a previous StockStudio Pro NSIS `.exe` installer artifact (as documented in G-G1B).
