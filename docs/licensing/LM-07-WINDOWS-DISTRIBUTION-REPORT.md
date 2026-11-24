# PROJECT LM-07: Windows Distribution Preparation — Final Report

**Date:** 2026-11-23  
**Application:** StockStudio Pro License Manager (`apps/license-manager/`)  
**Identifier:** `com.stockstudiopro.licensemanager`  
**Version:** `0.1.0` (`x86_64`, Windows)  
**Artifact Classification:** **UNSIGNED / INTERNAL PREVIEW**  
**Final Distribution Readiness Assessment:** **READY WITH LIMITATIONS** *(Internal unsigned Windows preview installer built and verified; Authenticode code signing, live VM install/uninstall execution, and Production promotion remain gated)*

---

## 1. Configuration Changes

- **`apps/license-manager/src-tauri/tauri.conf.json`:**
  - Enabled Tauri v2 bundling (`bundle.active: true`, `bundle.targets: ["nsis"]`).
  - Added publisher metadata (`publisher: "StockStudio Pro"`, `shortDescription`).
  - Configured per-user NSIS installation (`bundle.windows.nsis.installMode: "currentUser"`, `compression: "lzma"`, `displayLanguageSelector: false`, `languages: ["English"]`) so zero Administrator / UAC privileges are required.
  - Configured Windows Authenticode placeholders (`certificateThumbprint: null`, `digestAlgorithm: "sha256"`, `timestampUrl: "http://timestamp.digicert.com"`).
- **`apps/license-manager/.gitignore` (new):** Ignores `node_modules/`, `dist/`, `dist-release/`, `src-tauri/target/`, `*.pfx`, `*.p12`, `*.enc.json` locally within `apps/license-manager/`.
- **`apps/license-manager/scripts/sign-windows-release.ps1` (new):** Environment-variable-driven (`$env:WINDOWS_CERT_THUMBPRINT`) SHA-256 + RFC 3161 Authenticode signing helper using Windows SDK `signtool.exe`.
- **`apps/license-manager/dist-release/` (generated, gitignored):** Staged unsigned preview artifacts, `build-manifest.json`, `SHA256SUMS.txt`, and `INSTALL-UPGRADE-UNINSTALL.md`.

---

## 2. Installer Type & Architecture

- **Installer Type:** Windows NSIS (`nsis-3.13`, LZMA compression, `installMode: "currentUser"`).
- **MSI Status:** Not enabled (NSIS per-user installer is cleanly supported and avoids unnecessary UAC elevation).
- **Architecture:** `x86_64` (verified via PE header `0x8664` on `stockstudio-pro-license-manager.exe` and `Target: x64` in NSIS build).
- **Privilege Requirement:** Standard non-admin user (`currentUser`).

---

## 3. Installer & Artifact Output Paths

- **Tauri Build Output:**
  - `apps/license-manager/src-tauri/target/release/bundle/nsis/StockStudio Pro License Manager_0.1.0_x64-setup.exe` (`3,171,665` bytes / `3.02 MiB`)
  - `apps/license-manager/src-tauri/target/release/stockstudio-pro-license-manager.exe` (`13,013,504` bytes / `12.41 MiB`)
- **Staged Internal Preview Release Directory (`apps/license-manager/dist-release/`):**
  - `StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED-PREVIEW.exe`
  - `stockstudio-pro-license-manager.UNSIGNED-PREVIEW.exe`
  - `build-manifest.json`
  - `SHA256SUMS.txt`
  - `INSTALL-UPGRADE-UNINSTALL.md`

---

## 4. Application Metadata

| Field | Verified Value |
|---|---|
| Product Name | `StockStudio Pro License Manager` |
| Application Identifier | `com.stockstudiopro.licensemanager` |
| Version | `0.1.0` |
| PE `ProductName` (exe & NSIS) | `StockStudio Pro License Manager` |
| PE `FileVersion` (exe & NSIS) | `0.1.0` |
| PE Architecture | `x86_64` (`0x8664`) |
| Icon Assets | `icons/32x32.png`, `icons/128x128.png`, `icons/128x128@2x.png`, `icons/icon.ico` |
| Secret / Customer Bundle Scan (`dist/`) | `0` matches for `ssadm_`, `SSPRO-6WQD`, `com.stockstudiopro.desktop` |

