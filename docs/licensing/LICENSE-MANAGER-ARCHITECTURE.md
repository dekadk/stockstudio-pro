# StockStudio Pro License Manager — Architecture & Security Design (LM-01)

**Project:** StockStudio Pro  
**Phase:** `LM-01` (Architecture Audit & Security Design — Strictly Read-Only)  
**Baseline Commit:** `0335a8cd714cbaaa3136f6f2bfd578370e92bf55`  
**Target Production API:** `https://stockstudio-pro-license-production.pages.dev` *(Pages Gateway → `stockstudio-pro-license-api-prod` → `stockstudio-pro-licenses-prod`)*  
**Date:** 2026-11-23

---

## 1. Proposed Architecture

### 1.1 Recommended Deployment Model: Standalone Private Tauri v2 Desktop App

Build the License Manager as a **completely separate, private Tauri v2 + Rust + React desktop application** (e.g., `apps/license-manager/` in a private repository or excluded from public customer release workflows), **never** bundled into the customer `StockStudio Pro` desktop app, Chrome Extension, or public `release.yml`.

```
+-----------------------------------------------------------------------+
|  Private Owner Workstation (Windows)                                  |
|                                                                       |
|  +---------------------------------+                                  |
|  | React + TypeScript Renderer     |  NEVER receives ssadm_ key,      |
|  | (WebView2, strict CSP,          |  Authorization headers, or       |
|  |  zero localStorage secrets)     |  stored credentials              |
|  +----------------+----------------+                                  |
|                   | Tauri IPC commands (typed JSON only)              |
|                   v                                                   |
|  +---------------------------------+                                  |
|  | Rust Admin Backend (Tauri Core) |                                  |
|  | - Zeroizing<String> in memory   |                                  |
|  | - Windows Credential Manager    |  Service:                        |
|  |   (isolated service name)       |  StockStudioPro-LicenseManager   |
|  | - Idle Auto-Lock (15 min)       |                                  |
|  | - reqwest + rustls-tls HTTPS    |                                  |
|  +----------------+----------------+                                  |
+-------------------|---------------------------------------------------+
                    | HTTPS + Authorization: Bearer ssadm_...
                    v
+-----------------------------------------------------------------------+
| Cloudflare Pages Gateway (stockstudio-pro-license-production.pages.dev)|
|        -- Service Binding (LICENSE_API) -->                           |
| Cloudflare Worker (stockstudio-pro-license-api-prod)                  |
|        -- D1 Binding (DB) -->                                         |
| Cloudflare D1 (stockstudio-pro-licenses-prod)                         |
+-----------------------------------------------------------------------+
```

### 1.2 Why Tauri v2 + Rust Over a Hosted Web SPA
| Criterion | Private Tauri v2 + Rust (Recommended) | Hosted Web SPA |
|---|---|---|
| **Super Admin Key exposure to JS/DOM/XSS** | **Zero** — key stays in Rust memory (`zeroize::Zeroizing`) | High risk — browser JS handles headers or cookies |
| **Credential persistence** | OS-protected Windows Credential Manager (`StockStudioPro-LicenseManager-Admin`) + optional encrypted local vault | `localStorage`/`sessionStorage` (prohibited) or requires building an extra auth server |
| **Attack surface** | Local desktop only (not publicly reachable on the internet) | Publicly exposed URL requiring Cloudflare Access / IdP + CSRF + session infrastructure |
| **Offline encrypted customer key export** | Native Rust `scrypt + AES-256-GCM` + `icacls` NTFS ACL + direct clipboard copy with auto-clear | Browser cannot set NTFS ACLs or reliably zero memory |
| **Customer app isolation** | Distinct binary, distinct Tauri `identifier` (`com.stockstudiopro.licensemanager`), distinct Credential Manager service | Separate deployment, still requires CORS changes on Worker |

---

## 2. Security Boundaries & Threat Model

