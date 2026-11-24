# TASK G-G3.5B — First Owner License Issuance Preparation

**Project:** StockStudio Pro v0.2.0  
**Target Environment:** Production ONLY (`https://stockstudio-pro-license-production.pages.dev`)  
**Target License Profile:** `perpetual` / `lifetime` / `products: ["desktop", "vectorizer_extension"]` / `device_limit: 2`  
**Status:** **PREPARED & OFFLINE-VERIFIED (NO PRODUCTION LICENSE ISSUED YET)**  
**Date:** 2026-11-23

---

## 1. Verified Production API Request Schema (`POST /v1/admin/licenses`)

Verified directly against `workers/license-api/src/admin-handlers.ts:199-521`:

- **Endpoint:** `POST https://stockstudio-pro-license-production.pages.dev/v1/admin/licenses`
- **Headers:**
  - `Authorization: Bearer ssadm_<prefix>_<secret>` (`super_admin` or `billing_system` role)
  - `Content-Type: application/json`
  - `Idempotency-Key: owner-prod-lifetime-<uuid>`
- **JSON Request Body:**
  ```json
  {
    "plan_code": "lifetime",
    "plan_name": "Lifetime Pro (Owner)",
    "license_type": "perpetual",
    "billing_interval": "lifetime",
    "device_limit": 2,
    "customer_email": "<optional-owner-email>",
    "customer_name": "StockStudio Pro Owner",
    "notes": "First StockStudio Pro production owner license",
    "entitlements": {
      "products": ["desktop", "vectorizer_extension"]
    }
  }
  ```
- **Schema Rules Confirmed:**
  - `expires_at` is omitted (required for `perpetual` licenses).
  - `billing_interval` is `"lifetime"` (enforced by server for `perpetual`).
  - `entitlements.products` explicitly assigns both `"desktop"` and `"vectorizer_extension"`.
  - Plaintext `license_key` is returned **exactly once** in the `HTTP 201` response and is never stored in plaintext in production D1.

---

## 2. Prepared One-Time Secure Issuance Scripts (Untracked Local)

1. **`workers/license-api/scripts/issue-owner-license-prod.ps1`** (Interactive PowerShell Wrapper):
   - Requires typing `ISSUE-PRODUCTION-OWNER` to confirm production issuance.
   - Reads the **Production Super Admin Key** (`ssadm_...`) and a **new Vault Encryption Passphrase** (`>= 16` chars, confirmed twice) using `Read-Host -AsSecureString` (masked input; never echoed, never saved in PowerShell command history).
   - Passes credentials strictly via in-memory process **stdin JSON** (never CLI arguments, never environment variables, never temporary files) and zeroes all BSTRs/variables in `finally {}`.
   - Includes a `-DecryptToClipboard` switch to later copy the decrypted key directly to Windows Clipboard without displaying it on screen.
2. **`workers/license-api/scripts/issue-owner-license-prod.mjs`** (Node.js v20 Crypto & API Engine):
   - Refuses to overwrite existing owner vault/metadata files.
   - Calls `POST https://stockstudio-pro-license-production.pages.dev/v1/admin/licenses`.
   - Immediately encrypts `{ license_id, key_prefix, license_key, issued_at, ... }` with **scrypt (`N=16384, r=8, p=1, keylen=32`) + AES-256-GCM** (random 32-byte salt, random 12-byte IV, authenticated 16-byte GCM tag).
   - Applies restrictive Windows NTFS ACLs (`icacls <file> /inheritance:r /grant:r "<USER>:(R,W)"`).
   - **Performs an immediate local decryption round-trip check** on the written `.enc.json` file before reporting success.
   - Prints **only** non-secret metadata (`license_id`, `key_prefix`, `device_limit`, `entitlements`, `decryption_verified: true`) — **never** prints `license_key`.

---

## 3. Secure Local Storage Design (Outside Git Repository)

Default Vault Directory: `E:\2. Microstock\TOOL\Data Penting StockStudio Pro\` *(completely outside the Git workspace)*

| File | Contents | Protection |
|---|---|---|
| `stockstudio-pro-owner-license.enc.json` | Encrypted `license_key`, `license_id`, `key_prefix`, `issued_at` | `scrypt` + `AES-256-GCM` authenticated ciphertext + Windows NTFS ACL restricted to current user (`(R,W)`) |
| `stockstudio-pro-owner-license.meta.json` | Non-secret metadata only (`license_id`, `key_prefix`, `plan_code`, `status`, `device_limit`, `entitlements`, `request_id`, `encrypted_vault_path`) | Contains **zero** plaintext `license_key` or admin credentials |

---

## 4. Offline Pre-Flight Validation Results (Zero Production Calls)

| Check | Result | Details |
|---|---|---|
| `node workers/license-api/scripts/issue-owner-license-prod.mjs --self-test` | **PASS** | Verified `scrypt + AES-256-GCM` encrypt/decrypt round-trip, wrong-passphrase GCM authentication rejection, Windows `icacls` NTFS ACL lock, and zero plaintext in both `.enc.json` and `.meta.json` |
| PowerShell parser validation on `issue-owner-license-prod.ps1` | **PASS** | `0` parse errors |
| Production safety check | **PASS** | `0` production API writes, `0` licenses issued, `0` activations consumed; Git `main` @ `0335a8cd714cbaaa3136f6f2bfd578370e92bf55`, `0` staged, `0` modified tracked |

---

## 5. Exact Operator Execution Steps (When Ready to Issue)

1. **Run the interactive issuance wrapper in local PowerShell** (inside `E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main`):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\workers\license-api\scripts\issue-owner-license-prod.ps1 -CustomerEmail "your-owner-email@example.com"
   ```
2. Type `ISSUE-PRODUCTION-OWNER` when prompted.
3. Paste your **Production Super Admin Key** (`ssadm_...`) at the masked prompt (from your offline production recovery bundle / password manager).
4. Enter and confirm a strong **Vault Encryption Passphrase** (`>= 16` characters) and save that passphrase in your password manager.
5. Confirm output displays `"status": "ISSUED_AND_ENCRYPTED_VERIFIED"` and `"decryption_verified": true`, and record the printed `license_id` and `key_prefix`.
6. **Later, to activate Desktop without displaying the plaintext key:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\workers\license-api\scripts\issue-owner-license-prod.ps1 -DecryptToClipboard
   ```
   Then paste directly into StockStudio Pro Desktop (`Ctrl+V`) and clear the clipboard afterward (`Set-Clipboard -Value $null`).

---

## 6. Stop Confirmation

Stopping here — **no production license has been issued**, no production API write or D1 change occurred, and no secrets were accessed or exposed.
