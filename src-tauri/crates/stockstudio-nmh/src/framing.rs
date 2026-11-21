use std::fmt;
use std::io::{Read, Write};

/// Defensive inbound frame cap (64 KiB). Extension requests are <1 KiB.
pub const MAX_INBOUND_MESSAGE_BYTES: usize = 64 * 1024;

/// Chrome Native Messaging hard limit for host-to-extension messages (1 MiB).
pub const MAX_OUTBOUND_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FramingError {
    EmptyStream,
    InvalidLength(u32),
    OversizedInbound(usize),
    OversizedOutbound(usize),
    InvalidUtf8,
    Io(String),
}

impl fmt::Display for FramingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyStream => write!(f, "native messaging input stream closed"),
            Self::InvalidLength(len) => write!(f, "invalid native messaging length: {len}"),
            Self::OversizedInbound(len) => {
                write!(f, "inbound message exceeds limit ({len} bytes)")
            }
            Self::OversizedOutbound(len) => {
                write!(
                    f,
                    "outbound message exceeds Chrome 1 MiB limit ({len} bytes)"
                )
            }
            Self::InvalidUtf8 => write!(f, "inbound payload is not valid UTF-8"),
            Self::Io(msg) => write!(f, "native messaging I/O error: {msg}"),
        }
    }
}

impl std::error::Error for FramingError {}

/// Reads a single Chrome Native Messaging frame (4-byte little-endian length + UTF-8 payload).
pub fn read_frame<R: Read>(reader: &mut R) -> Result<String, FramingError> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(FramingError::EmptyStream);
        }
        Err(e) => return Err(FramingError::Io(e.to_string())),
    }

    let len = u32::from_le_bytes(len_buf);
    if len == 0 {
        return Err(FramingError::InvalidLength(0));
    }
    let len_usize = len as usize;
    if len_usize > MAX_INBOUND_MESSAGE_BYTES {
        return Err(FramingError::OversizedInbound(len_usize));
    }

    let mut payload = vec![0u8; len_usize];
    reader
        .read_exact(&mut payload)
        .map_err(|e| FramingError::Io(e.to_string()))?;

    String::from_utf8(payload).map_err(|_| FramingError::InvalidUtf8)
}

/// Writes a single Chrome Native Messaging frame (4-byte little-endian length + UTF-8 JSON bytes).
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> Result<(), FramingError> {
    if payload.is_empty() {
        return Err(FramingError::InvalidLength(0));
    }
    if payload.len() > MAX_OUTBOUND_MESSAGE_BYTES {
        return Err(FramingError::OversizedOutbound(payload.len()));
    }
    let len_bytes = (payload.len() as u32).to_le_bytes();
    writer
        .write_all(&len_bytes)
        .map_err(|e| FramingError::Io(e.to_string()))?;
    writer
        .write_all(payload)
        .map_err(|e| FramingError::Io(e.to_string()))?;
    writer
        .flush()
        .map_err(|e| FramingError::Io(e.to_string()))?;
    Ok(())
}
