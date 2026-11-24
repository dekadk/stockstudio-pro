# StockStudio Pro — Production License Administration Guide

**Version:** `v0.2.0`  
**Production API Endpoint:** `https://stockstudio-pro-license-production.pages.dev` *(Cloudflare Pages Gateway → Service Binding → `stockstudio-pro-license-api-prod`)*  
**Production D1 Database:** `stockstudio-pro-licenses-prod` (`e2356bb7-53dc-4412-b7f4-2c255115d6bd`)  
**Production Signing KID:** `sspro-ed25519-prod-01`  
**Last Verified Against Source:** 2026-11-23 (`workers/license-api/src/index.ts`, `admin-handlers.ts`, `utils.ts`, `types.ts`)

---

## 1. Current Tooling Status (Implemented vs. Future)

| Capability | Currently Implemented (`v0.2.0`) | Future / Suggested Enhancement |
|---|---|---|
| **Admin REST API (HTTPS)** | **YES** — 8 authenticated Admin endpoints + 1 Billing Webhook | Add `GET /v1/admin/licenses` paginated list/search endpoint |
| **Graphical Admin Dashboard (Web UI)** | **NO** — No web UI or GUI dashboard exists yet | Build an authenticated owner dashboard (e.g., Cloudflare Access-protected admin UI) |
| **Customer License Issuance CLI** | **NO** — Existing scripts in `workers/license-api/scripts/` (`bootstrap-production.mjs`, `migrate-production.mjs`, etc.) are infrastructure setup tools only | Build a dedicated local interactive CLI wrapper (e.g., `npm run prod:issue-license`) |
| **License Listing / Search** | **Via Read-Only D1 SQL (`wrangler d1 execute`)** — Single-license lookup exists via `GET /v1/admin/licenses/:license_id` | Add `GET /v1/admin/licenses?email=&status=&prefix=` API route |
| **RBAC & IP Allowlist** | **YES** — 4 roles (`super_admin`, `support_admin`, `billing_system`, `read_only`) + optional `allowed_ips_json` per admin key | Add admin key creation/rotation API endpoint |

---

## 2. Authentication & Safe Handling of the Super Admin Key

### 2.1 How Admin Authentication Works
- Every `/v1/admin/*` request requires:
  ```http
  Authorization: Bearer ssadm_<prefix>_<secret>
  ```
- The Worker verifies the token by computing `HMAC-SHA256(ADMIN_TOKEN_PEPPER, token)` and matching `admin_api_keys.key_hash` in constant time (`admin-handlers.ts:54-175`).
- The Worker enforces:
  1. Key `status === "active"` and not past `expires_at`.
  2. Role membership (`super_admin`, `support_admin`, `billing_system`, or `read_only`).
  3. Optional `allowed_ips_json` IP allowlist against `CF-Connecting-IP` (unrestricted when `null` or `[]`).

### 2.2 Safe Super Admin Key Operating Procedure (Windows PowerShell)
1. **Never** hardcode the Super Admin Key in scripts, `.env` files, Git commits, terminal command-line arguments, or chat logs.
2. Decrypt your offline AES-256-GCM recovery bundle only when needed, copy the key directly from your password manager/vault, and load it into a **session-only** PowerShell variable without echoing it to screen or history:
   ```powershell
   $sec = Read-Host -AsSecureString "Enter Production Admin Key (hidden)"
   $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
   $ADMIN_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
   [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
   $API = "https://stockstudio-pro-license-production.pages.dev"
   ```
3. **Clear the variable immediately** after your admin session:
   ```powershell
   Remove-Variable ADMIN_KEY, sec -ErrorAction SilentlyContinue
   ```
4. **Best Practice:** Consider issuing a lower-privilege `support_admin` or `read_only` key for routine customer support, reserving `super_admin` for issuance and revocations.

---

## 3. Exact Implemented Admin API Routes

