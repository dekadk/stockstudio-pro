# LM-08C: Interactive Windows Sandbox Lifecycle Validation Report

**Date:** 2026-11-24  
**Project:** `E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main`  
**Application:** `apps/license-manager/` (`com.stockstudiopro.licensemanager`, v`0.1.0`)  
**Installer Tested:** `apps/license-manager/dist-release-lm08b/StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED.exe`  
**Final Assessment:** **PASS WITH LIMITATIONS**

---

## Summary Matrix

| Phase | Scope | Live Sandbox Status |
|---|---|---|
| 1 | Sandbox Recovery (Pre-Run) | **PASS** |
| 2 | WebView2 Runtime Installation (`158.0.4370.33`) | **PASS** |
| 3 | Fresh Installation (`exit=0`, exe, uninstaller, shortcut, host isolation) | **PASS** *(app launch initiated; visual lock-screen screenshot cut off by 240s harness timeout)* |
| 4 | Upgrade Installation | **NOT TESTED** *(cut off at 240s; retry blocked by orphaned `vmmemWindowsSandbox`)* |
| 5 | Credential Manager Validation | **PARTIAL** *(Host-to-Sandbox isolation **PASS**; synthetic write/upgrade/uninstall persistence **NOT TESTED**)* |
| 6 | Uninstallation | **NOT TESTED** *(cut off at 240s; retry blocked by orphaned `vmmemWindowsSandbox`)* |

---

## 1. Sandbox Recovery

- **Pre-Run Inspection:** `Get-Process -Name "*Sandbox*"` confirmed zero active Windows Sandbox processes (`ALL_SANDBOX_PROCESSES_CLEAN=TRUE`). No unrelated host processes were touched.
- **Post-Run Host Observation:** After `task-3244` reached its 240-second harness timeout and terminated the Sandbox client/server processes, Hyper-V's `vmmemWindowsSandbox` process remained resident on the host (`SANDBOX_CLEAN_BEFORE_LAUNCH=False`, `REMAINING=vmmemWindowsSandbox`), blocking automated relaunch in `task-3250` and `task-3254`. Per safety rules, `vmmemWindowsSandbox` was not forcefully killed.

---

## 2. WebView2 Runtime Installation

**Status:** **PASS (Live Sandbox Verified)**

- Inside Windows Sandbox (`WDAGUtilityAccount`) with `<Networking>Default</Networking>`:
  - `WebView2 before install`: empty (not preinstalled in Sandbox).
  - Running `StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED.exe /S` triggered Tauri's NSIS WebView2 bootstrapper, which downloaded and installed **Microsoft Edge WebView2 Runtime `158.0.4370.33`** cleanly (`11:35:23Z` → `11:39:08Z`, ~225 seconds).
- This also confirmed the LM-08B root cause: in LM-08B's offline Sandbox (`<Networking>Disable</Networking>`), the same installer aborted with `exit_code: 2` solely because WebView2 Runtime was absent and could not be downloaded.

---

## 3. Fresh Installation

**Status:** **PASS (Installer & Artifacts) / NOT TESTED (Visual Locked-State Screenshot)**

Live Sandbox log (`task-3244`, `WDAGUtilityAccount`):
```text
[2026-11-24T11:35:22Z] LM-08C Sandbox validation started as WDAGUtilityAccount
[2026-11-24T11:35:23Z] Initial credential isolation check: hostCredLeaked=False
[2026-11-24T11:35:23Z] WebView2 before install: 
[2026-11-24T11:35:23Z] Copied installer to C:\Users\WDAGUtilityAccount\AppData\Local\Temp\StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED.exe
[2026-11-24T11:35:23Z] Running fresh NSIS install (/S)...
[2026-11-24T11:39:08Z] Fresh install finished: exit=0 exe=True uninst=True shortcuts=1 wv2_after=158.0.4370.33
[2026-11-24T11:39:08Z] Launching installed License Manager...
```