### 2.1 Trust Boundaries
1. **Renderer ↔ Rust Core Boundary:** The React UI is treated as untrusted with long-lived secrets. It invokes typed Tauri commands (`admin_login_unlock`, `admin_list_licenses`, `admin_issue_license`, etc.). The Rust core attaches `Authorization: Bearer ssadm_...` internally and strips all secret headers before returning typed DTOs to the UI.
2. **Owner Admin App ↔ Customer Desktop App Boundary:**
   - Distinct Tauri identifier: `com.stockstudiopro.licensemanager` (never `com.stockstudiopro.desktop`).
   - Distinct Windows Credential Manager service: `StockStudioPro-LicenseManager-Admin` (never `StockStudioPro`).
   - Never reads or writes `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json` or Chrome Native Messaging registry keys.
3. **Production ↔ Staging Environment Boundary:**
   - Environment selector defaults to **Read-Only / Staging** or displays a high-contrast persistent banner (`PRODUCTION — LIVE CUSTOMER DATA` in crimson vs `STAGING` in amber) with separate credential slots per environment (`admin-key-prod` vs `admin-key-staging`).
4. **One-Time Customer Key Boundary:**
   - When `POST /v1/admin/licenses` returns `license_key`, Rust returns it to the Issue Modal **once** in volatile UI state (never cached in React Query / Redux / disk / logs), with buttons to **Copy to Clipboard (auto-clear after 30s)** or **Save Encrypted Vault (`.enc.json`)**, and wipes it immediately on modal close.

### 2.2 Threat Model & Mitigations
| Threat | Mitigation |
|---|---|
| **XSS / Dependency Compromise in WebView** | Strict Tauri CSP (`default-src 'self'`, `connect-src ipc: http://ipc.localhost`); Admin Key never leaves Rust memory; renderer cannot make direct external `fetch()` calls. |
| **Accidental Secret Logging / Crash Dumps** | Custom `Debug` redaction on credential structs; `reqwest` header logging disabled; zero `console.log` of keys/tokens; `zeroize::Zeroizing<String>` wipes memory on lock/drop. |
| **Unattended Workstation** | Configurable idle auto-lock (default 15 minutes) + manual **Lock Now** button clears in-memory key and requires re-unlocking. |
| **Accidental Destructive Action (Revoke / Force-Deactivate)** | Two-step confirmation modal requiring typing the exact `license_id` or `key_prefix` + mandatory non-empty `reason` field (recorded in immutable `license_events`). |
| **Privilege Escalation / Over-Privileged Daily Use** | Call `GET /v1/admin/me` on unlock to detect `role` (`super_admin`, `support_admin`, `read_only`) and disable/hide unauthorized actions in UI (server remains the authoritative RBAC gate). |
| **Accidental Public Distribution** | Private directory/repo excluded from `.github/workflows/release.yml` and `ci-windows-build.yml`; no updater endpoint pointing to public repo. |

---

## 3. Admin API Endpoint Design (Closing the Existing API Gaps)

### 3.1 Existing Implemented Endpoints (Preserved Unchanged)
- `POST /v1/admin/licenses` (`super_admin`, `billing_system`)
- `GET /v1/admin/licenses/:license_id` (`super_admin`, `support_admin`, `billing_system`, `read_only`)
- `PATCH /v1/admin/licenses/:license_id` (`super_admin`, `support_admin`)
- `POST /v1/admin/licenses/:license_id/suspend` (`super_admin`, `support_admin`)
- `POST /v1/admin/licenses/:license_id/reinstate` (`super_admin`, `support_admin`)
- `POST /v1/admin/licenses/:license_id/renew` (`super_admin`, `billing_system`)
- `POST /v1/admin/licenses/:license_id/revoke` (`super_admin`, `billing_system`)
- `DELETE /v1/admin/licenses/:license_id/devices/:activation_id` (`super_admin`, `support_admin`)

### 3.2 New Read-Only Admin Endpoints to Add (Milestone LM-02)

