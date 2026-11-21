# GitHub Actions Setup — StockStudio Pro (`dekadk/stockstudio-pro`)

## 1. Workflow Overview

- **Workflow file:** `.github/workflows/release.yml` (`Release StockStudio Pro`)
- **Trigger:** Manual `workflow_dispatch` with required `tag` input (default `v0.2.0`)
- **Runner:** `windows-latest` (Node.js 20, stable Rust + `rustfmt`)
- **Permissions:** `contents: write` (for publishing GitHub Releases, signed NSIS installers, `.sig` files, and `latest.json`)

## 2. CI Release Gates (Fail-Fast Before Packaging)

Every release run must pass all 7 gates before `tauri-apps/tauri-action@v0.6` builds and publishes artifacts:

| Gate | Coverage |
| --- | :--- |
| **Gate 1** | Validates `STOCKSTUDIO_LICENSE_API_URL` (HTTPS, non-staging, non-flowpilot), `STOCKSTUDIO_EXTENSION_ID` (exact 32-char `a-p`), and embedded production Ed25519 verifying key (`sspro-ed25519-prod-01`) in `src-tauri/crates/stockstudio-license-core/src/config.rs`. |
| **Gate 2** | Frontend TypeScript check (`npm run typecheck`) and production bundle (`npm run build`). |
| **Gate 3** | Rust formatting (`cargo fmt --check`), full debug workspace tests (`cargo test --workspace`), and release-mode license-core verification (`cargo test --release -p stockstudio-license-core`). |
| **Gate 4** | License API Worker typecheck (`tsc --noEmit`) and full Vitest + Miniflare D1 test suite (`18` tests). |
| **Gate 5** | Static-CRT Native Messaging Host build & PE import check (`scripts/prepare-nmh-bundle.mjs`), Chrome Extension `manifest.json` + 5 MV3 JS syntax checks, and extension license client tests (`scripts/test-extension-license-client.mjs`). |
| **Gate 6** | Unified Licensing E2E test suite (`scripts/test-e2e-unified-licensing.mjs`). |
| **Gate 7** | Pre-publish updater guard: blocks release if `src-tauri/tauri.conf.json` still references legacy `masplangga/flowpilot` or if `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are unset. |

## 3. Chrome Extension Integration Path

- Integrated directory: `chrome-extension/vectorize-ai-download`
- Pinned Extension ID: `ejcjoljemplfeenipjehlhhclbkpialk`
- No external `STOCKSTUDIO_EXTENSION_DIR` repository variable is required; Gates 5 and 6 default automatically to `chrome-extension/vectorize-ai-download`.

## 4. GitHub Repository Variables (Non-Secret)

Configure under **Settings → Secrets and variables → Actions → Variables** if overriding defaults:

| Variable Name | Default / Production Value | Required? |
| --- | :--- | :---: |
| `STOCKSTUDIO_LICENSE_API_URL` | `https://stockstudio-pro-license-api-prod.dekadk00.workers.dev` | Optional (defaults in workflow; set when migrating to custom HTTPS domain) |
| `STOCKSTUDIO_EXTENSION_ID` | `ejcjoljemplfeenipjehlhhclbkpialk` | Optional (defaults in workflow) |
| `STOCKSTUDIO_EXTENSION_DIR` | `chrome-extension/vectorize-ai-download` | Optional (defaults to integrated in-repo path) |

## 5. Required Future GitHub Actions Secrets (Before First Release)

Configure under **Settings → Secrets and variables → Actions → Secrets** only after completing offline backup and local signing verification of the StockStudio Pro Tauri Updater keypair:

| Secret Name | Purpose |
| --- | :--- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the StockStudio Pro Tauri Updater private key (`stockstudio-pro-updater.key`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase protecting `stockstudio-pro-updater.key` |
| `GITHUB_TOKEN` | Provided automatically by GitHub Actions |

> **Security Boundary:** Tauri updater signing secrets are completely separate from the Cloudflare Worker production license Ed25519 key (`sspro-ed25519-prod-01`). Never store license signing private keys, D1 peppers, or admin API keys in GitHub Actions.

## 6. Release Prerequisites & Inspecting Workflow Runs

Before triggering `Release StockStudio Pro`:
1. Complete offline encrypted vault backup of `stockstudio-pro-updater.key` and verify signing locally.
2. Migrate `src-tauri/tauri.conf.json` (`plugins.updater.pubkey` → new public key `161D6624BEE2416D`, `endpoints` → `https://github.com/dekadk/stockstudio-pro/releases/latest/download/latest.json`).
3. Upload `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to GitHub Actions Secrets.
4. Trigger **Actions → Release StockStudio Pro → Run workflow**, and inspect each gate log and the generated GitHub Release assets (`StockStudio Pro_<version>_x64-setup.exe`, `.sig`, and `latest.json`).
