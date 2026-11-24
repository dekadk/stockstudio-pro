# StockStudio Pro License Manager — Staging Admin Credential Guide

**Date:** 2026-11-23  
**Application:** `apps/license-manager/` (`com.stockstudiopro.licensemanager`)  
**Target Environment:** **STAGING ONLY** (`https://stockstudio-pro-license-staging.pages.dev`)  
**Production Impact:** **NONE** (Production Super Admin Key and Production infrastructure are untouched)

---

## 1. Rust Windows Credential Manager Architecture

Inspected in `apps/license-manager/src-tauri/src/security.rs` and `commands.rs`:

| Setting | Value |
|---|---|
| Keyring Crate | `keyring = "3"` (`features = ["windows-native"]`, DPAPI-backed Windows Generic Credentials) |
| Isolated Service Name | `StockStudioPro-LicenseManager-Admin` *(strictly isolated from Customer Desktop)* |
| Staging Account Name | `staging-admin-key` |
| Production Account Name | `production-admin-key` |
| Windows Target Name (`keyring` v3 format) | `staging-admin-key.StockStudioPro-LicenseManager-Admin` (Staging) / `production-admin-key.StockStudioPro-LicenseManager-Admin` (Production) |
| In-Memory Protection | `zeroize::Zeroizing<String>` (wiped on lock, idle timeout, 401 rejection, environment switch, or exit) |
| Default Environment on Launch | `Staging` (always starts **Locked**) |

### Retrieval Flow
1. On startup, `get_session_status` checks `WindowsKeyringStore::has_key(Environment::Staging)` inside Rust without ever returning the secret to React.
2. When a stored key exists, the Unlock Gate displays **"Windows Credential Manager Key Available"** and an **"Unlock Stored Session"** button.
3. Clicking **"Unlock Stored Session"** invokes `unlock_from_keyring` → Rust reads the secret from Windows Credential Manager into `Zeroizing<String>` → validates it via `GET https://stockstudio-pro-license-staging.pages.dev/v1/admin/me` → unlocks the UI with sanitized `AdminMeResponse` metadata only.

---

## 2. Current Staging Credential Verification Status

Read-only verification performed on **2026-11-23** (zero secrets printed or logged):

| Check | Status | Verified Details |
|---|---|---|
| Windows Credential Manager (`cmdkey /list`) | **Not yet stored** | No `StockStudioPro-LicenseManager-Admin` entry exists yet (expected before first License Manager unlock). |
| Local Staging Bootstrap Artifact (`workers/license-api/bootstrap-staging-admin.json`, gitignored) | **PRESENT & VALID** | `environment: "staging"`, `admin_id: "adm_01M7XF08DMSEPMCV769YHCR217"`, `admin_key_prefix: "ssadm_01M7XF08DM"`, `signing_kid: "sspro-ed25519-staging-01"`, `created_at: "2026-11-20T21:50:03Z"`. |
| Live Staging API Auth Check (`GET /v1/admin/me`) | **HTTP 200 OK** | Confirmed active `super_admin` principal on Staging. **No new credential creation or rotation is needed.** |

---

## 3. Exact Steps to Unlock License Manager (Staging)

Because a valid Staging Admin Key already exists in `workers/license-api/bootstrap-staging-admin.json`, **do not create or rotate a new key**. Follow these steps to store it into Windows Credential Manager through the License Manager's own Rust backend without displaying the raw key:

### Step 1 — Launch StockStudio Pro License Manager
Run the built executable (or installed preview):
- `apps/license-manager/dist-release/stockstudio-pro-license-manager.UNSIGNED-PREVIEW.exe`
- Confirm the **Target Environment** is set to **STAGING** (`https://stockstudio-pro-license-staging.pages.dev`).

### Step 2 — Transfer the Existing Staging Key Silently to Clipboard (No Terminal Echo)
In Windows PowerShell (from the repository root):

```powershell
$j = Get-Content -Raw "workers\license-api\bootstrap-staging-admin.json" | ConvertFrom-Json
if ($j.admin_key_prefix -ne "ssadm_01M7XF08DM" -or -not $j.admin_api_key.StartsWith("ssadm_01M7XF08DM")) {
    throw "Unexpected Staging admin key prefix."
}
Set-Clipboard -Value $j.admin_api_key
$j = $null
Write-Host "Staging Admin Key copied to clipboard (prefix: ssadm_01M7XF08DM). Paste into License Manager now."
```

### Step 3 — Unlock & Save into Windows Credential Manager
1. Click inside the masked **Admin API Key (Verified in Rust Core)** field in License Manager and press `Ctrl+V`.
2. Check **"Store in Windows Credential Manager (isolated service)"**.
3. Click **Unlock License Manager**.
   - Rust validates the key against `GET /v1/admin/me` (`HTTP 200`, `super_admin`, `staging`), saves it under `StockStudioPro-LicenseManager-Admin` / `staging-admin-key`, and opens the Dashboard.

### Step 4 — Immediately Clear the Clipboard
```powershell
Set-Clipboard -Value ""
Write-Host "Clipboard cleared."
```

### Step 5 — Subsequent Launches
On every future launch:
- License Manager starts **Locked** on **STAGING** and shows **"Windows Credential Manager Key Available"**.
- Click **"Unlock Stored Session"** — no file reading, typing, or clipboard is required again.

---

## 4. Rotating or Removing the Staging Credential (Reference Only)

- **Remove from Windows Credential Manager:** Open **Admin & Security → Forget Stored Key** inside License Manager (invokes `forget_stored_credential`, deleting `staging-admin-key` and locking the session immediately).
- **Re-Provision Staging From Scratch (Only if Staging D1 is reset & explicitly approved):** Uses `workers/license-api/scripts/bootstrap-staging.mjs` against Staging D1 (`stockstudio-pro-licenses-staging`). Never run against Production.

---

## 5. Safety Confirmations

- Raw Staging Admin Key was **never** displayed, printed, or written to logs/reports.
- Production Super Admin Key, Owner License (`lic_01M84E55AWK71ZT2RR6A7DYVA0`), and Production infrastructure were **not** accessed or modified.
- No new credentials were created or rotated.