#### A. `GET /v1/admin/me`
- **Allowed Roles:** `super_admin`, `support_admin`, `billing_system`, `read_only`
- **Purpose:** Validates admin key on unlock without mutating state and returns safe principal metadata.
- **Response (`HTTP 200`):**
  ```json
  {
    "ok": true,
    "admin": {
      "id": "adm_...",
      "name": "Production Super Admin",
      "key_prefix": "ssadm_01M7ZJCTYH",
      "role": "super_admin",
      "expires_at": null,
      "allowed_ips_configured": false,
      "last_used_at": "2026-11-23T14:50:00Z"
    },
    "environment": "production",
    "signing_kid": "sspro-ed25519-prod-01",
    "server_time": "2026-11-23T15:00:00Z"
  }
  ```

#### B. `GET /v1/admin/licenses` (Registry List + Search + Filters + Cursor Pagination)
- **Allowed Roles:** `super_admin`, `support_admin`, `billing_system`, `read_only`
- **Query Parameters:**
  - `limit`: integer `1`–`100` (default `25`)
  - `cursor`: opaque Base64URL JSON cursor (e.g., `{"v":1,"s":"created_desc","k":"2026-11-23T14:49:56Z","i":"lic_01M84E55..."}`)
  - `status`: optional enum (`pending_activation`, `active`, `past_due`, `expired`, `suspended`, `revoked`)
  - `license_type`: optional enum (`perpetual`, `subscription`)
  - `plan_code`: optional exact string filter
  - `product`: optional enum (`desktop`, `vectorizer_extension`)
  - `q`: optional search string (trimmed, max 100 chars; matches `id`, `key_prefix`, `customer_email`, `customer_name`, `external_order_id`)
  - `sort`: `created_desc` (default) | `created_asc` | `expires_asc`
- **Safe Response Fields (NEVER returns `key_hash`, `key_pepper_version`, `idempotency_key`, or raw keys):**
  ```json
  {
    "ok": true,
    "items": [
      {
        "license_id": "lic_01M84E55AWK71ZT2RR6A7DYVA0",
        "key_prefix": "SSPRO-6WQD",
        "plan_code": "lifetime",
        "plan_name": "Lifetime Pro (Owner)",
        "license_type": "perpetual",
        "billing_interval": "lifetime",
        "status": "pending_activation",
        "lifetime": true,
        "expires_at": null,
        "device_limit": 2,
        "devices_used": 0,
        "entitlements": {
          "products": ["desktop", "vectorizer_extension"],
          "features": ["google_flow_workspace", "multi_account_manager", "unlimited_accounts"],
          "max_accounts": null,
          "updates_until": null,
          "max_app_version": null
        },
        "customer_email": null,
        "customer_name": "StockStudio Pro Owner",
        "external_order_id": null,
        "created_at": "2026-11-23T14:49:56Z",
        "updated_at": "2026-11-23T14:49:56Z"
      }
    ],
    "pagination": {
      "limit": 25,
      "has_more": false,
      "next_cursor": null
    },
    "server_time": "2026-11-23T15:00:00Z"
  }
  ```

#### C. `GET /v1/admin/stats` (Dashboard Metrics)
- **Allowed Roles:** `super_admin`, `support_admin`, `billing_system`, `read_only`
- **Response (`HTTP 200`):** Total licenses, breakdown by `status` (`pending_activation`, `active`, `past_due`, `expired`, `suspended`, `revoked`), breakdown by `license_type` (`perpetual`, `subscription`), total active device activations, subscriptions expiring within 7 days, licenses issued in last 30 days, active `signing_kid`.

#### D. `GET /v1/admin/events` (Global Audit Log)
- **Allowed Roles:** `super_admin`, `support_admin`, `read_only`
- **Query Parameters:** `limit` (`1`–`100`, default `50`), `cursor` (keyset on `(created_at, id)`), `event_type`, `actor_type`, `license_id`, `from`, `to`.
- **Safe Response Fields:** `id`, `license_id`, `activation_id`, `device_id`, `event_type`, `actor_type`, `actor_id`, `previous_status`, `new_status`, `ip_hash_prefix` (first 12 hex chars only), `metadata`, `created_at`.

---

## 4. D1 Schema Audit, Query Design & Stable Cursor Pagination

