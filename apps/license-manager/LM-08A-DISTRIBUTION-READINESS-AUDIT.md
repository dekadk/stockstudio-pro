# LM-08A: Distribution Readiness Audit — StockStudio Pro License Manager

**Date:** 2026-11-24  
**Auditor Role:** Windows Desktop Release Engineer & Security Auditor  
**Project:** `E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main`  
**Application:** `apps/license-manager/` (`com.stockstudiopro.licensemanager`, v`0.1.0`)  
**Audit Mode:** Strictly Read-Only (zero source, configuration, credential, or system modifications)

---

## 1. Executive Summary

A read-only audit of the LM-07 distribution artifacts, Windows certificate stores, signing tooling, Windows Sandbox availability, release configuration, and security controls was completed.

- **Artifacts & Integrity:** All 5 files in `apps/license-manager/dist-release/` are intact and match their recorded SHA-256 checksums (`SHA256SUMS.txt` and `build-manifest.json`). Both executables are `x86_64`, carry accurate PE `ProductName`/`FileVersion` metadata, and are honestly labeled `UNSIGNED / INTERNAL PREVIEW` (`NotSigned`).
- **Signing Readiness:** Windows SDK `signtool.exe` **is installed** (`10.0.26100.0\x64\signtool.exe`), and `sign-windows-release.ps1` parses cleanly under Windows PowerShell 5.1 (`0` AST errors). However, **zero** Code Signing certificates exist in `Cert:\CurrentUser\My` or `Cert:\LocalMachine\My`, and a minor fallback-property defect (`$signtool.Source` vs `.FullName` under `Set-StrictMode`) was identified in `sign-windows-release.ps1` for remediation in LM-08B.
- **Installation Validation Readiness:** `C:\WINDOWS\system32\WindowsSandbox.exe` **is available** on this workstation, enabling fully isolated Fresh Install, Upgrade, Credential Manager persistence, and Uninstall validation in LM-08B without touching the host system.
- **Security Controls:** All 10 LM-01–LM-07 security protections — including `PRODUCTION_MUTATION_BLOCKED` on `issue_license`, `revoke_license`, and `force_deactivate_device` — remain verified and intact.

---

## 2. Existing Artifact Inventory (`apps/license-manager/dist-release/`)

Verified read-only on 2026-11-24 against `build-manifest.json` and `SHA256SUMS.txt`:

| Artifact | Size (Bytes) | Arch | Authenticode | Live SHA-256 | Manifest / Checksum Match |
|---|---:|---|---|---|---|
| `StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED-PREVIEW.exe` | `3,171,665` (`3.02 MiB`) | `x86_64` | `NotSigned` | `198d030357b1ad20963bc656251d7b4811d041bcdaced15e4b4f9e0d224fda27` | **EXACT MATCH** |
| `stockstudio-pro-license-manager.UNSIGNED-PREVIEW.exe` | `13,013,504` (`12.41 MiB`) | `x86_64` | `NotSigned` | `2052a957a0a6697ba6ccecfc290fda0bc1eefe983e9dcb79043da2781bded51c` | **EXACT MATCH** |
| `build-manifest.json` | `1,454` | N/A | N/A | `82ae9713d3aa723a9e8056ef79b3c67c88dd3b4ebc7e935fa8a10b7bae624d8d` | Present & valid JSON |
| `SHA256SUMS.txt` | `259` | N/A | N/A | `f5635723cf8b117291f963d337bf375115a8610d5053d6ec3dcc35d2638824f7` | Present & valid |
| `INSTALL-UPGRADE-UNINSTALL.md` | `3,342` | N/A | N/A | `32c449f85286ad5c4d50095754140a16e3a2ceb7792d5576a6e1b1a5ab1dbb6b` | Present |

---

## 3. Authenticode Certificate Readiness

| Check | Verified Result |
|---|---|
| `Cert:\CurrentUser\My` (EKU `1.3.6.1.5.5.7.3.3` Code Signing) | **`0` certificates** |
| `Cert:\LocalMachine\My` (EKU `1.3.6.1.5.5.7.3.3` Code Signing) | **`0` certificates** |
| `signtool.exe` on `PATH` | `NONE` |
| `signtool.exe` in Windows SDK | **PRESENT:** `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe` |
| `apps/license-manager/scripts/sign-windows-release.ps1` PS 5.1 AST check | `0` syntax errors *(see Defect `LM08A-01` below)* |

