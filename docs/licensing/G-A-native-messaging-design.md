# TASK G-A: Chrome Native Messaging Design Specification
## StockStudio Pro Desktop ↔ Vectorize.ai Download Chrome Extension

**Status:** Architecture Design (No code or registry modified)  
**Host Name:** `com.stockstudiopro.license_bridge`  
**Recommended Host Binary:** Dedicated lightweight Rust executable `stockstudio-nmh.exe` bundled alongside `stockstudio-pro.exe` in the NSIS installer.

---

## 1. Host Architecture Evaluation

| Option | Pros | Cons | Verdict |
| :--- | :--- | :--- | :--- |
| **A. Dedicated Lightweight Rust Helper (`stockstudio-nmh.exe`) bundled with StockStudio Pro** | • Fast cold start (<30 ms), small footprint (~2–4 MB).<br>• Strict `stdin`/`stdout` binary framing with zero WebView2/GUI stdout pollution.<br>• Works even when StockStudio Pro Desktop GUI is closed.<br>• Shares `stockstudio-license-core` Rust crate with `license_store.rs` (single source of truth for Ed25519 + Credential Manager + 7-day offline grace).<br>• Bundled and auto-updated automatically via existing Tauri NSIS installer & updater. | • Adds one Cargo binary target (`[[bin]] name = "stockstudio-nmh"`) and ~10 lines in `installer-hooks.nsh`. | **RECOMMENDED** |
| **B. Reusing Main Tauri GUI Binary (`stockstudio-pro.exe --nmh`)** | • Single `.exe` on disk. | • Heavy binary startup; Tauri/WebView2 runtime initialization risks writing stray logs to `stdout` (which immediately corrupts Chrome Native Messaging's 4-byte length framing).<br>• Harder to audit and isolate minimal privileges. | Not recommended |
| **C. Localhost HTTP Server inside Desktop App** | • Works without registry registration. | • Fails whenever Desktop GUI is closed.<br>• Exposes a localhost port accessible to any local process or malicious web page (CSRF/DNS rebinding risks).<br>• Requires CORS/auth token bootstrapping in extension. | Rejected |

---

## 2. Windows Registration & Host Manifest

### Windows Registry Key (Per-User, No Admin Elevation Required)
Registered during NSIS `NSIS_HOOK_POSTINSTALL` (and cleaned up on full uninstall in `NSIS_HOOK_PREUNINSTALL` when `$UpdateMode <> 1`):
- **Google Chrome:**  
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license_bridge`  
  Default `(REG_SZ)` value: `$INSTDIR\native-messaging\com.stockstudiopro.license_bridge.json`
- **Optional Chromium-based Browsers (same manifest file):**  
  - Edge: `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.stockstudiopro.license_bridge`
  - Brave: `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.stockstudiopro.license_bridge`

### Host Manifest (`com.stockstudiopro.license_bridge.json`)
```json
{
  "name": "com.stockstudiopro.license_bridge",
  "description": "StockStudio Pro Unified License Verification Bridge",
  "path": "C:\\Users\\<User>\\AppData\\Local\\StockStudio Pro\\stockstudio-nmh.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<PINNED_32_CHAR_EXTENSION_ID>/"
  ]
}
```
> **NSIS Path Generation:** Because `$INSTDIR` can vary per user, `installer-hooks.nsh` writes `com.stockstudiopro.license_bridge.json` at install time with the exact escaped `$INSTDIR\stockstudio-nmh.exe` path.

### Chrome Extension ID Pinning (Mandatory Technical Prerequisite)
- Chrome strictly enforces `allowed_origins` with an exact 32-character extension ID (`chrome-extension://<id>/`); wildcards are forbidden.
- Currently, `Vectorize.ai Download v1\manifest.json` has **no `"key"` field** and is loaded unpacked, meaning Chrome generates a different ID based on the folder path on each machine.
- **Resolution:** Generate a fixed RSA-2048 extension keypair and embed the public key in `manifest.json` (`"key": "<base64_der_spki>"`) — or publish to the Chrome Web Store — so the extension ID is 100% deterministic across all installations, reinstalls, and updates.

---

## 3. Native Messaging Wire Protocol

### Framing & Size Limits
- Chrome Native Messaging uses a **4-byte native-endian (little-endian on Windows x64) `u32` length prefix** followed by UTF-8 JSON bytes on `stdin` (Chrome → Host) and `stdout` (Host → Chrome).
- **Hard Limits:** Host → Extension max message size is **1 MB** (1,048,576 bytes). Our responses are <1 KB. Host must also enforce a defensive inbound cap (e.g., reject >64 KB on `stdin`) to prevent memory abuse.
- **Logging Discipline:** `stockstudio-nmh.exe` must **never** print anything to `stdout` except framed JSON responses. Diagnostics go strictly to `stderr` (or nowhere in release).