### 4.1 Audit of `0001_initial_license_schema.sql`
- Existing indexes on `licenses`: `PRIMARY KEY (id)`, `idx_licenses_key_prefix (key_prefix)`, `idx_licenses_customer_email (customer_email)`, `idx_licenses_status_expires (status, expires_at)`, `idx_licenses_external_order (external_order_id)`.
- Existing indexes on `license_events`: `idx_license_events_license_created (license_id, created_at DESC)`, `idx_license_events_type_created (event_type, created_at DESC)`.
- **Schema Integrity:** No table column changes are required! All required customer, status, entitlement, activation, and audit fields already exist in `0001_initial_license_schema.sql`.

### 4.2 Additive Index Migration (`0002_admin_listing_indexes.sql` — Zero Downtime, Non-Breaking)
To guarantee O(log N) keyset pagination as license volume grows:
```sql
CREATE INDEX IF NOT EXISTS idx_licenses_created_id
    ON licenses (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_licenses_plan_status
    ON licenses (plan_code, status);

CREATE INDEX IF NOT EXISTS idx_license_events_created_id
    ON license_events (created_at DESC, id DESC);
```

### 4.3 Stable Keyset Cursor Pagination Query (`created_desc`)
Fetch `limit + 1` rows using parameterized D1 bindings (never string interpolation):
```sql
SELECT id, key_prefix, plan_code, plan_name, license_type, billing_interval,
       status, device_limit, active_devices_count, issued_at, activated_at,
       current_period_start, current_period_end, expires_at, cancel_at_period_end,
       updates_until, max_app_version, entitlements_json,
       customer_email, customer_name, external_order_id, created_at, updated_at
FROM licenses
WHERE (?1 IS NULL OR status = ?1)
  AND (?2 IS NULL OR license_type = ?2)
  AND (?3 IS NULL OR plan_code = ?3)
  AND (?4 IS NULL OR (
        id = ?4 OR key_prefix LIKE ?5 OR customer_email LIKE ?5
        OR customer_name LIKE ?5 OR external_order_id LIKE ?5
      ))
  AND (?6 IS NULL OR (created_at < ?6 OR (created_at = ?6 AND id < ?7)))
ORDER BY created_at DESC, id DESC
LIMIT ?8;
```
- If `rows.length > limit`, slice to `limit`, set `has_more = true`, and encode `next_cursor` from the last returned row's `(created_at, id)`.
- Product filter (`product = 'vectorizer_extension'`): filter via SQLite `json_extract` or `EXISTS (SELECT 1 FROM json_each(entitlements_json, '$.products') WHERE value = ?)` (supported in D1 SQLite JSON1).
- Invalid or mismatched-sort cursors fail cleanly with `HTTP 400 INVALID_REQUEST`.

---

## 5. UI Navigation & Screen Specifications (8 Required Modules)

| # | Module / Route | Key Capabilities |
|---:|---|---|
| 1 | **Dashboard & Statistics** (`/`) | KPI cards (Total, Active, Pending, Suspended, Revoked, Expiring <7d, Active Devices), environment badge (`PRODUCTION` / `STAGING`), quick actions (Issue License, Search), recent audit events feed. |
| 2 | **License Registry** (`/licenses`) | Search bar (`id`, `key_prefix`, email, name, order ID), filter pills (`status`, `license_type`, `plan_code`, `product`), sort selector, cursor pagination (`Next` / `Previous` stack), clean table showing status badges, product chips (`Desktop`, `Extension`), and `devices_used / device_limit`. |
| 3 | **Issue New License** (`/licenses/new`) | Guided form for Perpetual (`lifetime`) vs Subscription (`monthly`/`yearly` with period pickers), product entitlement toggles (`desktop`, `vectorizer_extension`), `device_limit` (`1`–`100`), customer metadata, auto-generated `Idempotency-Key`. On `HTTP 201`, opens the **One-Time Key Handoff Modal** (copy with 30s auto-clear OR save encrypted `.enc.json` vault). |
| 4 | **License Details** (`/licenses/:id`) | Full license metadata, inline `PATCH` editor for `device_limit`, `entitlements.products`, `customer_email`, `customer_name`, `notes`, billing subscription summary, linked devices tab, and per-license audit trail. |
| 5 | **Device Management** (Tab inside License Details) | Lists all `activations` (`activation_id`, `device_name`, `app_version`, `status`, `activated_at`, `last_validated_at`, `deactivated_at`), with **Force Deactivate** button (confirmation modal → `DELETE .../devices/:activation_id`) to free lost-PC slots. |
| 6 | **Lifecycle Actions** (Action Bar on License Details) | **Suspend** (reason required), **Reinstate** (disabled for `revoked`), **Renew** (subscriptions only, requires `external_payment_id` + new period dates), **Revoke Permanently** (red danger modal requiring typing exact `key_prefix` + `reason`). |
| 7 | **Audit Log** (`/audit`) | Global cursor-paginated feed of `license_events` filterable by `event_type`, `actor_type`, `license_id`, and date range; read-only JSON metadata viewer. |
| 8 | **Admin Security Settings** (`/settings`) | Active admin principal (`GET /v1/admin/me` — role, key prefix, IP allowlist status), environment switcher (`Production` vs `Staging`), Windows Credential Manager lock/forget controls, idle auto-lock timeout (`5`/`15`/`30` min), and encrypted backup export directory setting. |

