# TASK G-G1D: Controlled Upgrade Simulation Report (`0.1.9` → `0.2.0`)

**Project:** StockStudio Pro Desktop (`0.2.0`) + `Vectorize.ai Download v1`  
**Pinned Chrome Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk`  
**Native Messaging Host:** `com.stockstudiopro.license`  
**Final Status:** **COMPLETE — ALL REQUIRED CHECKS PASSED**

---

## 1. Scope & Remediation Summary

1. **Silent Uninstall Default Fix (`src-tauri/installer-hooks.nsh`):**
   - Added `/SD IDNO` to the `MessageBox MB_YESNO|MB_ICONQUESTION` prompt in `NSIS_HOOK_PREUNINSTALL` (line 64).
   - Interactive uninstall retains the existing Yes/No user-data prompt; silent uninstall (`/S`) no longer blocks on a modal dialog and defaults to preserving `$LOCALAPPDATA\com.stockstudiopro.desktop`.
2. **Rebuilt `0.2.0` NSIS Installer (Static CRT Verified):**
   - Pre-build checks passed: `npm run typecheck`, `cargo test --workspace`, and `node scripts/test-e2e-unified-licensing.mjs` (`ALL_TASK_GF_E2E_CHECKS_PASSED`).
   - Static-CRT PE import check passed (`5` OS DLLs, `0` dynamic VC++ CRT DLLs): `bcryptprimitives.dll`, `kernel32.dll`, `advapi32.dll`, `api-ms-win-core-synch-l1-2-0.dll`, `ntdll.dll`.
   - **New `0.2.0` Installer:** `src-tauri/target/release/bundle/nsis/StockStudio Pro_0.2.0_x64-setup.exe`
     - **Size:** `3,873,295` bytes
     - **SHA-256:** `F64957EDBB10EF13DACE2072AFA85B5405B766FBA1E07E2BE394F4ADEB02E015`
   - **Isolated `0.1.9` Test Installer (Unchanged):** `C:\Users\ok\AppData\Local\Temp\sspro-upgrade-sim-0.1.9\src-tauri\target\release\bundle\nsis\StockStudio Pro_0.1.9_x64-setup.exe`
     - **Size:** `3,874,348` bytes
     - **SHA-256:** `2DC04E089469A6F0C20369322EAE73C7633A8297053D1951568527CEA6379DF0`
3. **NMH Sandbox Probe Harness Diagnostics & Fix:**
   - Earlier Sandbox `ExitCode=1` on `Test-Nmh` was diagnosed via captured `stderr`:
     `[stockstudio-nmh] inbound message exceeds limit (1623178223 bytes)`
   - `1623178223` = `0x60BFBBEF` (`EF BB BF 60` in little-endian) — proving `.NET Process.StandardInput` (`StreamWriter`) in Windows Sandbox prepended a 3-byte UTF-8 BOM (`EF BB BF`) before the `0x60 0x00 0x00 0x00` length header, and `stockstudio-nmh.exe` correctly failed closed on the oversized frame.
   - Switching `Test-Nmh` in `run-upgrade-sim.ps1` to raw binary file redirection (`[System.IO.File]::WriteAllBytes` + `< in.bin > out.bin 2> err.txt`) eliminated the BOM with zero changes to NMH application source code.

---

## 2. Final Verification Matrix (Windows Sandbox, Networking Enabled)

| # | Verification Check | Result | Evidence |
| --- | :--- | :---: | :--- |
| 1 | Staged `0.1.9` & `0.2.0` SHA-256 integrity | **PASS** | Both hashes matched expected values inside Sandbox preflight |
| 2 | WebView2 preflight & installation | **PASS** | `HKLM_pv=[]` → `HKLM_pv=[157.0.4341.60]` after `0.1.9` |
| 3 | Step 1: Fresh install `0.1.9` | **PASS** | `ExitCode: 0`, `DisplayVersion: 0.1.9`, `stockstudio-pro.exe` & `stockstudio-nmh.exe` (`796,160` bytes) present |
| 4 | Step 1: `0.1.9` manifest & `HKCU` registry | **PASS** | Valid JSON, path resolves (`True`), `allowed_origins` = `chrome-extension://ejcjoljemplfeenipjehlhhclbkpialk/`, `HKCU` value points to manifest |
| 5 | Step 1: `0.1.9` live NMH stdio probe | **PASS** | `ExitCode=0`, `ReqBytes=100` (`60-00-00-00`), `RespBytes=193` (`BD-00-00-00`), `FrameValid=True`, `ReqIdMatch=True`, `Authorized=False`, `ErrorCode=NOT_ACTIVATED`, `Stderr=[]` |
| 6 | Step 2: Direct upgrade `0.1.9` → `0.2.0` | **PASS** | `ExitCode: 0`, `DisplayVersion: 0.2.0`, `stockstudio-pro.exe` & upgraded `stockstudio-nmh.exe` (`796,672` bytes) present |
| 7 | Step 2: Post-upgrade manifest, Extension ID & `HKCU` registry | **PASS** | Valid JSON, path resolves (`True`), Extension ID unchanged, single `com.stockstudiopro.license` key, `com.example.unrelated` intact |
| 8 | Step 2: Synthetic `license-state.json` preserved across upgrade | **PASS** | `0.2.0 license-state.json preserved: True` |
| 9 | Step 2: `0.2.0` live NMH stdio probe | **PASS** | `ExitCode=0`, `ReqBytes=100` (`60-00-00-00`), `RespBytes=193` (`BD-00-00-00`), `FrameValid=True`, `ReqIdMatch=True`, `Authorized=False`, `ErrorCode=NOT_ACTIVATED`, `Stderr=[]` |
| 10 | Step 3: Silent uninstall (`uninstall.exe /S`) | **PASS** | `Uninstall ExitCode: 0` (completed cleanly with no interactive dialog hang) |
| 11 | Step 3: App executables & manifest removed | **PASS** | `stockstudio-pro.exe=False`, `stockstudio-nmh.exe=False`, `manifest=False` |
| 12 | Step 3: StockStudio Pro `HKCU` NMH key removed | **PASS** | `HKCU com.stockstudiopro.license exists: False` |
| 13 | Step 3: Unrelated `HKCU` NMH key preserved | **PASS** | `HKCU com.example.unrelated exists: True` |
| 14 | Step 3: User AppData preserved on silent uninstall (`/SD IDNO`) | **PASS** | `appDataDir exists: True`, `user data marker preserved: True` |

