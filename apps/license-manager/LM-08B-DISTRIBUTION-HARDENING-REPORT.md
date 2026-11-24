# LM-08B: Distribution Hardening & Windows Sandbox Validation Report

**Date:** 2026-11-24  
**Project:** `E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main`  
**Application:** `apps/license-manager/` (`com.stockstudiopro.licensemanager`, v`0.1.0`)  
**Final Assessment:** **PASS WITH LIMITATIONS**

---

## 1. Executive Summary

- **LM08A-01 Fixed & Verified:** `apps/license-manager/scripts/sign-windows-release.ps1` was refactored with `Resolve-SignToolPath` to normalize `signtool.exe` into `[string]` from either `PATH` (`CommandInfo.Source`) or Windows SDK fallback (`FileInfo.FullName`), removing the `Set-StrictMode` `.Source`-on-`FileInfo` bug. All **`6/6`** Windows PowerShell 5.1 StrictMode tests in `scripts/test-sign-windows-release.ps1` passed.
- **Full Regression & Build Suite Passed:** TypeScript (`0` errors), Vitest (`13/13`), Vite build, Rust `cargo test` (`19/19`), `cargo clippy --all-targets --all-features -- -D warnings` (`0` warnings), and Tauri v2 NSIS release build (`3.02 MiB`) all passed.
- **LM-07 Baseline Preserved & LM-08B Artifacts Staged:** LM-07 baseline artifacts in `apps/license-manager/dist-release/` were verified untouched (`LM07_BASELINE_INTACT=True`). New LM-08B `UNSIGNED` artifacts, `SHA256SUMS.txt`, and `build-manifest.json` were staged in `apps/license-manager/dist-release-lm08b/`.
- **Windows Sandbox Live Validation Finding (Honest Limitation):** Live Windows Sandbox (`WDAGUtilityAccount`) executed `scripts/sandbox-validate.ps1` on the first run (`task-3192`), revealing that silent NSIS installation (`/S`) exited with **`exit_code: 2`** in an air-gapped Sandbox (`<Networking>Disable</Networking>`) because Tauri v2's default `webviewInstallMode` (`downloadBootstrapper`) requires network access if WebView2 Runtime is absent. Subsequent automated launches timed out while `vmmemWindowsSandbox` / `WindowsSandboxServer` remained resident on the host. Full Fresh Install → Startup → Upgrade → Credential Persistence → Uninstall therefore remains **UNVERIFIED / REQUIRES INTERACTIVE SANDBOX RUN** (using the prepared `lm08b-validation.wsb` once Sandbox is closed cleanly).

---

## 2. Signing Script Fix (`LM08A-01`)

Updated [sign-windows-release.ps1](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/apps/license-manager/scripts/sign-windows-release.ps1):
- Added `Resolve-SignToolPath` returning `[string]`:
  1. Explicit `-SignToolPath` (validated with `Test-Path -PathType Leaf`).
  2. `Get-Command signtool.exe -CommandType Application` → `[string]$cmd.Source`.
  3. Windows Kits fallback `C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe` → `[string]$kitCandidates[0].FullName` (never `.Source` on `FileInfo`).
- Added strict input validation for target binary existence, 40-char hex SHA-1 `$env:WINDOWS_CERT_THUMBPRINT`, `http(s)://` RFC 3161 timestamp URL, and `-DryRun` mode (with redacted thumbprint output).
- Preserved `Set-StrictMode -Version Latest`, PowerShell 5.1 compatibility, SHA-256 (`/fd sha256 /td sha256`), and RFC 3161 timestamping (`/tr`). No actual Authenticode signing was performed.

---

## 3. Signing Script Test Results (`scripts/test-sign-windows-release.ps1`)

Executed under Windows PowerShell 5.1 (`powershell.exe -NoProfile -NonInteractive`): **`6/6 PASS`**

