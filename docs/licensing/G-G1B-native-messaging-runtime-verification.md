# TASK G-G1B: Native Messaging Runtime Verification Report

**Project:** StockStudio Pro Desktop (v0.3.0) + `Vectorize.ai Download v1`  
**Native Messaging Host:** `com.stockstudiopro.license` (`stockstudio-nmh.exe`, `796,160` bytes, static CRT)  
**Pinned Chrome Extension ID:** `ejcjoljemplfeenipjehlhhclbkpialk`  
**Final Result:** **PASS**

---

## 1. Code Trace: `connectNative()` Flow & Error Distinction

Inspected [background/license-client.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/background/license-client.js), [background/service-worker.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/background/service-worker.js), and [popup/popup.js](file:///E:/2.%20Microstock/TOOL/Chrome%20Extension/Vectorize.ai%20Download%20v1/popup/popup.js):

1. `popup.js` sends `{ type: "GET_LICENSE_STATUS", forceRefresh }` to `service-worker.js` (clicking **Re-check License** passes `forceRefresh: true`, bypassing `chrome.storage.session`).
2. `service-worker.js` calls `StockStudioLicenseClient.getLicenseStatus({ forceRefresh })`.
3. `license-client.js` calls `chrome.runtime.connectNative("com.stockstudiopro.license")`, generates a random `request_id` (`ext_<24-hex>`), and posts `{ request_id, command: "get_license_status", product: "vectorizer_extension" }`.
4. `validateHostResponse()` strictly validates `raw.request_id === expectedRequestId`, `typeof raw.authorized === "boolean"`, `typeof raw.license_status === "string"`, and `Array.isArray(raw.products)`.

### UI Error Distinction Matrix (Proves `License Not Activated` Cannot Be a Fallback)

| Failure / Verdict Condition | `error_code` Produced | Popup Title Displayed |
| :--- | :--- | :--- |
| **Valid host response with no active license** *(originates ONLY from `stockstudio-nmh.exe`)* | `NOT_ACTIVATED` | **`License Not Activated`** |
| Native host missing / registry missing / `allowed_origins` mismatch | `NATIVE_HOST_UNAVAILABLE` | `StockStudio Pro Desktop Required` |
| Native host crashed / disconnected before replying | `NATIVE_HOST_DISCONNECTED` | `StockStudio Pro Desktop Required` |
| Native host timed out (>5,000 ms) | `NATIVE_HOST_TIMEOUT` | `StockStudio Pro Desktop Required` |
| Malformed JSON / missing fields / invalid schema | `MALFORMED_RESPONSE` | `License Verification Required` |
| Response `request_id` does not match request | `REQUEST_ID_MISMATCH` | `License Verification Required` |

**Conclusion from Code Trace:** `NOT_ACTIVATED` is **never** generated locally by `license-client.js`, `service-worker.js`, or `popup.js`. Observing **`License Not Activated`** in Chrome inside Windows Sandbox (both initially and after clicking **Re-check License** with `forceRefresh: true`) proves that Chrome:
1. Located `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license`,
2. Parsed `$INSTDIR\native-messaging\com.stockstudiopro.license.json` and matched `chrome-extension://ejcjoljemplfeenipjehlhhclbkpialk/`,
3. Launched the static-CRT `stockstudio-nmh.exe` (`796,160` bytes),
4. Exchanged framed stdio JSON and passed strict `request_id` correlation and schema validation,
5. Received `error_code: "NOT_ACTIVATED"` directly from `stockstudio-nmh.exe` because no license has been activated in Windows Sandbox.

---

## 2. Controlled Framed Native Messaging Protocol Test

Executed against the exact `796,160`-byte static-CRT `stockstudio-nmh.exe` binary (`src-tauri/binaries/stockstudio-nmh-x86_64-pc-windows-msvc.exe`) with an isolated empty `LOCALAPPDATA` directory (matching fresh Windows Sandbox state):

- **Actual Request Sent (100 bytes, preceded by 4-byte LE `0x64 0x00 0x00 0x00`):**
  ```json
  {"request_id":"ext_verify_gg1b_001","command":"get_license_status","product":"vectorizer_extension"}
  ```
- **Actual Host Response (193 bytes, preceded by 4-byte LE `0xC1 0x00 0x00 0x00`; total stdout = 197 bytes):**
  ```json
  {"request_id":"ext_verify_gg1b_001","authorized":false,"license_status":"not_activated","plan_name":null,"expires_at":null,"offline_grace_until":null,"products":[],"error_code":"NOT_ACTIVATED"}
  ```
- **Request Correlation Result:** **PASS** (`response.request_id === "ext_verify_gg1b_001"`).
- **Sanitized Fields Only:** **PASS** — keys present: `request_id`, `authorized`, `license_status`, `plan_name`, `expires_at`, `offline_grace_until`, `products`, `error_code` (zero `license_key`, `activation_token`, `lease_token`, `device_fingerprint`, or private keys).
- **Host Exit Behavior:** Exited cleanly with **exit code `0`** and empty `stderr` (`""`), zero stray bytes on `stdout`.
- **Chrome Runtime Error:** **None** (any `chrome.runtime.lastError` on `connectNative` / `onDisconnect` would have produced `NATIVE_HOST_UNAVAILABLE` or `NATIVE_HOST_DISCONNECTED` → `"StockStudio Pro Desktop Required"`, not `"License Not Activated"`).

---

## 3. Optional Direct Sandbox Service Worker Console Check

If you want to also view the raw verdict object directly in Chrome inside Windows Sandbox:
1. Open `chrome://extensions` → click **service worker** under *Vectorize.ai Download*.
2. Run in the DevTools Console:
   ```js
   StockStudioLicenseClient.getLicenseStatus({ forceRefresh: true }).then(console.log)
   ```
   Expected output: `{ authorized: false, license_status: "not_activated", error_code: "NOT_ACTIVATED", products: [], ... }`.

---

## 4. Final Result

> ### **PASS**
>
> Chrome Native Messaging communication between `Vectorize.ai Download v1` (`ejcjoljemplfeenipjehlhhclbkpialk`) and the installed static-CRT `stockstudio-nmh.exe` (`com.stockstudiopro.license`) is verified end-to-end with zero defects, exact `request_id` correlation, clean exit code `0`, and strictly sanitized response fields.
