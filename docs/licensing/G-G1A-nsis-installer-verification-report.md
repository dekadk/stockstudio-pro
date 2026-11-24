# TASK G-G1A: NSIS Installer Verification Report

**Project:** StockStudio Pro Desktop (v0.3.0) + `Vectorize.ai Download v1`  
**Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk`  
**Native Messaging Host:** `com.stockstudiopro.license`  
**Final Decision:** **`G-G1 BLOCKED`** (NSIS 3.11 installer build succeeded, but interactive Fresh Install / Upgrade / Uninstall tests are blocked because no isolated Windows Sandbox or VM is enabled on this workstation)

---

## 1. Environment Check & NSIS Version

| Component | Status | Evidence |
| :--- | :--- | :--- |
| **Operating System** | Ready | `Microsoft Windows 11 Pro` (`10.0.26200`, 64-bit) |
| **Package Managers (`winget`, `choco`, `scoop`)** | Not installed | None present on `PATH` |
| **NSIS (`makensis.exe`)** | **Installed via Tauri official hash-verified bundle** | `%LOCALAPPDATA%\tauri\NSIS\makensis.exe` — **NSIS `v3.11`** (with `nsis_tauri_utils-v0.5.3`) |
| **Windows Sandbox (`WindowsSandbox.exe`)** | **Not enabled** | `C:\Windows\System32\WindowsSandbox.exe` = `False` |
| **Hyper-V (`vmms`)** | **Not installed** | Service `vmms` = `NOT_INSTALLED` |
| **VirtualBox / VMware** | **Not installed** | `VBoxManage.exe` and `vmrun.exe` = `NOT_FOUND` |
| **Host StockStudio Pro Install** | Untouched | `%LOCALAPPDATA%\StockStudio Pro` = `False` (never mutated) |

---

## 2. Installer Build Result (Phase 2 — **PASSED**)

Executed `npm run tauri -- build --bundles nsis` with staging build environment variables (`STOCKSTUDIO_EXTENSION_ID=ejcjoljemplfeenipjehlhhclbkpialk`, staging API URL, staging KID, staging public key):

- **Compiled NSIS Installer Artifact:**  
  `E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main\src-tauri\target\release\bundle\nsis\StockStudio Pro_0.2.0_x64-setup.exe` (`3,847,443` bytes)
- **Verified in Generated `src-tauri/target/release/nsis/x64/installer.nsi`:**
  - Line 31: `!include "E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main\src-tauri\installer-hooks.nsh"`
  - Line 644: `File /a "/oname=stockstudio-nmh.exe" "E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main\src-tauri\binaries\stockstudio-nmh-x86_64-pc-windows-msvc.exe"`
  - Line 763: `Delete "$INSTDIR\stockstudio-nmh.exe"`
- **Manifest & Extension ID Verification:**
  - `src-tauri/native-messaging/extension-id.nsh` defines `!define STOCKSTUDIO_EXTENSION_ID "ejcjoljemplfeenipjehlhhclbkpialk"`.
  - `installer-hooks.nsh` compiled cleanly under NSIS `v3.11` with zero syntax errors (`SSPRO_ESCAPE_JSON_PATH`, `WriteRegStr HKCU`, `DeleteRegKey HKCU`, `$UpdateMode <> 1`).
- **Note on Updater Signature Step:** After `makensis` finished producing `StockStudio Pro_0.2.0_x64-setup.exe`, Tauri's post-bundle updater signing step exited non-zero solely because `TAURI_SIGNING_PRIVATE_KEY` is intentionally not set on this dev workstation (production updater signing key lives only in GitHub Actions secrets). The NSIS `.exe` installer itself was produced cleanly.

---

## 3. Isolated Installation Tests (Phase 3 — **BLOCKED**)

Per TASK G-G1A constraints, installation tests must run inside Windows Sandbox or an isolated Windows VM and must never be simulated or run destructively on the host environment.

| Test | Status | Reason |
| :--- | :--- | :--- |
| **A. Fresh Installation** | **BLOCKED** | No Windows Sandbox, Hyper-V VM, VirtualBox, or VMware available on this workstation. |
| **B. Upgrade Installation** | **BLOCKED** | Same isolated environment prerequisite missing. |
| **C. Uninstallation** | **BLOCKED** | Same isolated environment prerequisite missing. |

---

## 4. Regression Verification & Defects Fixed

- **Source Files Modified:** None (0 defects encountered during NSIS `v3.11` compilation).
- **Regression Baseline:** All automated Rust (`48/48`, 0 warnings), Cloudflare Worker (`7/7`), Chrome Extension (`7/7` + 5 JS syntax checks), E2E (`ALL_TASK_GF_E2E_CHECKS_PASSED`), and Frontend (`typecheck` + `build`) suites passed in TASK G-G1 with zero subsequent code edits.

---

## 5. Remaining Blocker & Exact Steps to Unblock

- **Only Remaining Blocker:** Enable **Windows Sandbox** on this Windows 11 Pro machine (requires one administrator PowerShell command + reboot) or copy `src-tauri\target\release\bundle\nsis\StockStudio Pro_0.2.0_x64-setup.exe` into an isolated Windows VM, then execute:
  1. **Fresh Install:** Run `StockStudio Pro_0.2.0_x64-setup.exe` inside Windows Sandbox; verify `%LOCALAPPDATA%\StockStudio Pro\stockstudio-nmh.exe`, `%LOCALAPPDATA%\StockStudio Pro\native-messaging\com.stockstudiopro.license.json` (valid JSON, exact ID `ejcjoljemplfeenipjehlhhclbkpialk`, escaped path), and `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license`.
  2. **Upgrade:** Re-run installer over existing Sandbox install; confirm registration and license state remain intact with no duplicate keys.
  3. **Uninstall:** Uninstall from Settings/Control Panel; confirm `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license` and `com.stockstudiopro.license.json` are removed cleanly.

---

## 6. Final Decision

> ### **`G-G1 BLOCKED`**
>
> NSIS `v3.11` compilation and `stockstudio-nmh.exe` bundling are now **verified and passing** (`StockStudio Pro_0.2.0_x64-setup.exe` built cleanly). Only the interactive Fresh Install, Upgrade, and Uninstall execution inside an isolated Windows Sandbox / VM remains blocked by local VM/Sandbox availability.
