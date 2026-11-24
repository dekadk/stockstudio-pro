# TASK G-G3.1A: Distribution Readiness Assessment Report

**Project:** StockStudio Pro Unified Licensing (`0.2.0`)  
**Assessment Mode:** Strict Read-Only Audit (no repository created, no remotes/history/code modified)  
**Estimated Migration Complexity:** **`LOW`**

---

## 1. Current Repository Structure & Git State

- **Branch & History:** Single branch `main` at `f398e57` (`9` clean commits starting from `07e947c chore: initialize StockStudio Pro repository`).
- **Remotes:** **None** (`git remote -v` is empty — no upstream Flowpilot remote attached).
- **Git LFS:** **Not used** (`.gitattributes` absent, 0 LFS files).
- **Working Tree:** `21` modified tracked files + untracked directories (`src-tauri/crates/`, `src-tauri/native-messaging/`, `scripts/`, `docs/licensing/`, `src/components/`, `src/config/`, etc.) representing the completed G-A through G-G2.4 work.
- **Standalone & History Verdict:** **SAFE TO MIGRATE WITH EXISTING HISTORY.** All 9 commits are already StockStudio Pro history with zero committed private keys or secrets.

---

## 2. Recommended New Repository Structure & Name

- **Recommended Repository Name:** `stockstudio-pro` (e.g., `https://github.com/<OWNER>/stockstudio-pro`).
- **Visibility Tradeoff:**
  - **Private main repo + Public release-mirror repo (Recommended if keeping `workers/license-api`, internal planning/audit docs, and D1 IDs private):** Keeps backend source and internal docs private while letting Tauri's unauthenticated auto-updater download `latest.json` and installers from public GitHub Releases.
  - **Single Public repo:** Simplest for Tauri auto-updater (`latest.json` works out-of-the-box with `.github/workflows/release.yml`), provided you are comfortable publishing desktop + worker source and docs.
- **Directories/Files NOT to Publish:** All gitignored build/secret artifacts (`node_modules/`, `src-tauri/target/`, `src-tauri/binaries/*.exe`, `workers/license-api/.dev.vars`, `bootstrap*.json`, `staging-test-license.json`).

---

## 3. Existing Flowpilot References (Classified)

| File & Line | Reference | Classification | Action |
| --- | :--- | :---: | :--- |
| `src-tauri/tauri.conf.json:12` | `https://github.com/masplangga/flowpilot/releases/latest/download/latest.json` | **Must change before public release** | Update to `https://github.com/<NEW_OWNER>/stockstudio-pro/releases/latest/download/latest.json` (or public release repo). |
| `src-tauri/crates/stockstudio-license-core/src/config.rs:37` | `host.contains("flowpilot")` rejection | **Intentionally retained** | Security guard preventing legacy Flowpilot API URLs. |
| `.github/workflows/release.yml:49-50` | `flowpilot` rejection in Gate 1 | **Intentionally retained** | CI guard preventing legacy Flowpilot API URLs. |
| `src-tauri/src/license_store.rs:1303-1308` & `workers/license-api/tests/license-api.test.ts:740-746` | Negative tests for `flowpilot` host / `com.flowpilot.desktop` | **Intentionally retained** | Security regression tests. |
| `E:\2. Microstock\TOOL\flowpilot-main\flowpilot-main` | Local folder name | **Internal development reference** | Optional local rename later; does not affect GitHub repo. |
| `docs/audit/`, `docs/planning/` | Historical migration notes | **Requires user decision** | Keep in private repo or exclude before making repo public. |

---

## 4. Chrome Extension Distribution Readiness

- **Location:** `E:\2. Microstock\TOOL\Chrome Extension\Vectorize.ai Download v1` — **can remain in its existing local directory**.
- **Readiness:** **READY** — MV3 `manifest.json`, pinned RSA public `"key"` producing exact ID `ejcjoljemplfeenipjehlhhclbkpialk`, `nativeMessaging` permission, `com.stockstudiopro.license` host, and static-CRT `stockstudio-nmh.exe` are all verified across G-G1B, G-G1D, and G-G2.4.
- **CI Release Workflow Dependency:** `.github/workflows/release.yml` Gates 5 & 6 require the extension source at `chrome-extension/vectorize-ai-download` or `vars.STOCKSTUDIO_EXTENSION_DIR`. Before running CI releases in the new repo, either include the extension under `chrome-extension/vectorize-ai-download` in the new repo or add a second `actions/checkout` step from a dedicated extension repository.

