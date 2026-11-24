# TASK G-G2.4: Production Licensing Smoke Test Report

**Project:** StockStudio Pro Unified Licensing (`0.2.0`)  
**Production Endpoint Tested:** `https://stockstudio-pro-license-api-prod.dekadk00.workers.dev`  
**Production D1:** `stockstudio-pro-licenses-prod` (`e2356bb7-53dc-4412-b7f4-2c255115d6bd`, APAC/SIN)  
**Smoke Test Timestamp:** `2026-11-21T21:57:30Z`  
**Final Verdict:** **`READY WITH LIMITATIONS`**

---

## 1. Production Smoke Test Results (9 / 9 PASS)

Executed against the live production Worker and D1 database using the operator-local in-memory decrypted Super Admin Key (zero secrets written to disk or printed to logs):

| # | Smoke Test Check | Result | Verified Production Flow |
| --- | :--- | :---: | :--- |
| 1 | Production `/v1/health` | **PASS** | `HTTP 200 OK`, `ok: true`, `signing_kid: "sspro-ed25519-prod-01"`, `public_key_base64: "uy1Hyu3NEm9K1SLIdh2P7CEckfAjKBC8/Cn334jygjc="` (matches `EMBEDDED_PROD_VERIFYING_KEYS` in `config.rs`). |
| 2 | Admin auth & unified test license creation | **PASS** | Authenticated with `super_admin` (`ssadm_01M7ZJCTYH`); created `lic_01M801THQGHD6052YBXF5FH77B` (`SSPRO-JN7R`) with `products: ["desktop", "vectorizer_extension"]`, `features: []`. |
| 3 | Live activation (`POST /v1/licenses/activate`) | **PASS** | `HTTP 200 OK`; created `act_01M801TJ95R7VCPGN3JSDXX3M0` and issued signed Ed25519 lease token. |
| 4 | Live validation (`POST /v1/licenses/validate`) | **PASS** | `HTTP 200 OK`; validated active session and returned refreshed signed Ed25519 lease token. |
| 5 | Signed offline lease verification | **PASS** | Verified Ed25519 signature against embedded prod public key `uy1Hyu3NEm9K1SLIdh2P7CEckfAjKBC8/Cn334jygjc=`, `kid == sspro-ed25519-prod-01`, `iss`, `aud`, device binding, and 7-day offline grace TTL. |
| 6 | Desktop entitlement | **PASS** | Verified `entitlements.products` includes `"desktop"`. |
| 7 | Chrome Extension entitlement (`getLicenseStatus()`) | **PASS** | Verified `background/license-client.js` (`clearMemoryCache()` + `getLicenseStatus({ chromeApi, forceRefresh: true })`) returned `authorized: true` for `vectorizer_extension`. |
| 8 | Client deactivation (`POST /v1/licenses/deactivate`) | **PASS** | `HTTP 200 OK`; `devices_used == 0`, activation marked `deactivated` (`client_requested_deactivation`). |
| 9 | Admin revocation & post-revoke deny | **PASS** | `POST /v1/admin/licenses/lic_01M801THQGHD6052YBXF5FH77B/revoke` returned `200 OK` (`status: "revoked"`); subsequent `POST /v1/licenses/activate` failed closed with `403 LICENSE_REVOKED`. |

---

## 2. Independent Production D1 Cleanup Verification (Read-Only)

Independently queried remote production D1 (`stockstudio-pro-licenses-prod`, APAC/SIN) after smoke test completion:

| # | D1 Cleanup Verification | Result | Evidence |
| --- | :--- | :---: | :--- |
| 1 | Latest G-G2.4 test license located | **PASS** | `lic_01M801THQGHD6052YBXF5FH77B` (`SSPRO-JN7R`, `plan_code: gg24_smoke_unified`). |
| 2 | Latest test license status is `revoked` | **PASS** | `status = "revoked"`, `revoked_at = "2026-11-21T21:57:30Z"`, `revocation_reason = "G-G2.4 temporary smoke test cleanup"`. |
| 3 | Latest test activation is deactivated/revoked | **PASS** | `act_01M801TJ95R7VCPGN3JSDXX3M0`: `status = "deactivated"`, `deactivated_at = "2026-11-21T21:57:30Z"`, `deactivation_reason = "client_requested_deactivation"`. |
| 4 | `active_devices_count = 0` | **PASS** | `0` on both `lic_01M801THQGHD6052YBXF5FH77B` and prior run's `lic_01M801F7TPD6K62X480YB2N3GF`. |
| 5 | No active G-G2.4 test licenses remain | **PASS** | All `licenses` rows (`2/2`) are `status = "revoked"`. |
| 6 | No active G-G2.4 test devices remain | **PASS** | All `activations` rows (`2/2`) are non-active (`1` `revoked`, `1` `deactivated`). |
| 7 | Unrelated production records untouched | **PASS** | `signing_keys`: `sspro-ed25519-prod-01` (`active`, matching public key). `admin_api_keys`: `adm_01M7ZJCTYHMZ5WPFX6RWFK9SRE` (`ssadm_01M7ZJCTYH`, `super_admin`, `active`). |

### Cleanup Note
- Both G-G2.4 smoke-test licenses (`lic_01M801F7TPD6K62X480YB2N3GF` from the first run and `lic_01M801THQGHD6052YBXF5FH77B` from the retry) remain stored as `revoked` with `active_devices_count = 0` because the License API intentionally provides no `DELETE /v1/admin/licenses` endpoint in order to preserve immutable `license_events` audit history.

---

## 3. Remaining Limitations (Why `READY WITH LIMITATIONS`)

1. **ISP DNS Blocking of `*.workers.dev`:** Local Indonesian ISP (`xlaxiata.id`) redirects `*.workers.dev` to `blockpage.xlaxiata.id`. Attaching a custom HTTPS domain to `[env.production]` is recommended before broad Indonesian public release.
2. **External Chrome Extension Path in CI:** `.github/workflows/release.yml` Gates 5 & 6 require the Chrome Extension source at `chrome-extension/vectorize-ai-download` or `vars.STOCKSTUDIO_EXTENSION_DIR` on GitHub Actions runners.
3. **Deferred Scope:** Windows Authenticode code signing and billing webhooks remain deferred to a later release phase.
4. **Pending Git Commit / Release Build:** G-G2.1–G-G2.4 changes remain uncommitted locally (per strict task restrictions) until you review, commit, and trigger the release workflow.

---

## 4. Safety Restrictions Confirmation

- Zero secrets, keys, tokens, or passphrases exposed in logs, reports, or chat.
- No bootstrap rerun, no secret/key rotation, no staging changes, no billing transactions, no deployment, no Git commit or push occurred.