---

## 5. Credential & User-Data Persistence Review

- **Windows Credential Manager:** Isolated under service `StockStudioPro-LicenseManager-Admin` (`staging-admin-key`, `production-admin-key`). Stored in OS DPAPI-backed Windows Vault outside the NSIS install directory — preserved across fresh installs, upgrades, reinstalls, and uninstalls unless explicitly removed by the user via **Admin & Security → Forget Stored Key** or Windows Credential Manager.
- **Encrypted License Vault Exports (`.enc.json`):** Written to user-chosen paths outside the install directory — never touched by installer or uninstaller.
- **Owner License Vault:** Completely untouched and never read or decrypted.
- **Customer Desktop & Chrome Extension Isolation:** Installs to `%LOCALAPPDATA%\StockStudio Pro License Manager\` and WebView2 data under `%LOCALAPPDATA%\com.stockstudiopro.licensemanager\`, completely separate from `%LOCALAPPDATA%\StockStudio Pro\` and `%LOCALAPPDATA%\com.stockstudiopro.desktop\`.

---

## 6. Installation Safety Review

- **Configuration & Build-Level Safety:** **READY** (`currentUser` scope, isolated identifier/paths, starts locked, Staging default, `PRODUCTION_MUTATION_BLOCKED` enforced in Rust).
- **Live Interactive Installer Execution:** **UNVERIFIED** (no install or uninstall was executed against the user's active host workstation per Phase 4 safety policy; recommended to smoke-test the staged `UNSIGNED-PREVIEW.exe` inside a clean Windows Sandbox or VM before wider internal rollout).

---

## 7. Upgrade & Uninstall Behavior

- **Upgrade:** Preserves `com.stockstudiopro.licensemanager`, Windows Credential Manager entries (`StockStudioPro-LicenseManager-Admin`), and all `.enc.json` vault exports. *(Live upgrade execution: **UNVERIFIED** on host; documented in `INSTALL-UPGRADE-UNINSTALL.md`.)*
- **Uninstall:** Removes only installer-managed binaries and shortcuts in `%LOCALAPPDATA%\StockStudio Pro License Manager\`. Preserves Windows Credential Manager credentials, `.enc.json` exports, and all Customer Desktop / Chrome Extension data. Residual WebView2 runtime cache (`%LOCALAPPDATA%\com.stockstudiopro.licensemanager\`, containing zero secrets) is documented in `INSTALL-UPGRADE-UNINSTALL.md`. *(Live uninstall execution: **UNVERIFIED** on host.)*

---

## 8. Authenticode Signing Readiness

- **Current Binary Status:** **UNSIGNED / INTERNAL PREVIEW** (`Get-AuthenticodeSignature` confirmed `NotSigned` on both the NSIS installer and standalone `.exe`).
- **Environment Check:** `signtool.exe` not on PATH; `WINDOWS_CERT_THUMBPRINT` not set. No certificate was auto-generated, and existing Tauri updater signing keys were never touched or reused.
- **Prepared Workflow (`READY WITH LIMITATIONS`):** `apps/license-manager/scripts/sign-windows-release.ps1` accepts `$env:WINDOWS_CERT_THUMBPRINT`, locates Windows SDK `signtool.exe`, signs with SHA-256 + RFC 3161 timestamp (`http://timestamp.digicert.com`), and asserts `Get-AuthenticodeSignature == Valid`.

---

## 9. Dependency Audit Findings (LM06-05 Review)

- **Production Runtime Dependencies (`npm --prefix apps/license-manager audit --omit=dev`):** **`0` vulnerabilities** (`react`, `react-dom`, `lucide-react`, `@tauri-apps/api`).
- **Dev-Only Dependencies (`vitest@2.1.9` / `@vitest/mocker`):** Resolving the dev-only Vitest advisory requires a breaking major jump to `vitest@5.1.1` (incompatible with current Vite 5 / Node `v20.10.0` without a broad dependency overhaul). Per Phase 6 ("Avoid broad dependency upgrades; if an upgrade is not clearly safe, leave it unchanged and document the limitation"), `vitest` was left unchanged with lockfile consistency preserved.

