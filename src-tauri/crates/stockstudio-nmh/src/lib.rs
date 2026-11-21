//! StockStudio Pro Native Messaging Host (`stockstudio-nmh`)
//!
//! Lightweight standalone Windows process spawned by Chrome Native Messaging.
//! Reads one 4-byte little-endian length-prefixed UTF-8 JSON request from stdin,
//! evaluates the device's license authorization using `stockstudio-license-core`,
//! writes one correlated, sanitized JSON response to stdout, and exits.

pub mod framing;
pub mod host;
pub mod manifest;
pub mod protocol;
