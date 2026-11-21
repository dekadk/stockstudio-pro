//! Entrypoint for `stockstudio-nmh.exe` (Chrome Native Messaging Host).
//!
//! NEVER writes diagnostic logs to stdout; stdout is reserved exclusively for
//! 4-byte little-endian length-prefixed UTF-8 JSON Native Messaging frames.

fn main() {
    if let Err(err) = stockstudio_nmh::host::run_stdio_host() {
        eprintln!("[stockstudio-nmh] {err}");
        std::process::exit(1);
    }
}
