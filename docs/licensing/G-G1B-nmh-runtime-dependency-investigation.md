# TASK G-G1B FIX: `stockstudio-nmh.exe` Runtime Dependency Investigation

**Project:** StockStudio Pro Desktop (v0.3.0) + `stockstudio-nmh.exe`  
**Observed Failure in Clean Windows Sandbox:** `0xC0000135` (`STATUS_DLL_NOT_FOUND`) when launching `stockstudio-nmh.exe` directly; `stockstudio-pro.exe` launches cleanly.  
**Status:** Investigation & Recommendation Complete (No source or installer files modified yet)

---

## 1. PE Import Table Evidence

Direct inspection of the PE32+ import directory tables of both built release binaries:

### `src-tauri/binaries/stockstudio-nmh-x86_64-pc-windows-msvc.exe` (`699,392` bytes)
```text
bcryptprimitives.dll
kernel32.dll
advapi32.dll
api-ms-win-core-synch-l1-2-0.dll
ntdll.dll
VCRUNTIME140.dll                  <-- ONLY NON-OS RUNTIME DEPENDENCY (MISSING IN CLEAN WINDOWS)
api-ms-win-crt-string-l1-1-0.dll
api-ms-win-crt-runtime-l1-1-0.dll
api-ms-win-crt-math-l1-1-0.dll
api-ms-win-crt-stdio-l1-1-0.dll
api-ms-win-crt-locale-l1-1-0.dll
api-ms-win-crt-heap-l1-1-0.dll
```

### `src-tauri/target/release/stockstudio-pro.exe` (`15,269,376` bytes)
```text
kernel32.dll, bcryptprimitives.dll, advapi32.dll, ntdll.dll, user32.dll,
ole32.dll, gdi32.dll, dwmapi.dll, comctl32.dll, shlwapi.dll,
api-ms-win-core-synch-l1-2-0.dll, shell32.dll, oleaut32.dll, ws2_32.dll,
crypt32.dll, bcrypt.dll,
api-ms-win-crt-{math,string,convert,runtime,stdio,locale,heap}-l1-1-0.dll
```
*(Zero dependency on `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, or `MSVCP140.dll`.)*

---

## 2. Exact Missing Dependency & Root Cause

- **Exact Missing Runtime DLL:** **`VCRUNTIME140.dll`** (the sole non-OS DLL imported by `stockstudio-nmh.exe`).
  - `VCRUNTIME140_1.dll` and `MSVCP140.dll` are **not** imported by `stockstudio-nmh.exe`.
  - All `api-ms-win-crt-*-l1-1-0.dll` forwarders resolve to `ucrtbase.dll`, which is built into Windows 10/11 and present in Windows Sandbox.
- **Root Cause:**
  1. Neither `.cargo/config.toml` nor `src-tauri/.cargo/config.toml` exists in the repository.
  2. By default, Rust's `x86_64-pc-windows-msvc` target dynamically links `vcruntime140.dll` (`-C target-feature=-crt-static`).
  3. `stockstudio-pro.exe` avoids `VCRUNTIME140.dll` because `tauri_build::build()` (via `tauri-build`) configures static `vcruntime` linking for the main Tauri binary, whereas `stockstudio-nmh` is an independent pure-Rust binary crate without `tauri-build` and compiled by `scripts/prepare-nmh-bundle.mjs` without `-C target-feature=+crt-static`.
- **Native Dependency Audit (`cargo tree -p stockstudio-nmh`):**
  - Direct & transitive crates: `chrono`, `keyring` (`windows-sys` → `advapi32.dll`), `serde`, `serde_json`, `stockstudio-license-core` (`base64`, `ed25519-dalek`, `sha2`, `url`, `uuid`), `uuid`.
  - **Zero C/C++ native libraries (`*-sys` C wrappers)** are linked. Every OS call goes straight through Win32 system DLLs (`kernel32.dll`, `advapi32.dll`, `bcryptprimitives.dll`, `ntdll.dll`).

---

## 3. Solution Comparison

| Criterion | **Option A: Static CRT Linking (`+crt-static`) for `stockstudio-nmh`** *(Recommended)* | **Option B: Bundle Official `vc_redist.x64.exe` in NSIS** | **Option C: App-Local MSVC Redist DLLs** |
| :--- | :--- | :--- | :--- |
| **Works on clean Windows 10/11 & Sandbox** | **Yes** — zero external runtime DLLs required | Yes | Yes |
| **Per-user non-admin NSIS install preserved?** | **Yes** — zero UAC elevation required | **No** — `vc_redist.x64.exe` requires Administrator UAC elevation | Yes |
| **Installer size impact** | **Minimal (~+100–250 KiB)** on `stockstudio-nmh.exe` (total setup stays ~4 MB) | **Heavy (+24–26 MiB)** — >6× the entire StockStudio Pro installer | ~+100 KiB |
| **Security & maintenance** | Uses official Rust + MSVC static CRT (`libvcruntime.lib` / `libcmt.lib`); zero extra installer steps or reboot-pending states | Must track & update Microsoft redistributable hashes; adds silent-install failure modes | Must manually source & patch loose DLLs from VS Redist |
| **Compatibility with `stockstudio-nmh`** | **100% compatible** (pure Rust + Win32 APIs only; zero C/C++ FFI) | Compatible | Compatible |
| **Protocol / Security impact** | None (Native Messaging protocol, Ed25519, and Credential Manager unchanged) | None | None |

---

## 4. Recommended Production Packaging Solution

**Adopt Option A: Static CRT linking (`-C target-feature=+crt-static`) for `stockstudio-nmh.exe`.**

### Required Source / Configuration Changes (To Be Implemented After Approval)
1. **[scripts/prepare-nmh-bundle.mjs](file:///e:/2.%20Microstock/TOOL/flowpilot-main/flowpilot-main/scripts/prepare-nmh-bundle.mjs):**  
   Pass `RUSTFLAGS="-C target-feature=+crt-static"` (preserving any existing `RUSTFLAGS`) when invoking `cargo build --release --manifest-path ... -p stockstudio-nmh --bin stockstudio-nmh` on `win32`.
2. **Verification Check in `scripts/prepare-nmh-bundle.mjs` (or automated test):**  
   Inspect the staged `stockstudio-nmh-x86_64-pc-windows-msvc.exe` PE import table after build and fail if `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, or `MSVCP140.dll` appears in the imports.
3. **Zero changes required** to `stockstudio-pro.exe`, `tauri.conf.json`, `installer-hooks.nsh`, Native Messaging protocol, Extension ID, or Cloudflare backend.

### Expected Impact on Installer Size & Installation Behavior
- **Installer Size:** ~+100–250 KiB (installer remains ~4.0 MB instead of jumping to ~30 MB).
- **Installation Behavior:** Remains 100% per-user (`HKCU`), silent-capable, non-admin (no UAC prompt), and immediately runnable on clean Windows 10/11 and Windows Sandbox without installing Visual C++ Redistributable.