---

## 10. Build & Test Results

| Check | Command | Result | Evidence |
|---|---|---|---|
| TypeScript | `npm --prefix apps/license-manager run typecheck` | **PASS** | `0` errors |
| Vitest | `npm --prefix apps/license-manager test` | **PASS** | `1/1` file, `13/13` tests passed |
| Vite Production Build | `npm --prefix apps/license-manager run build` | **PASS** | `dist/assets/index-CTypd22e.js` (`249.88 kB` / `68.33 kB` gzip) |
| Rust Unit Tests | `cargo test --manifest-path apps/license-manager/src-tauri/Cargo.toml` | **PASS** | `19/19` tests passed, `0` warnings |
| Rust Clippy | `cargo clippy --manifest-path apps/license-manager/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **PASS** | `0` errors, `0` warnings |
| Tauri NSIS Build | `npx tauri build` (in `apps/license-manager`) | **PASS** | Produced `StockStudio Pro License Manager_0.1.0_x64-setup.exe` (`3.02 MiB`, `0` warnings) |

---

## 11. SHA-256 Checksums (`apps/license-manager/dist-release/SHA256SUMS.txt`)

| Artifact | Size (Bytes) | Authenticode | SHA-256 |
|---|---:|---|---|
| `StockStudio-Pro-License-Manager_0.1.0_x64-setup.UNSIGNED-PREVIEW.exe` | `3,171,665` | `NotSigned` | `198d030357b1ad20963bc656251d7b4811d041bcdaced15e4b4f9e0d224fda27` |
| `stockstudio-pro-license-manager.UNSIGNED-PREVIEW.exe` | `13,013,504` | `NotSigned` | `2052a957a0a6697ba6ccecfc290fda0bc1eefe983e9dcb79043da2781bded51c` |

---

## 12. Remaining Limitations

1. **Unsigned Artifact:** No Windows Authenticode certificate is provisioned yet; installer is strictly labeled `UNSIGNED / INTERNAL PREVIEW`.
2. **Live Installer Lifecycle:** Fresh install, upgrade, and uninstall have not been interactively executed in a Windows Sandbox/VM yet (`UNVERIFIED`).
3. **Production Guard Active:** `PRODUCTION_MUTATION_BLOCKED` remains enforced in Rust for `issue_license`, `revoke_license`, and `force_deactivate_device`.
4. **Dev-Only Advisory:** `vitest@2.1.9` remains on v2 due to Node `v20.10.0` / Vite 5 compatibility (`0` runtime vulnerabilities).

---

## 13. Production Isolation Confirmation

- **Production Worker & Pages:** Untouched (not deployed).
- **Production D1 (`stockstudio-pro-licenses-prod`):** Zero migrations, zero writes.
- **Production Owner License (`lic_01M84E55AWK71ZT2RR6A7DYVA0`):** Untouched; no credentials retrieved or revealed.
- **`PRODUCTION_MUTATION_BLOCKED`:** Verified active in Rust (`blocks_production_lifecycle_mutations_in_lm05` passing).
- **Customer Desktop (`src/`, `src-tauri/`), Chrome Extension (`chrome-extension/`), and `.github/workflows/release.yml`:** Verified `0` modifications via `git status --short src src-tauri chrome-extension .github`.
- **Git & Releases:** Nothing committed, pushed, or published.

---

## 14. Final Distribution Readiness Assessment

| Area | Classification |
|---|---|
| Windows NSIS Per-User Packaging & Build | **READY** |
| Application Identity & Customer App Isolation | **READY** |
| Credential & Vault Preservation Architecture | **READY** |
| Authenticode Signing Workflow | **READY WITH LIMITATIONS** *(script & docs ready; certificate not yet provisioned)* |
| Live VM Install / Upgrade / Uninstall Verification | **UNVERIFIED** |
| Production Mutation Promotion | **NOT READY** *(intentionally blocked by `PRODUCTION_MUTATION_BLOCKED`)* |
| **Overall LM-07 Distribution Readiness** | **READY WITH LIMITATIONS** |