| Method & Route | Allowed Roles | Purpose |
|---|---|---|
| `POST /v1/admin/licenses` | `super_admin`, `billing_system` | Issue a new perpetual or subscription license (returns plaintext `license_key` **once**) |
| `GET /v1/admin/licenses/:license_id` | `super_admin`, `support_admin`, `billing_system`, `read_only` | Inspect license details, `billing_subscription`, all `activations`, and latest 50 `events` |
| `PATCH /v1/admin/licenses/:license_id` | `super_admin`, `support_admin` | Update `device_limit`, `customer_email`, `customer_name`, `notes`, and `entitlements` |
| `POST /v1/admin/licenses/:license_id/suspend` | `super_admin`, `support_admin` | Temporarily suspend a non-revoked license |
| `POST /v1/admin/licenses/:license_id/reinstate` | `super_admin`, `support_admin` | Reinstate a suspended license (`active` or `pending_activation`) |
| `POST /v1/admin/licenses/:license_id/revoke` | `super_admin`, `billing_system` | **Permanently** revoke a license and immediately revoke all active device activations |
| `POST /v1/admin/licenses/:license_id/renew` | `super_admin`, `billing_system` | Extend a `subscription` license period via an idempotent payment record |
| `DELETE /v1/admin/licenses/:license_id/devices/:activation_id` | `super_admin`, `support_admin` | Force-deactivate a single device activation and free its device slot |

*(All `POST` / `PATCH` endpoints require `Content-Type: application/json`. All responses include `X-Request-Id` header and `server_time`.)*

---

## 4. Creating Customer Licenses (`POST /v1/admin/licenses`)

### 4.1 Request Parameters

| Field | Required? | Type / Allowed Values | Rules |
|---|:---:|---|---|
| `plan_code` | **Yes** | `string` | Non-empty plan identifier (e.g., `"lifetime"`, `"pro_monthly"`, `"pro_yearly"`) |
| `plan_name` | **Yes** | `string` | Human-readable plan name shown in Desktop/Extension (e.g., `"Lifetime"`, `"Pro Monthly"`) |
| `license_type` | **Yes** | `"perpetual"` \| `"subscription"` | Controls lifetime vs time-limited behavior |
| `billing_interval` | **Yes** | `"lifetime"` \| `"monthly"` \| `"yearly"` | Must be `"lifetime"` for `perpetual`; must be `"monthly"` or `"yearly"` for `subscription` |
| `current_period_start` | **Subscription only** | ISO-8601 UTC string | Required for `subscription` (e.g., `"2026-11-23T00:00:00Z"`) |
| `current_period_end` | **Subscription only** | ISO-8601 UTC string | Required for `subscription`; must be strictly greater than `current_period_start` |
| `expires_at` | Optional (Sub only) | ISO-8601 UTC string \| `null` | **Forbidden** on `perpetual` (must omit or `null`); defaults to `current_period_end` on `subscription` |
| `device_limit` | Optional | integer `1`–`100` | Defaults to `2` (`DEFAULT_DEVICE_LIMIT`) |
| `entitlements` | Optional | object | `{ products, features, max_accounts, updates_until, max_app_version }` — see §4.4 |
| `customer_email` | Optional | `string` | Normalized to lowercase |
| `customer_name` | Optional | `string` | Trimmed display name |
| `external_customer_id` | Optional | `string` | Payment provider customer reference |
| `external_order_id` | Optional | `string` | Invoice/order reference |
| `external_subscription_id` | Optional | `string` | Subscription reference (for `subscription` licenses) |
| `billing_provider` | Optional | `string` | Defaults to `"manual"` for subscriptions |
| `notes` | Optional | `string` | Internal admin notes |
| Header `Idempotency-Key` | Recommended | `string` | Prevents duplicate issuance on retry (duplicate returns `HTTP 409 IDEMPOTENCY_CONFLICT` without re-revealing the key) |

### 4.2 Example: Create a Perpetual License (Desktop + Chrome Extension, 2 Devices)
```powershell
$body = @{
  plan_code        = "lifetime"
  plan_name        = "Lifetime Pro"
  license_type     = "perpetual"
  billing_interval = "lifetime"
  device_limit     = 2
  customer_email   = "customer@example.com"
  customer_name    = "Customer Name"
  external_order_id = "INV-2026-0001"
  entitlements     = @{
    products = @("desktop", "vectorizer_extension")
  }
  notes            = "Paid lifetime bundle"
} | ConvertTo-Json -Depth 5

$headers = @{
  Authorization     = "Bearer $ADMIN_KEY"
  "Content-Type"    = "application/json"
  "Idempotency-Key" = "order-INV-2026-0001"
}

$res = Invoke-RestMethod -Method Post -Uri "$API/v1/admin/licenses" -Headers $headers -Body $body
# Capture $res.license_key ONCE for secure customer delivery (never log to terminal/files!)
$res.license | ConvertTo-Json -Depth 5
```

