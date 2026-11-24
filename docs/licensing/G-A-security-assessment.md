# TASK G-A: Unified Licensing Security Assessment

**Status:** Architecture Security Audit (No code modified)  
**Trust Model:** Zero-Trust Browser Extension / Trusted Native Rust Verification Boundary

---

## 1. Strict Secret Isolation Rules

The Chrome Extension runs inside a browser JavaScript environment where any user with DevTools can inspect memory, `chrome.storage`, and source files. Therefore, **the extension must never receive, request, or store**:

- Ed25519 private signing keys (server-only in Cloudflare Secrets).
- Admin API tokens or `ADMIN_TOKEN_PEPPER` (server-only).
- `LICENSE_KEY_PEPPER` (server-only).
- Raw `license_key` (`SSPRO-...`) — stored exclusively in Windows Credential Manager (`StockStudioPro / license-key`).
- Raw `activation_token` (`ssact_...`) — stored exclusively in Windows Credential Manager (`StockStudioPro / activation-token`).
- Raw `device_fingerprint` or `MachineGuid` — computed and verified inside native Rust only.
- Raw `lease_token` — verified inside `stockstudio-nmh.exe` (Rust `ed25519-dalek`), never handed to the extension.

**What the extension receives:** Only the minimal boolean verdict (`authorized`), non-sensitive display metadata (`license_status`, `license_type`, `plan_name`, `expires_at`, `offline_grace_until`, `is_offline_grace`), and correlation fields (`request_id`, `nonce`, `checked_at`, `cache_ttl_seconds`).

---

## 2. Threat Model & Mitigations

| Threat | Attack Vector | Mitigation |
| :--- | :--- | :--- |
| **1. Unauthorized Extension Calling Native Host** | Another malicious Chrome extension attempts to call `com.stockstudiopro.license_bridge`. | Chrome enforces `allowed_origins` in `com.stockstudiopro.license_bridge.json`, strictly pinned to the single exact `chrome-extension://<PINNED_ID>/`. Chrome refuses to launch the host for any other origin. Additionally, `stockstudio-nmh.exe` validates `argv[1]` (Chrome passes the caller origin on Windows) against the compiled-in expected extension origin. |
| **2. Extension Storage Tampering (`chrome.storage.local`)** | User edits `chrome.storage.local` via DevTools to set `authorized = true`. | Extension **never** persists authorization state in `chrome.storage.local`. Verdict is held only in volatile service-worker memory / `chrome.storage.session` with a short TTL (e.g., 10 minutes) and re-verified against `stockstudio-nmh.exe` on every worker startup and before batch operations. |
| **3. Local Replay / Spoofed Response** | Intercepting or replaying an old `authorized: true` JSON response. | Every request includes a fresh 128-bit CSPRNG `nonce` and `request_id`. The extension rejects any response where `response.nonce !== request.nonce`, `response.request_id !== request.request_id`, or `checked_at` is skewed beyond ±60 seconds. |
| **4. License Revocation / Suspension / Expiration** | Admin revokes or suspends a license, or subscription expires, while user continues using the extension. | `stockstudio-nmh.exe` triggers online `/v1/licenses/validate` whenever the local lease is older than the refresh threshold (e.g., 12 hours) or on `force_refresh`. On any terminal server error (`401`/`403`), `stockstudio-license-core` immediately wipes `activation-token`, `license-key`, and `license-state.json`, revoking **both** Desktop and Extension simultaneously. |
| **5. Clock Rollback to Extend 7-Day Offline Grace** | User rolls back Windows system clock while offline. | `stockstudio-nmh.exe` enforces the exact same dual clock-rollback guard as `license_store.rs`: compares `Utc::now()` against both `lease.iat` and Windows Credential Manager `StockStudioPro / clock-anchor` (5-minute tolerance), and enforces `OFFLINE_GRACE_MAX_SECONDS = 7 days` plus subscription `expires_at`. |
| **6. Cross-User Credential Leakage on Shared Windows PC** | Windows User B tries to use Windows User A's license. | Native Messaging registration uses `HKCU`, credentials use per-user Windows Credential Manager (DPAPI), and `license-state.json` resides in per-user `%LOCALAPPDATA%`. OS ACLs isolate each Windows user account. |
| **7. Local Extension JS Patching (Residual Risk)** | Determined user unpacks and modifies the extension's own JavaScript to bypass the `if (!authorized)` check. | Inherent to all client-side browser extensions (JavaScript is readable by the local machine owner). Mitigated by: (a) distributing signed Chrome Web Store / CRX builds where Chrome detects tampering, (b) keeping all cryptographic secrets out of the extension so tampering cannot forge licenses or compromise other users/backend, and (c) treating extension gating as honest-user ecosystem enforcement rather than DRM. |
| **8. Stdout Framing Corruption / Memory DoS** | Malformed or oversized message sent to `stockstudio-nmh.exe` on `stdin`. | `stockstudio-nmh.exe` rejects any incoming frame >64 KB before allocation, uses `serde_json` strict typed deserialization, and writes zero non-protocol output to `stdout`. |

---

## 3. Local IPC Trust Boundary Summary

- **Trusted Zone (Native Rust + OS Vault):** `stockstudio-pro.exe`, `stockstudio-nmh.exe`, `stockstudio-license-core`, Windows Credential Manager (`DPAPI`), `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json`.
- **Untrusted / Minimally Privileged Zone (Browser):** `Vectorize.ai Download v1` service worker, popup, content script, and injected script.
- **Boundary Contract:** Strictly one-way verdict query (`check_entitlement`) over OS-authenticated Chrome Native Messaging stdio pipe. Zero secrets cross from Trusted Zone to Browser Zone.