---

## 3. Complete Final `results.txt`

```text
=== WINDOWS SANDBOX CONTROLLED UPGRADE SIMULATION (0.1.9 -> 0.2.0) ===
Date: 2026-11-21T23:37:43.9322686+07:00
User: WDAGUtilityAccount

--- PREFLIGHT ---
Staged 0.1.9 SHA256: 2DC04E089469A6F0C20369322EAE73C7633A8297053D1951568527CEA6379DF0 (matches=True)
Staged 0.2.0 SHA256: F64957EDBB10EF13DACE2072AFA85B5405B766FBA1E07E2BE394F4ADEB02E015 (matches=True)
WebView2 preflight: HKLM_pv=[] HKCU_pv=[]

--- STEP 1: INSTALL 0.1.9 ---
0.1.9 Installer ExitCode: 0
WebView2 post-0.1.9: HKLM_pv=[157.0.4341.60] HKCU_pv=[]
0.1.9 DisplayVersion: 0.1.9
0.1.9 stockstudio-pro.exe exists: True
0.1.9 stockstudio-nmh.exe exists: True (size: 796160)
0.1.9 manifest exists: True
0.1.9 manifest JSON: {
  "name": "com.stockstudiopro.license",
  "description": "StockStudio Pro Unified License Verification Host",
  "path": "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\StockStudio Pro\\stockstudio-nmh.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://ejcjoljemplfeenipjehlhhclbkpialk/"
  ]
}

0.1.9 manifest path resolves: True
0.1.9 allowed_origins: chrome-extension://ejcjoljemplfeenipjehlhhclbkpialk/
0.1.9 HKCU NMH registry value: C:\Users\WDAGUtilityAccount\AppData\Local\StockStudio Pro\native-messaging\com.stockstudiopro.license.json
0.1.9 NMH Probe: ExitCode=0 ReqBytes=100 ReqHdr=60-00-00-00 RespBytes=193 RespHdr=BD-00-00-00 FrameValid=True ReqIdMatch=True Authorized=False ErrorCode=NOT_ACTIVATED Stderr=[]
0.1.9 NMH Probe JSON: {"request_id":"sandbox_019_req","authorized":false,"license_status":"not_activated","plan_name":null,"expires_at":null,"offline_grace_until":null,"products":[],"error_code":"NOT_ACTIVATED"}
Seeded synthetic license-state.json marker before upgrade.

--- STEP 2: UPGRADE TO 0.2.0 ---
0.2.0 Installer ExitCode: 0
WebView2 post-0.2.0: HKLM_pv=[157.0.4341.60] HKCU_pv=[]
0.2.0 DisplayVersion: 0.2.0
0.2.0 stockstudio-pro.exe exists: True
0.2.0 stockstudio-nmh.exe exists: True (size: 796672)
0.2.0 manifest exists: True
0.2.0 manifest JSON: {
  "name": "com.stockstudiopro.license",
  "description": "StockStudio Pro Unified License Verification Host",
  "path": "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\StockStudio Pro\\stockstudio-nmh.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://ejcjoljemplfeenipjehlhhclbkpialk/"
  ]
}

0.2.0 manifest path resolves: True
0.2.0 allowed_origins: chrome-extension://ejcjoljemplfeenipjehlhhclbkpialk/
0.2.0 HKCU NMH registry value: C:\Users\WDAGUtilityAccount\AppData\Local\StockStudio Pro\native-messaging\com.stockstudiopro.license.json
0.2.0 All HKCU NMH subkeys: com.example.unrelated, com.microsoft.browsercore, com.stockstudiopro.license
0.2.0 license-state.json preserved: True
0.2.0 NMH Probe: ExitCode=0 ReqBytes=100 ReqHdr=60-00-00-00 RespBytes=193 RespHdr=BD-00-00-00 FrameValid=True ReqIdMatch=True Authorized=False ErrorCode=NOT_ACTIVATED Stderr=[]
0.2.0 NMH Probe JSON: {"request_id":"sandbox_020_req","authorized":false,"license_status":"not_activated","plan_name":null,"expires_at":null,"offline_grace_until":null,"products":[],"error_code":"NOT_ACTIVATED"}

--- STEP 3: UNINSTALL 0.2.0 ---
Before Uninstall appDataDir exists: True
Uninstall ExitCode: 0
After Uninstall HKCU com.stockstudiopro.license exists: False
After Uninstall HKCU com.example.unrelated exists: True
After Uninstall manifest exists: False
After Uninstall stockstudio-nmh.exe exists: False
After Uninstall stockstudio-pro.exe exists: False
After Uninstall appDataDir exists: True
After Uninstall user data marker preserved: True
=== SIMULATION_COMPLETE ===
```

---

## 4. Constraints & Integrity Confirmation

- **Version preserved at `0.2.0`:** Confirmed in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
- **Source changes limited strictly to:** `src-tauri/installer-hooks.nsh` (1-line `/SD IDNO` addition) and this report. Zero NMH source changes; zero production config/credential changes.
- **No Git commit, push, or deployment occurred** (`HEAD` remains `f398e57`).
- **Historical evidence preserved:** Prior Sandbox logs archived in `C:\Users\ok\AppData\Local\Temp\sspro-sandbox-upgrade-test\` (`results-pre-fix.txt`, `results-bom-diag.txt`, and final `results.txt`).