### 4.3 Example: Create a Time-Limited Subscription License (Monthly / Yearly)
```powershell
$start = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
$end   = [DateTime]::UtcNow.AddMonths(1).ToString("yyyy-MM-ddTHH:mm:ssZ")

$body = @{
  plan_code            = "pro_monthly"
  plan_name            = "Pro Monthly"
  license_type         = "subscription"
  billing_interval     = "monthly"
  current_period_start = $start
  current_period_end   = $end
  device_limit         = 2
  customer_email       = "subscriber@example.com"
  entitlements         = @{
    products = @("desktop", "vectorizer_extension")
  }
} | ConvertTo-Json -Depth 5

$headers = @{
  Authorization     = "Bearer $ADMIN_KEY"
  "Content-Type"    = "application/json"
  "Idempotency-Key" = "sub-$([guid]::NewGuid().ToString())"
}

$res = Invoke-RestMethod -Method Post -Uri "$API/v1/admin/licenses" -Headers $headers -Body $body
```

### 4.4 Assigning Product Entitlements (`desktop` & `vectorizer_extension`)
- **Desktop + Chrome Extension:** `entitlements: { products: ["desktop", "vectorizer_extension"] }`
- **Desktop Only:** `entitlements: { products: ["desktop"] }` *(Chrome Extension fails closed with `PRODUCT_NOT_ENTITLED`)*
- **Default if `entitlements.products` is omitted:** Desktop-only (fail-closed for Chrome Extension; legacy licenses are never silently granted `vectorizer_extension`).
- **Updating Entitlements Later (`PATCH /v1/admin/licenses/:license_id`):**
  ```powershell
  $patch = @{ entitlements = @{ products = @("desktop", "vectorizer_extension") } } | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Method Patch -Uri "$API/v1/admin/licenses/$licenseId" `
    -Headers @{ Authorization = "Bearer $ADMIN_KEY"; "Content-Type" = "application/json" } -Body $patch
  ```
  *(Note: Existing active clients receive updated entitlements on their next online validation/refresh or reactivation.)*

### 4.5 Creation Response (`HTTP 201`)
Returns `{ ok: true, license_key: "SSPRO-...", license: { license_id, key_prefix, plan_code, plan_name, license_type, billing_interval, status: "pending_activation", lifetime, expires_at, current_period_start, current_period_end, device_limit, devices_used: 0, entitlements, customer_email, created_at }, request_id, server_time }`.

---

## 5. Storing & Delivering Raw License Keys (Critical Security Invariant)

- **One-Time Plaintext Return:** The raw `license_key` (`SSPRO-XXXX-XXXX-XXXX-XXXX`) is generated via CSPRNG and returned **EXACTLY ONCE** in the `HTTP 201` response of `POST /v1/admin/licenses`.
- **Zero Plaintext at Rest in D1:** Production D1 stores **only** `key_prefix` (for identification) and `key_hash` (`HMAC-SHA256(LICENSE_KEY_PEPPER, key)`). **The raw key cannot be retrieved from D1 or any API endpoint afterward.**
- **Recommended Delivery Workflow:**
  1. Deliver `$res.license_key` directly to the customer via your private invoice/email/order system (and optionally store `license_id`, `key_prefix`, and customer email in your CRM/order sheet — never commit customer keys to Git).
  2. If a customer loses their key, **revoke** the old `license_id` (`POST /v1/admin/licenses/:id/revoke`) and **issue a replacement license** (`POST /v1/admin/licenses`).

---

## 6. Listing, Inspecting, Updating, Renewing, Revoking & Deactivating

### 6.1 Inspect a Specific License & Its Devices (`GET /v1/admin/licenses/:license_id`)
```powershell
Invoke-RestMethod -Method Get -Uri "$API/v1/admin/licenses/$licenseId" `
  -Headers @{ Authorization = "Bearer $ADMIN_KEY" } | ConvertTo-Json -Depth 6
```
Returns `license` (full metadata), `billing_subscription`, `activations` (each with `activation_id`, `device_id`, `device_name`, `status`, `activated_at`, `last_validated_at`), and `events` (latest 50 audit entries).

