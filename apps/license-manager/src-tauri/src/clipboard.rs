use std::sync::Arc;
use std::time::Duration;

use zeroize::Zeroizing;

pub const DEFAULT_CLIPBOARD_CLEAR_SECS: u64 = 30;

pub trait ClipboardBackend: Send + Sync {
    fn set_text(&self, text: &str) -> Result<(), String>;
    fn get_text(&self) -> Result<String, String>;
}

pub struct SystemClipboard;

impl ClipboardBackend for SystemClipboard {
    fn set_text(&self, text: &str) -> Result<(), String> {
        let mut cb = arboard::Clipboard::new()
            .map_err(|e| format!("CLIPBOARD_ERROR: Failed accessing system clipboard ({e})"))?;
        cb.set_text(text.to_string())
            .map_err(|e| format!("CLIPBOARD_ERROR: Failed writing clipboard ({e})"))
    }

    fn get_text(&self) -> Result<String, String> {
        let mut cb = arboard::Clipboard::new()
            .map_err(|e| format!("CLIPBOARD_ERROR: Failed accessing system clipboard ({e})"))?;
        cb.get_text()
            .map_err(|e| format!("CLIPBOARD_ERROR: Failed reading clipboard ({e})"))
    }
}

/// Copies a secret to the clipboard and schedules an async task that clears
/// the clipboard after `clear_after` ONLY if it still holds the same secret.
pub fn copy_secret_with_auto_clear(
    backend: Arc<dyn ClipboardBackend>,
    secret: Zeroizing<String>,
    clear_after: Duration,
) -> Result<(), String> {
    backend.set_text(&secret)?;
    tokio::spawn(async move {
        tokio::time::sleep(clear_after).await;
        if let Ok(current) = backend.get_text() {
            if current == *secret {
                let _ = backend.set_text("");
            }
        }
        // `secret` (Zeroizing<String>) is zeroized automatically on drop here.
        drop(secret);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MockClipboard {
        value: Mutex<String>,
    }

    impl MockClipboard {
        fn new() -> Self {
            Self {
                value: Mutex::new(String::new()),
            }
        }
    }

    impl ClipboardBackend for MockClipboard {
        fn set_text(&self, text: &str) -> Result<(), String> {
            *self.value.lock().unwrap() = text.to_string();
            Ok(())
        }

        fn get_text(&self) -> Result<String, String> {
            Ok(self.value.lock().unwrap().clone())
        }
    }

    #[tokio::test]
    async fn clears_clipboard_automatically_after_expiration() {
        let cb = Arc::new(MockClipboard::new());
        let secret = Zeroizing::new("SSPRO-CLIP-1111-2222-3333".to_string());
        copy_secret_with_auto_clear(cb.clone(), secret, Duration::from_millis(60)).unwrap();

        assert_eq!(cb.get_text().unwrap(), "SSPRO-CLIP-1111-2222-3333");
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(cb.get_text().unwrap(), "");
    }

    #[tokio::test]
    async fn does_not_overwrite_unrelated_user_clipboard_content() {
        let cb = Arc::new(MockClipboard::new());
        let secret = Zeroizing::new("SSPRO-CLIP-1111-2222-3333".to_string());
        copy_secret_with_auto_clear(cb.clone(), secret, Duration::from_millis(60)).unwrap();

        cb.set_text("unrelated user text").unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(cb.get_text().unwrap(), "unrelated user text");
    }
}