### Request Schema (Extension → Host)
```json
{
  "protocol_version": 1,
  "request_id": "req_01J...",
  "nonce": "9f86d081884c7d659a2feaa0c55ad015",
  "action": "check_entitlement",
  "product": "vectorizer_extension",
  "extension_version": "1.0.0",
  "force_refresh": false
}
```
Supported actions:
1. `check_entitlement` — Verifies current device license and returns sanitized authorization verdict. Uses local Ed25519 lease if fresh (<12 hours old) unless `force_refresh: true`; triggers online `/v1/licenses/validate` if stale, with automatic 7-day offline grace fallback on transient network/5xx errors.
2. `ping` — Health check returning host version and whether StockStudio Pro Desktop is installed/activated.

### Response Schema (Host → Extension)
```json
{
  "protocol_version": 1,
  "request_id": "req_01J...",
  "nonce": "9f86d081884c7d659a2feaa0c55ad015",
  "ok": true,
  "authorized": true,
  "product": "vectorizer_extension",
  "license_status": "active",
  "license_type": "perpetual",
  "plan_name": "Lifetime",
  "expires_at": null,
  "offline_grace_until": "2026-11-28T14:00:00Z",
  "is_offline_grace": false,
  "checked_at": "2026-11-21T14:00:00Z",
  "cache_ttl_seconds": 600,
  "error_code": null,
  "error_message": null
}
```

### Error Codes (Deterministic UX Mapping)
| `error_code` | `authorized` | Extension UX Behavior |
| :--- | :--- | :--- |
| `DESKTOP_NOT_INSTALLED` (Chrome `runtime.lastError`: native host not found) | `false` | Prompt user to install StockStudio Pro Desktop. |
| `NOT_ACTIVATED` | `false` | Prompt user to open StockStudio Pro Desktop and activate their license key. |
| `PRODUCT_NOT_ENTITLED` | `false` | Explain that current license plan does not include `vectorizer_extension`. |
| `LICENSE_REVOKED` / `LICENSE_SUSPENDED` / `LICENSE_EXPIRED` / `ACTIVATION_REVOKED` | `false` | Lock extension features immediately; clear in-memory/session verdict. |
| `OFFLINE_GRACE_EXPIRED` / `CLOCK_ROLLBACK_DETECTED` | `false` | Prompt user to reconnect to internet and refresh in StockStudio Pro Desktop. |
| `DEVICE_MISMATCH` / `INVALID_SIGNATURE` | `false` | Lock extension features; prompt reactivation in Desktop. |

---

## 4. Process Lifecycle & Edge Cases

1. **Short-Lived One-Shot (`chrome.runtime.sendNativeMessage`):**
   - Recommended over persistent `connectNative` ports because MV3 service workers terminate after ~30 seconds of idle time.
   - Each `sendNativeMessage` spawns `stockstudio-nmh.exe`, reads 1 request, writes 1 response, and exits cleanly in <50 ms (local) or <1–8 s (online refresh). Zero orphaned background processes.
2. **Desktop Not Running Scenario:**
   - Handled natively! `stockstudio-nmh.exe` reads Windows Credential Manager (`StockStudioPro/*`) and `%LOCALAPPDATA%\com.stockstudiopro.desktop\license-state.json` directly.
   - **File Locking / Atomic Writes:** `license-state.json` writes in `stockstudio-license-core` must use write-to-temp + atomic rename so concurrent Desktop and NMH refreshes never corrupt the file.
3. **Multiple Chrome Profiles (Same Windows User):**
   - All Chrome profiles under the same Windows user share `HKCU`, Windows Credential Manager, and `%LOCALAPPDATA%`. All profiles resolve to the **same single device activation** with zero extra device slots consumed.
4. **Multiple Windows Users (Same PC):**
   - Each Windows user has isolated `HKCU`, isolated DPAPI Credential Manager vault, and isolated `%LOCALAPPDATA%`. One Windows user cannot read another user's license credentials.
5. **Extension Reinstall / Update:**
   - Because the extension ID is pinned via `manifest.json` `"key"` (or CWS), reinstalling or updating the extension preserves the exact `allowed_origins` match. No re-registration of the native host is required.
6. **Desktop Auto-Update (Tauri Updater):**
   - NSIS runs in update mode (`$UpdateMode = 1`), overwriting `stockstudio-nmh.exe` in `$INSTDIR` while keeping `HKCU` registry and `%LOCALAPPDATA%` credentials intact.