**Verified Conclusion:** Authenticode signing **cannot** be completed with any existing certificate on this machine. Production/controlled distribution signing requires provisioning a commercially trusted Windows Authenticode Code Signing certificate (e.g., OV/EV hardware-token/HSM certificate or Azure Trusted Signing) or explicitly keeping internal-only distribution labeled `UNSIGNED / INTERNAL PREVIEW`.

---

## 4. Windows Installation Validation Plan (For LM-08B)

**Verified Capability:** `C:\WINDOWS\system32\WindowsSandbox.exe` is available on this host. All live installation testing in LM-08B should execute inside an ephemeral Windows Sandbox (`.wsb` mapping `apps/license-manager/dist-release/` as **ReadOnly**), guaranteeing zero impact on the host OS, host Credential Manager, or Customer Desktop.

| Scenario | Validation Steps Inside Isolated Windows Sandbox | Pass Criteria |
|---|---|---|
| **1. Fresh Install (Per-User)** | Run `StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED-PREVIEW.exe` without admin elevation. | Installs to `%LOCALAPPDATA%\StockStudio Pro License Manager\`; zero UAC prompt; Start Menu/Desktop shortcuts created; launches cleanly into **Locked** state defaulting to **STAGING**. |
| **2. Credential & Data Persistence** | Store a synthetic test credential via `unlock_with_key` (or verify `StockStudioPro-LicenseManager-Admin` service slot) and create a synthetic `.enc.json` file in a user folder. | Credential persists across app restart; WebView2 folder `%LOCALAPPDATA%\com.stockstudiopro.licensemanager\` contains zero plaintext keys. |
| **3. Upgrade Install** | Re-run installer (or upgraded version `0.1.1-sandbox`) over the existing installation while app is closed. | Preserves `com.stockstudiopro.licensemanager`, Windows Credential Manager entry, and user `.enc.json` files; launches cleanly. |
| **4. Uninstallation** | Uninstall via Windows Settings / NSIS uninstaller (`uninstall.exe`). | Removes `%LOCALAPPDATA%\StockStudio Pro License Manager\` binaries and shortcuts; preserves Windows Credential Manager entry and user `.enc.json` exports; does not touch unrelated paths. |

---

## 5. Security Regression Results (Read-Only Verification)

| Control | Verification Method | Status |
|---|---|---|
| Starts locked & defaults to Staging | Verified in `security.rs` (`active_key: None`, `#[default] Staging`) | **INTACT** |
| Isolated Credential Manager service | `KEYRING_SERVICE_NAME = "StockStudioPro-LicenseManager-Admin"` | **INTACT** |
| Zero WebView storage (`localStorage`/`sessionStorage`) | Verified in LM-06/LM-07 static scan & Vitest | **INTACT** |
| `Zeroizing<String>` RAM key handling | Verified in `security.rs`, `commands.rs`, `api.rs` | **INTACT** |
| 15-min idle auto-lock & env-switch lock | `DEFAULT_IDLE_TIMEOUT_SECS = 900`, `set_environment` locks | **INTACT** |
| `PRODUCTION_MUTATION_BLOCKED` guard | Verified active at `commands.rs:442` (`issue_license`), `commands.rs:680` (`revoke_license`), `commands.rs:785` (`force_deactivate_device`) | **INTACT** |
| Private keys / vault files inside `apps/license-manager/` | Recursive scan (`*.pfx,*.p12,*.key,*.pem,*.enc.json`): **`0` files** | **INTACT** |
| Secrets / customer Desktop references in `dist/` | Verified `0` matches in LM-07 | **INTACT** |

---

## 6. Release Configuration Review