| # | Scenario | Result |
|---:|---|---|
| 1 | SignTool found through `PATH` (`-DryRun`, thumbprint redacted) | **PASS** |
| 2 | SignTool found via Windows SDK `FileInfo` fallback (`10.0.26100.0\x64\signtool.exe`) & explicit `-SignToolPath` | **PASS** |
| 3 | Missing SignTool produces clear error (`SignToolPath not found`) | **PASS** |
| 4 | Missing `$env:WINDOWS_CERT_THUMBPRINT` produces clear error | **PASS** |
| 5 | Missing target binary produces clear error (`Target binary not found`) | **PASS** |
| 6 | PowerShell 5.1 AST & `Set-StrictMode -Version Latest` compatibility (`0` AST errors) | **PASS** |

---

## 4. Windows Sandbox Fresh Install Results (Live Sandbox vs Static)

- **Live Sandbox Run (`task-3192`, `WDAGUtilityAccount`, `<Networking>Disable</Networking>`):**
  - `sandbox-validate.ps1` executed inside Windows Sandbox and wrote `sandbox-validation-result.json`.
  - **Observed Result:** `fresh_install.exit_code = 2`, `exe_exists = false`, `uninstaller_exists = false`, `shortcut_count = 0`.
  - **Root Cause Identified:** Tauri v2's default NSIS `webviewInstallMode` (`downloadBootstrapper`) aborts silently (`exit_code: 2`) when WebView2 Runtime is not preinstalled and networking is disabled.
- **Subsequent Automated Retries (`task-3203`, `task-3210`, `task-3222`):** Timed out (`SANDBOX_RESULT_CAPTURED=FALSE`) because `vmmemWindowsSandbox` / `WindowsSandboxServer` remained resident in the background on this host after the first run.
- **Status:** **NOT COMPLETED IN LIVE SANDBOX** (interactive run of `apps/license-manager/sandbox-output/lm08b-validation.wsb` with `<Networking>Default</Networking>` after Sandbox host teardown — or configuring `webviewInstallMode: "offlineInstaller"` in LM-08C — is required to complete live verification).

---

## 5. Upgrade Validation Results

- **Live Sandbox Execution:** **UNVERIFIED** (blocked downstream of Step 4 above).
- **Static / Configuration Verification:** Verified `identifier: "com.stockstudiopro.licensemanager"`, `installMode: "currentUser"`, and NSIS upgrade target path `%LOCALAPPDATA%\StockStudio Pro License Manager\`.

---

## 6. Credential Persistence Results

- **Live Sandbox Execution:** **UNVERIFIED** (blocked downstream of Step 4 above).
- **Automated Unit / Architecture Verification:** Rust tests (`keyring_service_is_isolated_from_customer_app`, `locks_and_zeroizes_session_on_401_unauthorized`, `switching_environment_locks_active_session`) confirm isolated service `StockStudioPro-LicenseManager-Admin` (`staging-admin-key` / `production-admin-key`) stored in OS DPAPI Vault outside the NSIS install directory.

---

## 7. Uninstall Validation Results

- **Live Sandbox Execution:** **UNVERIFIED** (blocked downstream of Step 4 above).
- **Static Verification:** Per-user NSIS uninstaller removes `%LOCALAPPDATA%\StockStudio Pro License Manager\` and shortcuts without touching Windows Credential Manager or user-exported `.enc.json` files.

---

## 8. Security Regression Results

| Check | Command / Verification | Result |
|---|---|---|
| TypeScript | `npm --prefix apps/license-manager run typecheck` | **PASS (`0` errors)** |
| Frontend Vitest | `npm --prefix apps/license-manager test` | **PASS (`13/13` tests)** |
| Vite Build | `npm --prefix apps/license-manager run build` | **PASS (`249.88 kB` JS)** |
| Rust Tests | `cargo test --manifest-path apps/license-manager/src-tauri/Cargo.toml` | **PASS (`19/19` tests, `0` warnings)** |
| Rust Clippy | `cargo clippy --manifest-path apps/license-manager/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **PASS (`0` errors, `0` warnings)** |
| Tauri NSIS Build | `npx tauri build` (in `apps/license-manager`) | **PASS (`3.02 MiB` NSIS, `0` warnings)** |
| Signing Helper Tests | `test-sign-windows-release.ps1` (PS 5.1 StrictMode) | **PASS (`6/6` tests)** |
| `PRODUCTION_MUTATION_BLOCKED` | Verified active on `issue_license`, `revoke_license`, `force_deactivate_device` | **INTACT** |
| Starts locked / Staging default / Zero WebView storage | Verified in Rust & Vitest regression suites | **INTACT** |

