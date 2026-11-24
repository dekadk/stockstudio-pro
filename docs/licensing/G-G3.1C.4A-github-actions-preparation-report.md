# TASK G-G3.1C.4A: GitHub Actions Workflow Preparation Report

**Project:** StockStudio Pro (`0.2.0`)  
**Target Repository:** `https://github.com/dekadk/stockstudio-pro` (`PUBLIC`)  
**Final Verdict:** **`READY FOR G-G3.1C.4B`**

---

## A. Executive Summary

`.github/workflows/release.yml` has been audited and hardened with repository-variable fallback support (`vars.STOCKSTUDIO_LICENSE_API_URL`, `vars.STOCKSTUDIO_EXTENSION_ID`, `vars.STOCKSTUDIO_EXTENSION_DIR`), full frontend build gating (`npm run build`), and a fail-closed **Gate 7 pre-release updater readiness guard** that prevents publishing any release while `tauri.conf.json` still references legacy `masplangga/flowpilot` or while updater signing secrets are unset. Operator setup documentation was added at `docs/release/GITHUB-ACTIONS-SETUP.md`. All local validations passed (`49/49` Rust debug, `8/8` Rust release prod-key, `18/18` Worker, `7/7` Extension client, and full E2E).

---

## B. Workflow Architecture

- **Active Workflow:** `.github/workflows/release.yml` (`Release StockStudio Pro`, only workflow under `.github/workflows/`).
- **Trigger & Runner:** Manual `workflow_dispatch` (`tag` input, default `v0.2.0`) on `windows-latest` (`permissions: contents: write`).
- **Build & Packaging:** `tauri-apps/tauri-action@v0.6` (`includeUpdaterJson: true`, `releaseDraft: false`, `prerelease: false`) producing NSIS installer (`StockStudio Pro_0.2.0_x64-setup.exe`), `.sig`, and `latest.json`.

---

## C. CI Gate Verification (All 7 Gates Verified)

1. **Gate 1 — Production Configuration:** Validates HTTPS `STOCKSTUDIO_LICENSE_API_URL` (rejects `staging`, `flowpilot`, `localhost`), 32-char `STOCKSTUDIO_EXTENSION_ID` (`ejcjoljemplfeenipjehlhhclbkpialk`), and embedded production Ed25519 key (`sspro-ed25519-prod-01`) in `config.rs`.
2. **Gate 2 — Frontend Typecheck & Build:** `npm run typecheck` + `npm run build`.
3. **Gate 3 — Rust Format & Tests (Debug + Release):** `cargo fmt --check`, `cargo test --workspace`, and `cargo test --release -p stockstudio-license-core`.
4. **Gate 4 — Worker API Typecheck & Tests:** `npm --prefix workers/license-api run typecheck` + `npm --prefix workers/license-api test`.
5. **Gate 5 — Static-CRT NMH & Chrome Extension:** `node scripts/prepare-nmh-bundle.mjs` (static-CRT + PE import check), `manifest.json` + 5 MV3 JS `node --check`, and `node scripts/test-extension-license-client.mjs` defaulting to `chrome-extension/vectorize-ai-download`.
6. **Gate 6 — Unified Licensing E2E:** `node scripts/test-e2e-unified-licensing.mjs` defaulting to `chrome-extension/vectorize-ai-download`.
7. **Gate 7 — Updater Readiness Guard (New):** Fails closed if `src-tauri/tauri.conf.json` still references `masplangga/flowpilot` OR if `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are unset.

---

## D. Required GitHub Repository Variables (Non-Secret)

Exact variable names referenced in `.github/workflows/release.yml`:

| Variable Name | Default in Workflow | Notes |
| --- | :--- | :--- |
| `STOCKSTUDIO_LICENSE_API_URL` | `https://stockstudio-pro-license-api-prod.dekadk00.workers.dev` | Optional; set when migrating to custom HTTPS domain |
| `STOCKSTUDIO_EXTENSION_ID` | `ejcjoljemplfeenipjehlhhclbkpialk` | Optional; pinned Extension ID |
| `STOCKSTUDIO_EXTENSION_DIR` | `chrome-extension/vectorize-ai-download` | Optional; works out-of-the-box with integrated extension |

---

## E. Required Future Secrets (Not Uploaded Yet)

| Secret Name | Purpose | Current Status |
| --- | :--- | :--- |
| `TAURI_SIGNING_PRIVATE_KEY` | StockStudio Pro Tauri Updater private key (`161D6624BEE2416D`) | Pending offline backup & local sign test |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase protecting `stockstudio-pro-updater.key` | Pending offline backup & local sign test |
| `GITHUB_TOKEN` | GitHub Release publishing | Automatic in GitHub Actions |

---

## F. Release & Updater Dependencies

- `src-tauri/tauri.conf.json` remains **unchanged** (`9883364C90076B4B` / `masplangga/flowpilot`).
- Production license signing key (`sspro-ed25519-prod-01`) remains **completely untouched**.
- Gate 7 guarantees no release can be published until updater migration (`tauri.conf.json` + GitHub Secrets) is completed in a separately approved step.

---

## G. Documentation & Files Changed

- **Modified:** `.github/workflows/release.yml` (`vars.*` fallbacks, `npm run build` in Gate 2, Gate 7 updater readiness guard).
- **Created:** `docs/release/GITHUB-ACTIONS-SETUP.md` (public-safe GitHub Actions setup guide — zero secrets).
- **Created:** `docs/licensing/G-G3.1C.4A-github-actions-preparation-report.md` (this report).

---

## H. Local Validation Results

| Check | Result | Actual Output |
| --- | :---: | :--- |
| `.github/workflows/release.yml` YAML & Gates 1–7 structure + paths | **PASS** | `Workflow Gates 1-7 & all script/extension paths validated OK` |
| Extension `manifest.json` + 5 MV3 JS syntax checks | **PASS** | Valid MV3 JSON & 5/5 JS syntax OK |
| `node scripts/test-extension-license-client.mjs` | **PASS** | `7/7`, `ALL_PHASE_4_EXTENSION_TESTS_PASSED` |
| `node scripts/test-e2e-unified-licensing.mjs` | **PASS** | `ALL_TASK_GF_E2E_CHECKS_PASSED` |
| `npm run typecheck` & `npm run build` | **PASS** | `tsc` exited `0`; Vite built in `1.08s` |
| `cargo fmt --check`, debug workspace, & release `stockstudio-license-core` | **PASS** | Debug `49 passed, 0 failed`; Release `8 passed, 0 failed` |
| `workers/license-api` typecheck & Vitest suite | **PASS** | `2 passed` files, `18 passed` tests |

---

## I. Git Safety Confirmation

- **Branch:** `main` | **HEAD:** `f398e578ae5a42f08fae58d2f3ffaed160d202de` | **Original commits:** `9`
- **Remotes:** `0` | **Staged files:** `0`
- **Confirmed:** No remote added, no commit/push/tag, no GitHub Secrets created, no signing key generated/modified, no `tauri.conf.json` or Cloudflare/production change.

---

## J. Final Verdict

> **Final Verdict: `READY FOR G-G3.1C.4B`**