- **Tauri v2 Config (`apps/license-manager/src-tauri/tauri.conf.json`):** `productName: "StockStudio Pro License Manager"`, `identifier: "com.stockstudiopro.licensemanager"`, `version: "0.1.0"`, `bundle.active: true`, `targets: ["nsis"]`, `installMode: "currentUser"`, `compression: "lzma"`, `digestAlgorithm: "sha256"`, `timestampUrl: "http://timestamp.digicert.com"`.
- **Capabilities (`capabilities/default.json`):** Minimal `core:default` only; strict CSP blocking direct renderer external HTTP calls.
- **Checksums & Manifest:** `SHA256SUMS.txt` and `build-manifest.json` are consistent and accurately mark `authenticode_signed: false` and `classification: "UNSIGNED_INTERNAL_PREVIEW"`.

---

## 7. Blockers and Risks

| ID | Severity | Finding | Fact vs Recommendation |
|---|---|---|---|
| **LM08A-01** | **MEDIUM** | In `apps/license-manager/scripts/sign-windows-release.ps1` (lines 45–55), when `signtool.exe` is not on `PATH` and falls back to `Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe"`, `$signtool` is a `FileInfo` object (`.FullName`), NOT a `CommandInfo` object (`.Source`). Under `Set-StrictMode -Version Latest`, `& $signtool.Source` will throw a property-not-found error. | **Verified Fact.** Fix in LM-08B by storing a `[string]$signtoolPath` from either `.Source` or `.FullName`. |
| **LM08A-02** | **HIGH (for external/SmartScreen-free rollout)** | Zero Code Signing certificates (`1.3.6.1.5.5.7.3.3`) exist in `CurrentUser\My` or `LocalMachine\My`. Unsigned installers trigger Windows SmartScreen warnings. | **Verified Fact.** Requires provisioning a commercially trusted code-signing certificate (or accepting `UNSIGNED / INTERNAL PREVIEW` for private owner-only use). |
| **LM08A-03** | **MEDIUM** | Live Fresh Install / Upgrade / Uninstall lifecycle has not yet been executed in an isolated Windows Sandbox. | **Verified Fact.** Ready to execute in LM-08B using `WindowsSandbox.exe`. |
| **LM08A-04** | **LOW** | `INSTALL-UPGRADE-UNINSTALL.md` references filename `StockStudio Pro License Manager_0.1.0_x64-setup.exe` in example commands, while the staged filename in `dist-release/` is `StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED-PREVIEW.exe`. | **Verified Fact.** Align example filename in LM-08B. |

---

## 8. Recommended LM-08B Implementation Plan

1. **Fix `sign-windows-release.ps1` (`LM08A-01`)** so `$signtoolPath` resolves cleanly from both `Get-Command` (`.Source`) and Windows Kits `Get-ChildItem` (`.FullName`), and align the example filename in `INSTALL-UPGRADE-UNINSTALL.md` (`LM08A-04`).
2. **Execute Isolated Windows Sandbox Installation Validation (`LM08A-03`)** using a read-only `.wsb` profile mapping `apps/license-manager/dist-release/`:
   - Validate Fresh Install (`currentUser`, no UAC, Start Menu shortcut, Locked + Staging default).
   - Validate Credential Manager persistence & `.enc.json` vault preservation across Upgrade/Reinstall.
   - Validate Uninstall removes binaries/shortcuts while preserving Credential Manager & `.enc.json` exports.
3. **Authenticode Signing Gate (`LM08A-02`):**
   - If the owner provisions a commercially trusted Windows Code Signing certificate, sign both `.exe` artifacts via `sign-windows-release.ps1`, regenerate `SHA256SUMS.txt` and `build-manifest.json` (`authenticode_signed: true`), and verify `Get-AuthenticodeSignature == Valid`.
   - If no certificate is provisioned yet, keep artifacts explicitly labeled `UNSIGNED / INTERNAL PREVIEW` for private owner-workstation use only.

---

## 9. Read-Only Safety Confirmation

Confirmed: During LM-08A, **no source code, Tauri configuration, Worker code, D1 database, Production credentials, Windows Credential Manager entries, release binaries, installed applications, or Git state were modified**. Only this audit report (`apps/license-manager/LM-08A-DISTRIBUTION-READINESS-AUDIT.md`) was created.

---

## Final Assessment

**READY WITH LIMITATIONS**