### 6.2 List / Search Licenses *(Currently via Read-Only D1 SQL)*
Because `GET /v1/admin/licenses` (collection listing) is not yet implemented in the Worker, list or find a `license_id` using a read-only D1 query from `workers/license-api`:
```powershell
npx wrangler d1 execute DB --env production --remote --command "SELECT id, key_prefix, plan_code, status, device_limit, active_devices_count, customer_email, expires_at, created_at FROM licenses ORDER BY created_at DESC LIMIT 25;"
```

### 6.3 Update Device Limit (`PATCH /v1/admin/licenses/:license_id`)
- Valid range: integer `1`–`100`. Cannot be set below `active_devices_count` (deactivate excess devices first).
```powershell
$patch = @{ device_limit = 3; notes = "Upgraded to 3 devices" } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "$API/v1/admin/licenses/$licenseId" `
  -Headers @{ Authorization = "Bearer $ADMIN_KEY"; "Content-Type" = "application/json" } -Body $patch
```

### 6.4 Force-Deactivate a Device Slot (`DELETE /v1/admin/licenses/:license_id/devices/:activation_id`)
Use when a customer loses/formats a PC and cannot self-deactivate:
```powershell
# Get activation_id from GET /v1/admin/licenses/$licenseId -> .activations
Invoke-RestMethod -Method Delete -Uri "$API/v1/admin/licenses/$licenseId/devices/$activationId" `
  -Headers @{ Authorization = "Bearer $ADMIN_KEY" }
```

### 6.5 Suspend & Reinstate (`POST .../suspend` and `POST .../reinstate`)
```powershell
# Temporary suspension (reversible)
Invoke-RestMethod -Method Post -Uri "$API/v1/admin/licenses/$licenseId/suspend" `
  -Headers @{ Authorization = "Bearer $ADMIN_KEY"; "Content-Type" = "application/json" } `
  -Body (@{ reason = "Pending payment verification" } | ConvertTo-Json)

# Reinstate (restores to 'active' or 'pending_activation'; cannot reinstate 'revoked')
Invoke-RestMethod -Method Post -Uri "$API/v1/admin/licenses/$licenseId/reinstate" `
  -Headers @{ Authorization = "Bearer $ADMIN_KEY"; "Content-Type" = "application/json" } `
  -Body (@{ reason = "Payment verified" } | ConvertTo-Json)
```

### 6.6 Renew a Subscription (`POST /v1/admin/licenses/:license_id/renew`)
```powershell
$renewBody = @{
  billing_provider    = "manual_admin"
  external_payment_id = "PAY-2026-0042"
  new_period_start    = "2026-12-23T00:00:00Z"
  new_period_end      = "2027-01-23T00:00:00Z"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$API/v1/admin/licenses/$licenseId/renew" `
  -Headers @{ Authorization = "Bearer $ADMIN_KEY"; "Content-Type" = "application/json" } -Body $renewBody
```
*(Idempotent by `(billing_provider, external_payment_id)`; `new_period_end` must extend beyond current `current_period_end`.)*

### 6.7 Permanently Revoke a License (`POST /v1/admin/licenses/:license_id/revoke`)
**Irreversible** — revokes the license and all active device activations immediately (`active_devices_count = 0`; cannot be reinstated or renewed):
```powershell
Invoke-RestMethod -Method Post -Uri "$API/v1/admin/licenses/$licenseId/revoke" `
  -Headers @{ Authorization = "Bearer $ADMIN_KEY"; "Content-Type" = "application/json" } `
  -Body (@{ reason = "Refund issued"; external_reference_id = "REF-2026-001" } | ConvertTo-Json)
```

---

## 7. Suggested Future Enhancements (Not Yet Implemented)

1. **`GET /v1/admin/licenses` List/Search Endpoint:** Paginated query by `customer_email`, `key_prefix`, `status`, and `plan_code` so routine lookups do not require `wrangler d1 execute`.
2. **Owner Admin CLI (`workers/license-api/scripts/admin-cli.mjs`):** Interactive local helper that prompts securely for the admin key, issues/inspects/revokes licenses, and copies new keys directly to clipboard without printing them to terminal history.
3. **Web Admin Dashboard:** Lightweight Cloudflare Pages + Cloudflare Access admin portal backed by the existing `/v1/admin/*` routes.