---

## 5. Tauri Updater & Desktop Release Migration Requirements

- **Updater Endpoint (`src-tauri/tauri.conf.json:12`):** Change from `masplangga/flowpilot` to `https://github.com/<NEW_OWNER>/stockstudio-pro/releases/latest/download/latest.json`.
- **Updater Signing Key (`plugins.updater.pubkey`):** Currently embeds minisign key ID `9883364C90076B4B`. Confirm you hold the matching `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to store in the new repository's GitHub Secrets (or generate a fresh StockStudio Pro minisign keypair and update `pubkey` before the first release).
- **Installer Artifact Names & Manifest:** Tauri automatically produces `StockStudio Pro_0.2.0_x64-setup.exe`, `.sig`, and `latest.json` (`createUpdaterArtifacts: true`, `includeUpdaterJson: true`).
- **Workflow Independence:** `.github/workflows/release.yml` has **zero** hardcoded references to `masplangga/flowpilot`; it uses `${{ secrets.GITHUB_TOKEN }}` automatically for the repository it runs in.

---

## 6. Security Risks & Production Distribution Limitation

- **Git History Secret Scan:** **CLEAN** — Zero `.pem`, `.key`, `.dev.vars`, `bootstrap*.json`, or full `SSPRO-*` / `ssadm_*` / `ssact_*` tokens exist in Git history or tracked `docs/license/v0.2.0-E-D1-staging-test-license.md`.
- **Local Untracked Secrets (Verified Gitignored):** `workers/license-api/.dev.vars`, `bootstrap-local-license.json`, `bootstrap-staging-admin.json`, `staging-test-license.json` are ignored by `workers/license-api/.gitignore`. Keep them excluded and never run `git add -f`.
- **Known Production Distribution Limitation (`*.workers.dev` ISP DNS Blocking):**
  - Keeping `https://stockstudio-pro-license-api-prod.dekadk00.workers.dev` temporarily means customers on Indonesian ISPs that DNS-block `*.workers.dev` (confirmed on `xlaxiata.id` → `blockpage.xlaxiata.id`) will encounter connection failures during license activation/validation unless using DoH (`1.1.1.1`), alternate DNS, or VPN.
  - Plan custom HTTPS domain migration in a later phase (zero D1/key changes required when migrating).

---

## 7. Recommended Migration Sequence

1. Create the new GitHub repository (`<OWNER>/stockstudio-pro`) with chosen visibility.
2. Add GitHub Actions Secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in the new repo.
3. Update `src-tauri/tauri.conf.json` `plugins.updater.endpoints` (and `pubkey` only if rotating the updater key).
4. Configure Chrome Extension source for CI Gates 5 & 6 (`chrome-extension/vectorize-ai-download` or separate repo checkout).
5. Review `git status`, create clean release commit(s) on `main`, add `origin` remote for the new repo, and push.
6. Trigger `.github/workflows/release.yml` (`workflow_dispatch`, tag `v0.2.0`) to verify all 6 gates, signed NSIS installer, and `latest.json`.

---

## 8. Exact Next Actions Requiring User Approval

1. **GitHub Owner, Repo Name & Visibility:** Confirm `<OWNER>/stockstudio-pro` and whether the repository will be **Public** or **Private** (note: Tauri auto-updater requires public release assets).
2. **Tauri Updater Signing Key:** Confirm whether you have the private key + password for existing `pubkey` (`9883364C90076B4B`) or want to generate a new keypair.
3. **CI Extension Source Strategy:** Confirm whether to include a copy under `chrome-extension/vectorize-ai-download` in the new repo or check out a separate extension repo in `release.yml`.

*Read-only audit complete. Zero source, configuration, Git remotes, history, or extension files were modified.*