---

## 9. New Artifact Inventory & SHA-256 (`apps/license-manager/dist-release-lm08b/`)

- **LM-07 Baseline (`apps/license-manager/dist-release/`):** Verified 100% untouched (`LM07_BASELINE_INTACT=True`, SHA-256 `198d030357b1ad20963bc656251d7b4811d041bcdaced15e4b4f9e0d224fda27`).
- **New LM-08B Artifacts (`apps/license-manager/dist-release-lm08b/`, gitignored):**

| Artifact | Size (Bytes) | Authenticode | SHA-256 |
|---|---:|---|---|
| `StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED.exe` | `3,170,923` | `NotSigned` (`UNSIGNED`) | `8bbef84f2dc216386edb5248a035793000d020c455ac4e0c784bf2b1127a0e43` |
| `stockstudio-pro-license-manager.UNSIGNED.exe` | `13,013,504` | `NotSigned` (`UNSIGNED`) | `3b1896f9a62ca294b92edca3d5cfc51cfef51586f7815be0c48ac3413ff1305b` |
| `SHA256SUMS.txt` | — | N/A | Generated |
| `build-manifest.json` | — | N/A | Generated (`milestone: "LM-08B"`, `authenticode_signed: false`) |

---

## 10. Remaining Authenticode Certificate Blocker

Zero Code Signing certificates (`1.3.6.1.5.5.7.3.3`) exist in `Cert:\CurrentUser\My` or `Cert:\LocalMachine\My`. Until a commercially trusted Authenticode Code Signing certificate is provisioned, release binaries must remain labeled **UNSIGNED** and restricted to internal preview use.

---

## 11. Recommended LM-08C Plan

1. **Resolve Offline WebView2 NSIS Behavior (Optional/Recommended):** Evaluate setting `bundle.windows.webviewInstallMode: { "type": "embedBootstrapper" }` or `"offlineInstaller"` if offline installation on machines without WebView2 Runtime is required, OR run `lm08b-validation.wsb` interactively in a freshly rebooted Windows Sandbox with `<Networking>Default</Networking>` to capture complete Fresh Install → Startup → Upgrade → Credential Persistence → Uninstall JSON proof.
2. **Authenticode Signing (Once Certificate Provisioned):** Set `$env:WINDOWS_CERT_THUMBPRINT`, sign both binaries with `scripts/sign-windows-release.ps1`, regenerate `SHA256SUMS.txt` and `build-manifest.json` (`authenticode_signed: true`), and confirm `Get-AuthenticodeSignature == Valid`.

---

## 12. Safety Boundary Confirmation

Confirmed:
- No Worker deployment or D1 modification performed.
- No Production credentials accessed; `PRODUCTION_MUTATION_BLOCKED` remains active on all 3 mutation commands.
- Owner License untouched.
- Customer Desktop (`src/`, `src-tauri/`), Chrome Extension (`chrome-extension/`), and `.github/workflows/release.yml` verified `0` changes via `git status --short`.
- Real host installation and host Windows Credential Manager entries were not modified.
- Nothing committed or pushed to Git; no secrets included in logs or reports.

---

## Final Assessment

**PASS WITH LIMITATIONS**
