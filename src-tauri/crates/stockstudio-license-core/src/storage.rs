use std::fs;
use std::io::Write as _;
use std::path::Path;

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::LicenseCoreError;
use crate::models::LicenseState;
use crate::{
    KEYRING_ACTIVATION_TOKEN, KEYRING_CLOCK_ANCHOR, KEYRING_DEVICE_ID, KEYRING_LICENSE_KEY,
};

/// Abstract OS secret storage boundary.
/// Production Desktop and future NMH binaries supply a platform-specific
/// implementation (Windows Credential Manager via `keyring` v3); unit tests
/// supply an in-memory implementation without mutating OS credentials.
pub trait SecretStore: Send + Sync {
    fn get_secret(&self, account: &str) -> Result<Option<String>, String>;
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete_secret(&self, account: &str) -> Result<(), String>;
}

/// Reads and validates `license-state.json`.
/// Rejects malformed or corrupted JSON with `LicenseCoreError::CorruptedPersistedState`.
pub fn read_state_file(path: &Path) -> Result<Option<LicenseState>, LicenseCoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(path).map_err(|e| LicenseCoreError::StorageIo(e.to_string()))?;
    if content.trim().is_empty() {
        return Err(LicenseCoreError::CorruptedPersistedState(
            "empty state file".to_string(),
        ));
    }
    let parsed: LicenseState = serde_json::from_str(&content)
        .map_err(|e| LicenseCoreError::CorruptedPersistedState(e.to_string()))?;
    Ok(Some(parsed))
}

/// Atomically writes `license-state.json` via a same-directory temporary file,
/// `sync_all()`, and rename so partial or corrupted files cannot be observed
/// by concurrent Desktop / companion readers.
pub fn write_state_file_atomic(path: &Path, state: &LicenseState) -> Result<(), LicenseCoreError> {
    let parent = path.parent().ok_or_else(|| {
        LicenseCoreError::StorageIo("invalid license state file path".to_string())
    })?;
    fs::create_dir_all(parent).map_err(|e| LicenseCoreError::StorageIo(e.to_string()))?;

    let bytes =
        serde_json::to_vec(state).map_err(|e| LicenseCoreError::StorageIo(e.to_string()))?;

    let tmp_name = format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("license-state.json"),
        Uuid::new_v4()
    );
    let tmp_path = parent.join(tmp_name);

    let write_res = (|| -> Result<(), std::io::Error> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(LicenseCoreError::StorageIo(err.to_string()));
    }

    if let Err(rename_err) = fs::rename(&tmp_path, path) {
        // On Windows, fs::rename may fail if the destination already exists on
        // some filesystems; fall back to replacing via remove + rename.
        if path.exists() {
            let _ = fs::remove_file(path);
            if fs::rename(&tmp_path, path).is_ok() {
                return Ok(());
            }
        }
        let _ = fs::remove_file(&tmp_path);
        return Err(LicenseCoreError::StorageIo(rename_err.to_string()));
    }

    Ok(())
}

pub fn remove_state_file(path: &Path) -> Result<(), LicenseCoreError> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| LicenseCoreError::StorageIo(e.to_string()))?;
    }
    Ok(())
}

pub fn clear_license_credentials_preserving_device_id(
    secrets: &dyn SecretStore,
    state_path: &Path,
) -> Result<(), LicenseCoreError> {
    let _ = secrets.delete_secret(KEYRING_ACTIVATION_TOKEN);
    let _ = secrets.delete_secret(KEYRING_LICENSE_KEY);
    remove_state_file(state_path)
}

pub fn compute_device_fingerprint(machine_guid: &str, arch: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("StockStudioPro:v1:device-fp:{machine_guid}:{arch}").as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

pub fn sanitize_device_name(raw: Option<String>) -> String {
    let raw = raw.unwrap_or_else(|| "StockStudio-Desktop".to_string());
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).take(120).collect();
    if cleaned.trim().is_empty() {
        "StockStudio-Desktop".to_string()
    } else {
        cleaned.trim().to_string()
    }
}

/// Dual-anchored device ID: stored persistently in the OS credential vault
/// (`StockStudioPro / device-id`) and mirrored in `license-state.json`.
pub fn ensure_device_id(
    secrets: &dyn SecretStore,
    state_path: &Path,
) -> Result<String, LicenseCoreError> {
    if let Ok(Some(existing)) = secrets.get_secret(KEYRING_DEVICE_ID) {
        let trimmed = existing.trim();
        if Uuid::parse_str(trimmed).is_ok() {
            return Ok(trimmed.to_lowercase());
        }
    }

    if let Ok(Some(saved)) = read_state_file(state_path) {
        let trimmed = saved.device_id.trim();
        if Uuid::parse_str(trimmed).is_ok() {
            let normalized = trimmed.to_lowercase();
            let _ = secrets.set_secret(KEYRING_DEVICE_ID, &normalized);
            return Ok(normalized);
        }
    }

    let id = Uuid::new_v4().to_string();
    secrets
        .set_secret(KEYRING_DEVICE_ID, &id)
        .map_err(LicenseCoreError::SecretStore)?;
    Ok(id)
}

pub fn record_clock_anchor(secrets: &dyn SecretStore, observed_utc: DateTime<Utc>) {
    let observed_ts = observed_utc.timestamp();
    let current_anchor = read_clock_anchor(secrets).unwrap_or(0);
    if observed_ts > current_anchor {
        let _ = secrets.set_secret(KEYRING_CLOCK_ANCHOR, &observed_ts.to_string());
    }
}

pub fn read_clock_anchor(secrets: &dyn SecretStore) -> Option<i64> {
    secrets
        .get_secret(KEYRING_CLOCK_ANCHOR)
        .ok()
        .flatten()
        .and_then(|s| s.trim().parse::<i64>().ok())
}
