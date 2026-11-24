# TASK G-G2.3: Production Release Wiring Report

**Project:** StockStudio Pro Unified Licensing (`0.2.0`)  
**Status:** **COMPLETE — ALL VERIFICATIONS PASSED**

---

## 1. Files Modified

| File | Purpose |
| --- | :--- |
| `src-tauri/crates/stockstudio-license-core/src/config.rs` | Populated `EMBEDDED_PROD_VERIFYING_KEYS` (`#[cfg(not(debug_assertions))]`) with `("sspro-ed25519-prod-01", "uy1Hyu3NEm9K1SLIdh2P7CEckfAjKBC8/Cn334jygjc=")`; preserved staging/dev keys untouched; added unit tests verifying staging isolation and release-mode 32-byte Ed25519 key validity. |
| `.github/workflows/release.yml` | Wired non-secret production env vars (`STOCKSTUDIO_LICENSE_API_URL`, `STOCKSTUDIO_EXTENSION_ID`) and added 4 fail-fast release gates before `tauri-apps/tauri-action@v0.6`. |
| `docs/licensing/G-G2.3-production-release-wiring-report.md` | This report. |

---

## 2. Production Configuration Wired

| Parameter | Wired Value | Location |
| --- | :--- | :--- |
| **Production API URL** | `https://stockstudio-pro-license-api-prod.dekadk00.workers.dev` | `.github/workflows/release.yml` (`STOCKSTUDIO_LICENSE_API_URL`) |
| **Production Extension ID** | `ejcjoljemplfeenipjehlhhclbkpialk` | `.github/workflows/release.yml` (`STOCKSTUDIO_EXTENSION_ID`) |
| **Production Ed25519 KID** | `sspro-ed25519-prod-01` | `src-tauri/crates/stockstudio-license-core/src/config.rs` (`EMBEDDED_PROD_VERIFYING_KEYS`) |
| **Production Ed25519 Public Key (Base64)** | `uy1Hyu3NEm9K1SLIdh2P7CEckfAjKBC8/Cn334jygjc=` | `src-tauri/crates/stockstudio-license-core/src/config.rs` (`EMBEDDED_PROD_VERIFYING_KEYS`) |

- **Zero private signing keys, admin tokens, or peppers** were added to `config.rs` or `.github/workflows/release.yml`.
- **Staging & development behavior preserved:** `DEFAULT_DEV_API_BASE_URL` and `EMBEDDED_DEV_VERIFYING_KEYS` (`sspro-ed25519-staging-01`) remain strictly under `#[cfg(debug_assertions)]`.
- **Tauri updater endpoint (`src-tauri/tauri.conf.json`) untouched.**

---

## 3. Release Gates Added to `.github/workflows/release.yml`

All gates run in the single `windows-latest` release job prior to `Build and publish release` (failing fast if any check fails, without duplicating runner setup):

1. **Gate 1 — Production Configuration Validation:** Validates `STOCKSTUDIO_LICENSE_API_URL` is HTTPS and rejects `staging`/`flowpilot`/`localhost`/`127.0.0.1`, validates `STOCKSTUDIO_EXTENSION_ID` is exact 32-char `[a-p]{32}`, and verifies `config.rs` embeds `sspro-ed25519-prod-01` + `uy1Hyu3NEm9K1SLIdh2P7CEckfAjKBC8/Cn334jygjc=`.
2. **Gate 2 — Frontend Typecheck:** `npm run typecheck`.
3. **Gate 3 — Rust Format & Workspace Tests (Debug + Release Prod-Key Verification):**
   - `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check`
   - `cargo test --manifest-path src-tauri/Cargo.toml --workspace`
   - `cargo test --release --manifest-path src-tauri/Cargo.toml -p stockstudio-license-core`
4. **Gate 4 — Worker API Typecheck & Test Suite:**
   - `npm --prefix workers/license-api run typecheck`
   - `npm --prefix workers/license-api test`
5. **Release Build Validation (`tauri-apps/tauri-action@v0.6`):** Runs `beforeBuildCommand` (`npm run build && node scripts/prepare-nmh-bundle.mjs`), which builds static-CRT `stockstudio-nmh.exe`, enforces zero dynamic VC++ CRT PE imports, pins `STOCKSTUDIO_EXTENSION_ID`, and compiles `STOCKSTUDIO_LICENSE_API_URL` into release binaries.

---

## 4. Exact Test Commands & Actual Results