---

## 6. Admin Credential Lifecycle

1. **First-Time Unlock:** Owner enters `ssadm_...` via masked password input → Rust backend validates against `GET /v1/admin/me` → if valid, stores in Windows Credential Manager (`StockStudioPro-LicenseManager-Admin` / `prod-admin-key`) and keeps an in-memory `Zeroizing<String>` copy for the active session.
2. **Subsequent Launches:** App starts **Locked**; owner unlocks via Windows Hello / OS user session or local unlock confirmation, loading the key from Windows Credential Manager into Rust memory.
3. **Idle Auto-Lock & Manual Lock:** After `N` minutes of inactivity (default 15m) or clicking **Lock**, Rust drops and zeroizes the in-memory key and returns the UI to the Lock screen.
4. **Forget / Rotate Key:** Settings → **Remove Stored Admin Key** deletes the Windows Credential Manager entry immediately.

---

## 7. Raw License Key Issuance & Recovery Flow

1. **Issuance:** Rust calls `POST /v1/admin/licenses` → receives `license_key` once (`HTTP 201`).
2. **One-Time Display / Delivery:** Rust passes `license_key` in the one-time command return payload ONLY; UI displays it masked by default (`Click to reveal`) with two safe actions:
   - **Copy to Clipboard** (Rust copies and schedules automatic clipboard clear after 30 seconds).
   - **Save Encrypted Customer Vault** (optional local `scrypt + AES-256-GCM` `.enc.json` outside the repo with `icacls` NTFS ACL).
3. **Dismissal:** Closing the modal requires checking *"I have delivered or securely stored this key — I understand it cannot be retrieved again"*, then immediately clears React state.
4. **Lost Customer Key Recovery:** Because D1 never stores plaintext keys, the License Details screen provides a guided **"Replace Lost Key"** workflow (Revoke old `license_id` with reason `"Lost key replacement"` → pre-fill Issue form with identical customer/plan/entitlements).

---

## 8. Audit Logging Strategy

- **Server-Side Authoritative Trail:** Every admin mutation (`issue`, `update`, `suspend`, `reinstate`, `renew`, `revoke`, `force_deactivate`) already writes an immutable row to `license_events` with `actor_type = 'admin'`, `actor_id = admin.id`, `previous_status`, `new_status`, `ip_hash`, and `metadata_json`.
- **Client-Side Local Logs:** Rust backend logs only non-secret operational diagnostics (HTTP status, `X-Request-Id`, latency, endpoint path) — **never** `Authorization` headers, `license_key`, `ssadm_`, or passphrases.

---

## 9. Testing Strategy

