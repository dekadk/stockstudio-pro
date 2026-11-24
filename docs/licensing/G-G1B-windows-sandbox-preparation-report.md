# TASK G-G1B: Windows Sandbox Preparation Report

**Project:** StockStudio Pro Desktop (v0.3.0) + `Vectorize.ai Download v1`  
**Current Installer:** `src-tauri\target\release\bundle\nsis\StockStudio Pro_0.2.0_x64-setup.exe` (`3,847,443` bytes)  
**Pinned Chrome Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk`  
**Native Messaging Host:** `com.stockstudiopro.license`  
**Status:** Preparation Complete — Ready for Fresh Install & Uninstall in Windows Sandbox; True Earlier-Build Upgrade Blocked Pending Previous Installer Artifact

---

## 1. Windows Sandbox & Virtualization Readiness

| Prerequisite | Status | Observed Evidence |
| :--- | :--- | :--- |
| **OS Edition** | **READY** | `Microsoft Windows 11 Pro` (`10.0.26200`, 64-bit) |
| **`WindowsSandbox.exe` Availability** | **READY** | Present at `C:\WINDOWS\System32\WindowsSandbox.exe` and on `PATH`. *(Note: `Get-WindowsOptionalFeature` requires elevation and was not run elevated per read-only constraints, but `WindowsSandbox.exe` presence in `System32` confirms the feature is installed.)* |
| **CPU & Hardware Virtualization** | **READY** | `Intel(R) Core(TM) i7-10700F CPU @ 2.90GHz`, `HypervisorPresent: True` *(note: `Win32_Processor.VirtualizationFirmwareEnabled` reports `False` in the Windows root partition whenever the Hyper-V hypervisor is already active and managing VT-x/SLAT)*. |
| **System Memory** | **READY** | `32 GiB` (`34,283,032,576` bytes — exceeds 4 GiB minimum). |

---

## 2. Previous Installer Availability (Upgrade Test Blocker)

- **Search Scope:** `E:\2. Microstock\TOOL\flowpilot-main` (recursive `*setup*.exe`)
- **Found:** Only the current build `src-tauri\target\release\bundle\nsis\StockStudio Pro_0.2.0_x64-setup.exe`.
- **Previous Installer Available?** **No.**
- **Impact:**
  - **Fresh Installation & Uninstallation:** **READY** to execute in Windows Sandbox immediately.
  - **True Upgrade Test (earlier build → new build):** **BLOCKED** until a previous StockStudio Pro NSIS `.exe` installer (e.g., an earlier release or pre-G-D baseline build) is supplied. Re-running the current `0.2.0` installer over itself verifies in-place reinstall / `$UpdateMode = 1` preservation, but does not substitute for a true earlier-build upgrade.

---

## 3. Current Installer Paths & Expected Artifacts

Verified directly from generated `src-tauri\target\release\nsis\x64\installer.nsi` and [installer-hooks.nsh](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/src-tauri/installer-hooks.nsh):

| Artifact | Expected Path Inside Windows Sandbox |
| :--- | :--- |
| **Install Directory (`$INSTDIR`)** | `%LOCALAPPDATA%\StockStudio Pro` (default per-user NSIS mode) |
| **Desktop Executable** | `%LOCALAPPDATA%\StockStudio Pro\stockstudio-pro.exe` |
| **Native Messaging Host Executable** | `%LOCALAPPDATA%\StockStudio Pro\stockstudio-nmh.exe` |
| **Uninstall Executable** | `%LOCALAPPDATA%\StockStudio Pro\uninstall.exe` |
| **Native Messaging Manifest JSON** | `%LOCALAPPDATA%\StockStudio Pro\native-messaging\com.stockstudiopro.license.json` |
| **HKCU Registry Key** | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license` (Default `REG_SZ` = manifest path above) |
| **App User Data Directory** | `%LOCALAPPDATA%\com.stockstudiopro.desktop\` (`license-state.json`, account/session data) |

---

## 4. Exact Files to Transfer Into Windows Sandbox

Copy (or map read-only via a `.wsb` folder mapping) into a clean folder inside Windows Sandbox (e.g., `C:\SandboxTest\`):

1. **Current Installer:**  
   `E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main\src-tauri\target\release\bundle\nsis\StockStudio Pro_0.2.0_x64-setup.exe`
2. **Previous Installer (Required to unblock Test B — Upgrade):**  
   *(Unavailable locally — supply an earlier StockStudio Pro NSIS `.exe` before running Test B.)*
3. **Optional — Chrome Extension (only if testing live Chrome connection inside Sandbox):**  
   `E:\2. Microstock\TOOL\Chrome Extension\Vectorize.ai Download v1\` (read-only copy; never include any private key `.pem` files).

> **Security Note:** Do **not** copy `.env`, `.dev.vars`, `bootstrap-*.json`, `staging-test-license.json`, or `%LOCALAPPDATA%\StockStudioPro-DevKeys\` into Windows Sandbox.

---

## 5. Windows Sandbox Verification Checklist (Do Not Execute Yet)

### A. Fresh Installation
1. Pre-seed an unrelated dummy registry key under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.example.unrelated` (Default = `C:\dummy.json`) to verify uninstall isolation later.
2. Run `StockStudio Pro_0.2.0_x64-setup.exe` inside Windows Sandbox.
3. Verify `%LOCALAPPDATA%\StockStudio Pro\stockstudio-pro.exe` launches cleanly.
4. Verify `%LOCALAPPDATA%\StockStudio Pro\stockstudio-nmh.exe` exists.
5. Verify `%LOCALAPPDATA%\StockStudio Pro\native-messaging\com.stockstudiopro.license.json` exists, parses as valid JSON, contains:
   - `"name": "com.stockstudiopro.license"`
   - `"type": "stdio"`
   - `"path"` resolving to the exact installed `stockstudio-nmh.exe`
   - `"allowed_origins": ["chrome-extension://ejcjoljemplfeenipjehlhhclbkpialk/"]`
6. Verify `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license` returns the exact manifest JSON path as `(Default)`.

### B. Upgrade From a Previous Build *(Blocked Until Previous Installer Is Supplied)*
1. In a clean Sandbox session, install the earlier StockStudio Pro NSIS build.
2. Seed or activate a test state in `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json`.
3. Run `StockStudio Pro_0.2.0_x64-setup.exe` over the existing installation.
4. Verify `stockstudio-nmh.exe`, `com.stockstudiopro.license.json`, and the `HKCU` registry entry are present and valid with zero duplicate keys.
5. Verify `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json` is preserved intact.

### C. Uninstallation & User Data Preservation
1. Create a marker file `%LOCALAPPDATA%\com.stockstudiopro.desktop\keep-check.txt` (or keep existing user data).
2. Run `%LOCALAPPDATA%\StockStudio Pro\uninstall.exe` and choose **No** when prompted whether to remove StockStudio Pro account data and Google Flow sessions.
3. Verify `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license` is **removed**.
4. Verify `%LOCALAPPDATA%\StockStudio Pro\native-messaging\com.stockstudiopro.license.json` and `stockstudio-nmh.exe` are **removed**.
5. Verify `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.example.unrelated` is **untouched**.
6. Verify `%LOCALAPPDATA%\com.stockstudiopro.desktop\keep-check.txt` is **preserved**.

---

## 6. Blockers Summary

1. **Missing Previous Installer Artifact:** No earlier StockStudio Pro NSIS `.exe` exists in the workspace for a true version-to-version upgrade test (Test B). Fresh Install (Test A) and Uninstall (Test C) have zero remaining blockers in Windows Sandbox.
