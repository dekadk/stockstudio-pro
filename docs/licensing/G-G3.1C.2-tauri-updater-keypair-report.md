# TASK G-G3.1C.2: Tauri Updater Keypair Generation & Security Report

**Project:** StockStudio Pro (`0.2.0`)  
**Target Repository:** `dekadk/stockstudio-pro` (`PUBLIC`)  
**Final Verdict:** **`KEYPAIR_GENERATED_BACKUP_PENDING`**

---

## A. Executive Summary

A fresh StockStudio Pro Tauri Updater minisign keypair (`161D6624BEE2416D`) was generated interactively by the user outside the repository using `tauri-cli 2.11.4`. Restrictive Windows NTFS ACLs (inheritance disabled; access limited to current user, `SYSTEM`, and `Administrators`) have been applied and verified via `icacls`. Public key format compatibility with `plugins.updater.pubkey` is confirmed. Offline backup remains **`OFFLINE_BACKUP_PENDING`** and must be completed before production release signing or broad distribution.

---

## B. Key Generation

- **Generation Status:** **SUCCESS** (generated interactively by user in local PowerShell; passphrase entered via hidden prompt, never passed as CLI arg, env var, script, or chat).
- **Tauri CLI Version:** `tauri-cli 2.11.4` (`npx tauri signer generate -w`)
- **Private-Key Path:** `%USERPROFILE%\.tauri\stockstudio-pro-updater.key` (`348` bytes, outside repository; contents never read or printed)
- **Public-Key Path:** `%USERPROFILE%\.tauri\stockstudio-pro-updater.key.pub` (`152` bytes, outside repository)
- **Public-Key Value (Base64 minisign — directly compatible with `plugins.updater.pubkey`):**
  ```text
  dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE2MUQ2NjI0QkVFMjQxNkQKUldSdFFlSytKR1lkRmtXU2N0dGdTbFZBdytPMW8yaGZZeXJIZzN5N3FJT1JUR2RDUm9IMkxhQ0gK
  ```
- **Minisign Public Key ID:** `161D6624BEE2416D` *(decoded comment: `untrusted comment: minisign public key: 161D6624BEE2416D`)*
- **SHA-256 Fingerprint:** `00293398FBF6DBB9DDB813F47C07BC974F2414FCAB51C8FAE71E64E320261EB0`
  - **Calculation Method:** SHA-256 digest of both the raw `.key.pub` file bytes (`Get-FileHash -Algorithm SHA256`) and the trimmed UTF-8 base64 string (identical digest).

---

## C. Windows NTFS ACL Verification

### Original ACL Inspection
- `C:\Users\ok\.tauri`, `stockstudio-pro-updater.key`, and `stockstudio-pro-updater.key.pub` initially had inherited `(I)` permissions for `NT AUTHORITY\SYSTEM`, `BUILTIN\Administrators`, and `DESKTOP-79TL32O\ok`.

### ACL Changes Performed (Scoped Strictly to `.tauri` and the Two Key Files)
- Disabled inheritance (`/inheritance:r`) and granted explicit permissions ONLY to `DESKTOP-79TL32O\ok`, `NT AUTHORITY\SYSTEM`, and `BUILTIN\Administrators` (`(OI)(CI)F` on `.tauri`, `F` on `.key`, `R,W` for current user on `.key.pub`).
- Verified `BUILTIN\Users` and `Everyone` have **zero access**.

### Final `icacls` Verification Evidence
```text
C:\Users\ok\.tauri BUILTIN\Administrators:(OI)(CI)(F)
                   NT AUTHORITY\SYSTEM:(OI)(CI)(F)
                   DESKTOP-79TL32O\ok:(OI)(CI)(F)

C:\Users\ok\.tauri\stockstudio-pro-updater.key BUILTIN\Administrators:(F)
                                               NT AUTHORITY\SYSTEM:(F)
                                               DESKTOP-79TL32O\ok:(F)

C:\Users\ok\.tauri\stockstudio-pro-updater.key.pub BUILTIN\Administrators:(F)
                                                   NT AUTHORITY\SYSTEM:(F)
                                                   DESKTOP-79TL32O\ok:(R,W)
```

