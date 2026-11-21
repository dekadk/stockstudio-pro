# StockStudio Pro

StockStudio Pro is a Windows desktop creative workflow application built with **Tauri 2 + React + Rust**, paired with the **Vectorize.ai Download** Chrome Extension (Manifest V3) and a **Cloudflare Workers + D1** unified licensing backend.

## Repository Structure

```text
├── src/                                     # React + TypeScript desktop UI
├── src-tauri/                               # Tauri 2 desktop backend & NSIS packaging
│   ├── crates/stockstudio-license-core/     # Shared Rust Ed25519 lease & offline grace verifier
│   ├── crates/stockstudio-nmh/              # Standalone static-CRT Chrome Native Messaging Host
│   ├── installer-hooks.nsh                  # NSIS HKCU Native Messaging registration & uninstall hooks
│   └── native-messaging/                    # Pinned Extension ID & host manifest template
├── chrome-extension/vectorize-ai-download/  # Manifest V3 Chrome Extension (pinned ID)
├── workers/license-api/                     # Cloudflare Workers + D1 License API & migrations
├── scripts/                                 # NMH build/PE-check & automated E2E test suites
└── .github/workflows/release.yml            # Gated Windows NSIS release workflow
```

## Unified Licensing Architecture (High Level)

**One license key → one device activation → Desktop + Chrome Extension authorization.**

1. **Desktop Activation:** StockStudio Pro Desktop activates a license key against the HTTPS License API (`workers/license-api`) and receives an **Ed25519-signed offline entitlement lease** (7-day offline grace ceiling with clock-rollback protection).
2. **Local Verification (`stockstudio-license-core`):** Both Desktop and the Native Messaging Host (`stockstudio-nmh.exe`) verify the signed lease locally using embedded public verifying keys only.
3. **Chrome Extension Authorization:** The Chrome Extension (`chrome-extension/vectorize-ai-download`, pinned ID `ejcjoljemplfeenipjehlhhclbkpialk`) queries `com.stockstudiopro.license` via Chrome Native Messaging (`HKCU`) and receives only a minimal sanitized authorization verdict (`authorized`, `license_status`, `products`, `offline_grace_until`). License keys, activation tokens, lease tokens, and device fingerprints never cross Native Messaging.

## Development Setup

### Prerequisites
- Node.js 20+
- Rust stable toolchain (`rustfmt` included)
- Windows 10/11 with WebView2 Runtime (for desktop build/run)
- NSIS 3.x (`makensis`) for local installer bundling

### Install Dependencies
```bash
npm ci
npm --prefix workers/license-api ci
```

### Run Desktop in Development
```bash
npm run tauri dev
```

### Load Chrome Extension Locally
1. Open `chrome://extensions` in Google Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select `chrome-extension/vectorize-ai-download`.
3. Confirm the loaded Extension ID is `ejcjoljemplfeenipjehlhhclbkpialk`.

## Build & Verification Commands

```bash
# Frontend typecheck & bundle
npm run typecheck
npm run build

# Rust formatting & workspace tests (debug + release prod-key verification)
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --workspace
cargo test --release --manifest-path src-tauri/Cargo.toml -p stockstudio-license-core

# License API Worker typecheck & local D1 test suite
npm --prefix workers/license-api run typecheck
npm --prefix workers/license-api test

# Prepare static-CRT Native Messaging Host binary & verify zero dynamic VC++ CRT imports
node scripts/prepare-nmh-bundle.mjs

# Chrome Extension client tests & Unified Licensing E2E suite
node scripts/test-extension-license-client.mjs
node scripts/test-e2e-unified-licensing.mjs
```

## Release Process & GitHub Actions Configuration

Releases are triggered manually via `.github/workflows/release.yml` (`workflow_dispatch`) on `windows-latest`. Before packaging the NSIS installer, the workflow enforces 6 fail-fast gates:
1. Production configuration validation (HTTPS API URL, pinned 32-char Extension ID, embedded production Ed25519 key).
2. Frontend TypeScript check (`npm run typecheck`).
3. Rust formatting + debug workspace tests + release production-key verification.
4. License API Worker typecheck & test suite.
5. Static-CRT NMH build + Chrome Extension manifest/JS validation & license client tests.
6. Unified Licensing E2E test suite.

### Required GitHub Actions Secrets
- `TAURI_SIGNING_PRIVATE_KEY` — Tauri updater private signing key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — Password for the Tauri updater signing key.
- `GITHUB_TOKEN` — Provided automatically by GitHub Actions.

### Optional GitHub Actions Repository Variables
- `STOCKSTUDIO_EXTENSION_DIR` — Defaults to `chrome-extension/vectorize-ai-download` (no variable required when using the in-repository extension).