1. **Worker API Unit & Integration Tests (`workers/license-api/tests/`):** Vitest + Miniflare D1 tests covering `GET /v1/admin/me`, `GET /v1/admin/licenses` (search, status/plan/product filters, cursor stability across inserts, RBAC enforcement, zero `key_hash` leakage), `GET /v1/admin/stats`, and `GET /v1/admin/events`.
2. **Rust Backend Unit Tests (`apps/license-manager/src-tauri/`):** Credential storage abstraction tests, `Zeroizing` drop/lock tests, header redaction tests, and mocked HTTP Admin API client tests.
3. **Staging End-to-End Verification:** Point License Manager exclusively at `https://stockstudio-pro-license-staging.pages.dev` using the staging admin key to test all 8 screens before ever unlocking against production.
4. **Security Regression Checks:** Static grep/CI test confirming zero `ssadm_` or `Authorization` references in the React frontend (`src/`) and zero customer `StockStudioPro` keyring service references.

---

## 10. Implementation Milestones (`LM-02` through `LM-07`)

| Milestone | Scope | Key Files Created / Modified |
|---|---|---|
| **LM-02: Admin Read API & D1 Indexes** | Add `0002_admin_listing_indexes.sql`, implement `GET /v1/admin/me`, `GET /v1/admin/licenses` (cursor pagination + filters), `GET /v1/admin/stats`, `GET /v1/admin/events`, plus full Vitest coverage; deploy to **staging** first. | `workers/license-api/migrations/0002_admin_listing_indexes.sql` (new), `workers/license-api/src/index.ts`, `workers/license-api/src/admin-handlers.ts`, `workers/license-api/tests/license-api.test.ts` |
| **LM-03: Private Tauri v2 App Scaffold & Rust Security Core** | Scaffold standalone `apps/license-manager/` (Tauri v2 + Rust + React + Tailwind), implement isolated Windows Credential Manager (`StockStudioPro-LicenseManager-Admin`), `Zeroizing` session lock, `reqwest` Admin API client, and `GET /v1/admin/me` unlock flow. | `apps/license-manager/` (new isolated directory; zero changes to customer `src-tauri/` or `src/`) |
| **LM-04: Dashboard, Registry & License Details UI** | Implement Modules 1 (Dashboard & Stats), 2 (License Registry with search/filter/cursor pagination), and 4 (License Details + inline `PATCH` entitlements/device limit). | `apps/license-manager/src/pages/*`, `apps/license-manager/src-tauri/src/commands.rs` |
| **LM-05: Issuance, Device Management & Lifecycle Actions** | Implement Modules 3 (Issue New License + One-Time Key Handoff Modal + clipboard auto-clear + optional encrypted export), 5 (Device Management / Force Deactivate), and 6 (Suspend / Reinstate / Renew / Revoke with typed confirmations). | `apps/license-manager/src/components/*`, `apps/license-manager/src-tauri/src/vault.rs` |
| **LM-06: Global Audit Log, Security Settings & Staging E2E** | Implement Modules 7 (Audit Log) and 8 (Admin Security Settings, RBAC UI gating, idle auto-lock), run full end-to-end validation against `https://stockstudio-pro-license-staging.pages.dev`. | `apps/license-manager/src/pages/AuditLog.tsx`, `Settings.tsx`, E2E test report |
| **LM-07: Production Migration, Worker Deploy & Private Build** | Apply additive `0002_admin_listing_indexes.sql` to production D1, deploy updated Worker to `--env production`, build private local Windows executable of License Manager (never uploaded to public GitHub Releases), and run read-only production verification. | Production D1 migration + Worker deploy + private local build only |

---

## 11. Exact Files Requiring Modification (Summary)

- **Existing Repo Files (LM-02 only — strictly additive, backward-compatible):**
  - `workers/license-api/migrations/0002_admin_listing_indexes.sql` *(new)*
  - `workers/license-api/src/index.ts` *(add 4 read-only `/v1/admin/*` routes)*
  - `workers/license-api/src/admin-handlers.ts` *(add 4 read-only admin handlers)*
  - `workers/license-api/tests/license-api.test.ts` *(add tests for list/pagination/stats/events/me)*
- **New Private App Directory (LM-03–LM-06):**
  - `apps/license-manager/*` *(completely isolated from customer Desktop `src-tauri/`, `src/`, `chrome-extension/`, and public `.github/workflows/release.yml`)*
- **Customer Desktop, Chrome Extension & Release Pipeline:** **ZERO modifications required.**