| Command | Result | Actual Output |
| --- | :---: | :--- |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | **PASS** | Exited `0` |
| `cargo check --workspace --manifest-path src-tauri/Cargo.toml` | **PASS** | Exited `0` (0 warnings) |
| `cargo test --workspace --manifest-path src-tauri/Cargo.toml --quiet` | **PASS** | `49 passed, 0 failed` (`7` license-core + `5` nmh + `37` desktop) |
| `cargo test --release --manifest-path src-tauri/Cargo.toml -p stockstudio-license-core` | **PASS** | `8 passed, 0 failed` (including `config::tests::release_build_embeds_verified_production_ed25519_key` & `production_mode_never_inherits_staging_keys`) |
| `npm run typecheck` | **PASS** | `tsc --noEmit --incremental false` exited `0` |
| `npm run build` | **PASS** | Vite production bundle built (`1.52s`) |
| `npm --prefix workers/license-api run typecheck` | **PASS** | `tsc --noEmit` exited `0` |
| `npm --prefix workers/license-api test` | **PASS** | `2 passed` files, `18 passed` tests |
| `node scripts/test-extension-license-client.mjs` | **PASS** | `ALL_PHASE_4_EXTENSION_TESTS_PASSED` (`7/7`) |
| `node scripts/test-e2e-unified-licensing.mjs` | **PASS** | `ALL_TASK_GF_E2E_CHECKS_PASSED` |
| `.github/workflows/release.yml` YAML & env validation | **PASS** | No tabs; `STOCKSTUDIO_LICENSE_API_URL` & `STOCKSTUDIO_EXTENSION_ID` verified |

---

## 5. Remaining Blockers / Notes Before Public Release

1. **External Chrome Extension Repo in CI:** `scripts/test-extension-license-client.mjs` and `scripts/test-e2e-unified-licensing.mjs` reference `E:\2. Microstock\TOOL\Chrome Extension\Vectorize.ai Download v1` (outside this Git repository), so they pass locally but are not directly runnable on GitHub Actions `windows-latest` unless the extension is checked out alongside this repo in CI.
2. **Live Production End-to-End Smoke Test (G-G2.2 Checkpoint 3 Checks 5–9):** Operator-local smoke test with the vaulted Super Admin Key against `https://stockstudio-pro-license-api-prod.dekadk00.workers.dev` (create → activate → validate → offline lease → deactivate → revoke test license) remains pending before public launch.
3. **ISP DNS on `*.workers.dev`:** Local Indonesian ISP (`xlaxiata.id`) blocks `*.workers.dev`; attaching a custom HTTPS domain is recommended before public Indonesian distribution.

---

## 6. Restrictions Confirmation

- **No Git commit or push occurred** (`HEAD` remains `f398e57`).
- **No Worker deployment, production bootstrap, Cloudflare resource creation/modification, secret modification, signing key generation, GitHub Release publish, or customer transaction occurred.**

---

## 7. G-G2.3A Addendum — Completed Release Gates (Extension & Unified E2E)

### Additional Files Modified
- `.github/workflows/release.yml` — Added **Gate 5** and **Gate 6** directly before `Build and publish release` (`tauri-apps/tauri-action@v0.6`).
- `scripts/test-extension-license-client.mjs` — Added `process.env.STOCKSTUDIO_EXTENSION_DIR` override (preserving local default path).
- `scripts/test-e2e-unified-licensing.mjs` — Added `process.env.STOCKSTUDIO_EXTENSION_DIR` override (preserving local default path).

### Gates Added Before `tauri-apps/tauri-action@v0.6`
- **Gate 5 — Prepare static-CRT NMH & Chrome Extension build/license client tests:**
  - Runs `node scripts/prepare-nmh-bundle.mjs` (compiles static-CRT `stockstudio-nmh.exe` + PE import check).
  - Fails closed if `STOCKSTUDIO_EXTENSION_DIR` (`vars.STOCKSTUDIO_EXTENSION_DIR || 'chrome-extension/vectorize-ai-download'`) is missing.
  - Validates `manifest.json` JSON syntax and runs `node --check` on all 5 MV3 JS files (`background/license-client.js`, `background/service-worker.js`, `content/content.js`, `injected/inject.js`, `popup/popup.js`).
  - Runs `node scripts/test-extension-license-client.mjs`.
- **Gate 6 — Unified Licensing E2E test:**
  - Runs `node scripts/test-e2e-unified-licensing.mjs` (reusing the compiled `stockstudio-nmh.exe` from Gate 5 without duplicate build).

### Local Verification Results (G-G2.3A)

| Check | Result | Actual Output |
| --- | :---: | :--- |
| Extension `manifest.json` & 5 MV3 JS syntax checks (`node --check`) | **PASS** | `All 5 MV3 extension JS files & manifest.json validated OK` |
| `node scripts/test-extension-license-client.mjs` (with `STOCKSTUDIO_EXTENSION_DIR`) | **PASS** | `7/7`, `ALL_PHASE_4_EXTENSION_TESTS_PASSED` |
| `node scripts/test-e2e-unified-licensing.mjs` (with `STOCKSTUDIO_EXTENSION_DIR`) | **PASS** | `ALL_TASK_GF_E2E_CHECKS_PASSED` |
| `.github/workflows/release.yml` syntax & Gate 1–6 ordering validation | **PASS** | `release.yml YAML indentation, env vars, and Gate 1-6 ordering before tauri-action validated OK` |

### CI Note
- On GitHub Actions runners, Gate 5 and Gate 6 fail closed unless the Chrome Extension source is present at `chrome-extension/vectorize-ai-download` or `vars.STOCKSTUDIO_EXTENSION_DIR` points to a checked-out path in the runner workspace.