---

## D. Offline Backup

- **Exact Status:** **`OFFLINE_BACKUP_PENDING`**
- Per user selection, no backup copy was created, moved, or uploaded. The original key remains at `%USERPROFILE%\.tauri\stockstudio-pro-updater.key`.
- **Requirement:** Complete an encrypted offline vault backup of `stockstudio-pro-updater.key` and its passphrase **before** uploading to GitHub Secrets or publishing any signed public release.

---

## E. Cryptographic Verification

- **Key Files Present:** Confirmed `stockstudio-pro-updater.key` (`348` bytes) and `stockstudio-pro-updater.key.pub` (`152` bytes).
- **Public-Key Format Compatibility:** **PASS** — Base64-encoded minisign public key (`161D6624BEE2416D`) matches the exact format expected by `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
- **Interactive Private-Key Signing Test (`NOT EXECUTED IN NON-INTERACTIVE SHELL`):**
  - `tauri-cli 2.11.4` provides `npx tauri signer sign -f <key> <file>` (no passwordless public-key derivation or standalone verify subcommand).
  - Because `tauri signer sign` requires interactive passphrase entry to decrypt the private key and this agent shell has no interactive TTY (and passing the passphrase via CLI flags, env vars, or chat is strictly prohibited), the live signing roundtrip was not executed here.
  - **Optional 1-Line Local Operator Signing Check (outside repo, auto-cleans temp files):**
    ```powershell
    $tmp = Join-Path $env:TEMP "sspro-signer-test.txt"; Set-Content $tmp "test"; try { npx tauri signer sign -f "$env:USERPROFILE\.tauri\stockstudio-pro-updater.key" $tmp } finally { Remove-Item $tmp, "$tmp.sig" -Force -ErrorAction SilentlyContinue }
    ```

---

## F. Configuration Boundary Verification

- **`src-tauri/tauri.conf.json`:** **UNCHANGED** — still retains legacy `9883364C90076B4B` and `https://github.com/masplangga/flowpilot/releases/latest/download/latest.json` (new key `161D6624BEE2416D` has NOT been integrated yet).
- **`.github/workflows/release.yml`:** **UNCHANGED**.
- **Production License Signing Key (`sspro-ed25519-prod-01`):** **COMPLETELY UNTOUCHED** in `config.rs`, Cloudflare Worker, and production D1.
- **GitHub Secrets & Cloudflare Resources:** **ZERO CHANGES**.

---

## G. Git Safety Verification

- **Branch:** `main`
- **HEAD:** `f398e578ae5a42f08fae58d2f3ffaed160d202de`
- **Original Commits:** `9` (intact, no history rewrite)
- **Git Remotes:** `0`
- **Staged Files:** `0`
- **Private/Public Updater Key Files Inside Repository:** `0`
- **Confirmation:** Private key contents and passphrase were never printed, logged, or written to the repository.

---

## H. Final Verdict & Outstanding Security Tasks

> **Final Verdict: `KEYPAIR_GENERATED_BACKUP_PENDING`**

**Outstanding tasks before G-G3.1C.3 (Config Update & GitHub Publication):**
1. Archive `%USERPROFILE%\.tauri\stockstudio-pro-updater.key` and its passphrase in your encrypted offline vault (clears `OFFLINE_BACKUP_PENDING`).
2. *(Recommended)* Run the optional 1-line interactive `npx tauri signer sign` test locally to confirm your passphrase decrypts the key cleanly.
3. Upon your explicit approval, integrate public key `161D6624BEE2416D` and `https://github.com/dekadk/stockstudio-pro/releases/latest/download/latest.json` into `src-tauri/tauri.conf.json`, create `dekadk/stockstudio-pro`, set GitHub Secrets, and push.