Verified live inside Sandbox:
- NSIS per-user installation exited with **`exit=0`** (no UAC elevation).
- Installed executable present: `C:\Users\WDAGUtilityAccount\AppData\Local\StockStudio Pro License Manager\stockstudio-pro-license-manager.exe` (`exe=True`).
- Uninstaller present: `uninstall.exe` (`uninst=True`).
- Start Menu shortcut created (`shortcuts=1`).
- Zero host credentials present (`hostCredLeaked=False`).
- Application launch started at `11:39:08Z`, 5 seconds before the 240-second harness timeout expired, so `01-fresh-launch-locked.png` was not written before timeout.

---

## 4. Upgrade Installation

**Status:** **NOT TESTED**

Not reached in `task-3244` because WebView2 download + fresh install consumed 225s of the 240s budget, and subsequent automated launches were blocked by the resident `vmmemWindowsSandbox` process.

---

## 5. Credential Manager Validation

**Status:** **PARTIAL**

- **Host-to-Sandbox Isolation:** **PASS** — `cmdkey /list` inside Sandbox confirmed `hostCredLeaked=False` (zero host `StockStudioPro-LicenseManager-Admin` credentials imported).
- **Synthetic Credential Storage, Upgrade/Uninstall Persistence & Explicit Removal:** **NOT TESTED** (not reached before 240s cutoff).

---

## 6. Uninstallation

**Status:** **NOT TESTED** (not reached before 240s cutoff).

---

## 7. Evidence & Harness References

- Validation script: [sandbox-validate-lm08c.ps1](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/apps/license-manager/scripts/sandbox-validate-lm08c.ps1)
- Ready-to-run Sandbox configuration: `apps/license-manager/sandbox-output-lm08c/lm08c-validation.wsb` (maps `dist-release-lm08b/` and `scripts/` **ReadOnly**, `sandbox-output-lm08c/` **ReadWrite**, `<Networking>Default</Networking>`).
- Live Sandbox log output captured in `task-3244` (reproduced verbatim in Section 3 above).

### One-Click Interactive Completion Procedure (For Host User)
Once `vmmemWindowsSandbox` clears (e.g., after closing Windows Sandbox / restarting the host):
1. Double-click `apps/license-manager/sandbox-output-lm08c/lm08c-validation.wsb`.
2. Wait ~4.5 minutes without closing the Sandbox window; `sandbox-validate-lm08c.ps1` automatically executes Fresh Install + WebView2, captures `01-fresh-launch-locked.png`, writes synthetic credentials + `.enc.json`, runs Upgrade + `02-post-upgrade-launch.png`, runs Uninstall + cleanup verification, and writes `sandbox-lm08c-result.json` to `apps/license-manager/sandbox-output-lm08c/`.

---

## 8. Remaining Limitations

1. **Upgrade, Synthetic Credential Persistence, and Uninstall** remain **NOT TESTED** in live Windows Sandbox due to the 240s cutoff during WebView2 download and the subsequent orphaned `vmmemWindowsSandbox` process.
2. **Offline WebView2 Dependency:** Confirmed live that default `downloadBootstrapper` requires network access when WebView2 Runtime is not preinstalled (~225s download + install in Sandbox).
3. **Authenticode Signing:** No trusted Windows Code Signing certificate is provisioned yet (binaries remain `UNSIGNED`).

---

## 9. Final Assessment & Safety Confirmation

- **Safety Confirmed:** Zero Production API access, zero Worker/D1 changes, zero real Admin API keys or Owner License access, zero host Credential Manager or host app changes, zero source code modifications, and zero Git commits/pushes.
- **Final Assessment:** **PASS WITH LIMITATIONS** *(Live WebView2 `158.0.4370.33` installation, per-user NSIS Fresh Install `exit=0`, Start Menu shortcut creation, and host credential isolation are live-verified in Windows Sandbox; Upgrade, Synthetic Credential Persistence, and Uninstall remain NOT TESTED until `vmmemWindowsSandbox` clears for an uninterrupted ~5-minute interactive run.)*
