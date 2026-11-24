use std::fs;
use std::path::Path;
use std::process::Command;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chrono::Utc;
use rand::RngCore;
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const MIN_PASSPHRASE_LENGTH: usize = 16;
const SCRYPT_LOG_N: u8 = 14; // N = 16384 (matches issue-owner-license-prod.mjs)
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const KEY_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultKdfParams {
    #[serde(rename = "N")]
    pub n: u32,
    pub r: u32,
    pub p: u32,
    pub keylen: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedVaultFile {
    pub format: String,
    pub cipher: String,
    pub kdf: String,
    pub kdf_params: VaultKdfParams,
    pub salt_b64: String,
    pub iv_b64: String,
    pub auth_tag_b64: String,
    pub ciphertext_b64: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultSecretPayload {
    pub environment: String,
    pub api_url: String,
    pub license_id: String,
    pub key_prefix: String,
    pub license_key: String,
    pub issued_at: String,
}

pub fn encrypt_vault_payload(
    payload: &VaultSecretPayload,
    passphrase: &str,
) -> Result<EncryptedVaultFile, String> {
    if passphrase.len() < MIN_PASSPHRASE_LENGTH {
        return Err(format!(
            "INVALID_REQUEST: Vault passphrase must be at least {MIN_PASSPHRASE_LENGTH} characters."
        ));
    }

    let mut salt = [0u8; 32];
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut iv);

    let params = ScryptParams::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN)
        .map_err(|e| format!("CRYPTO_ERROR: Invalid scrypt params ({e})"))?;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    scrypt(passphrase.as_bytes(), &salt, &params, key.as_mut())
        .map_err(|e| format!("CRYPTO_ERROR: scrypt derivation failed ({e})"))?;

    let plaintext = Zeroizing::new(
        serde_json::to_vec(payload)
            .map_err(|e| format!("CRYPTO_ERROR: Failed serializing vault payload ({e})"))?,
    );

    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|e| format!("CRYPTO_ERROR: AES-256-GCM init failed ({e})"))?;
    let nonce = Nonce::from_slice(&iv);
    let combined = cipher
        .encrypt(nonce, plaintext.as_slice())
        .map_err(|_| "CRYPTO_ERROR: AES-256-GCM encryption failed.".to_string())?;

    if combined.len() < 16 {
        return Err("CRYPTO_ERROR: Unexpected ciphertext length.".to_string());
    }
    let split_at = combined.len() - 16;
    let (ciphertext, auth_tag) = combined.split_at(split_at);

    Ok(EncryptedVaultFile {
        format: "stockstudio-pro-license-vault-v1".to_string(),
        cipher: "aes-256-gcm".to_string(),
        kdf: "scrypt".to_string(),
        kdf_params: VaultKdfParams {
            n: 1u32 << SCRYPT_LOG_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            keylen: KEY_LEN,
        },
        salt_b64: B64.encode(salt),
        iv_b64: B64.encode(iv),
        auth_tag_b64: B64.encode(auth_tag),
        ciphertext_b64: B64.encode(ciphertext),
        created_at: Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    })
}

pub fn decrypt_vault_payload(
    vault: &EncryptedVaultFile,
    passphrase: &str,
) -> Result<VaultSecretPayload, String> {
    if vault.cipher != "aes-256-gcm" || vault.kdf != "scrypt" {
        return Err("CRYPTO_ERROR: Unsupported vault cipher or KDF.".to_string());
    }
    let salt = B64
        .decode(&vault.salt_b64)
        .map_err(|_| "CRYPTO_ERROR: Invalid salt_b64.".to_string())?;
    let iv = B64
        .decode(&vault.iv_b64)
        .map_err(|_| "CRYPTO_ERROR: Invalid iv_b64.".to_string())?;
    let auth_tag = B64
        .decode(&vault.auth_tag_b64)
        .map_err(|_| "CRYPTO_ERROR: Invalid auth_tag_b64.".to_string())?;
    let ciphertext = B64
        .decode(&vault.ciphertext_b64)
        .map_err(|_| "CRYPTO_ERROR: Invalid ciphertext_b64.".to_string())?;

    if iv.len() != 12 || auth_tag.len() != 16 {
        return Err("CRYPTO_ERROR: Invalid IV or GCM auth tag length.".to_string());
    }

    let log_n = (vault.kdf_params.n as f64).log2() as u8;
    let params = ScryptParams::new(
        log_n,
        vault.kdf_params.r,
        vault.kdf_params.p,
        vault.kdf_params.keylen,
    )
    .map_err(|e| format!("CRYPTO_ERROR: Invalid scrypt params ({e})"))?;

    let mut key = Zeroizing::new(vec![0u8; vault.kdf_params.keylen]);
    scrypt(passphrase.as_bytes(), &salt, &params, key.as_mut())
        .map_err(|e| format!("CRYPTO_ERROR: scrypt derivation failed ({e})"))?;

    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| "CRYPTO_ERROR: Invalid derived key length.".to_string())?;
    let nonce = Nonce::from_slice(&iv);

    let mut combined = Vec::with_capacity(ciphertext.len() + auth_tag.len());
    combined.extend_from_slice(&ciphertext);
    combined.extend_from_slice(&auth_tag);

    let plaintext = Zeroizing::new(
        cipher
            .decrypt(nonce, combined.as_slice())
            .map_err(|_| "CRYPTO_ERROR: Decryption failed (wrong passphrase or corrupted vault).".to_string())?,
    );

    serde_json::from_slice::<VaultSecretPayload>(&plaintext)
        .map_err(|e| format!("CRYPTO_ERROR: Invalid decrypted vault JSON ({e})"))
}

fn apply_windows_acl(path: &Path) {
    #[cfg(windows)]
    {
        if let Ok(username) = std::env::var("USERNAME") {
            let principal = match std::env::var("USERDOMAIN") {
                Ok(domain) if !domain.trim().is_empty() => format!("{domain}\\{username}"),
                _ => username,
            };
            let _ = Command::new("icacls")
                .arg(path)
                .arg("/inheritance:r")
                .arg("/grant:r")
                .arg(format!("{principal}:(R,W)"))
                .output();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
}

/// Encrypts and writes a `.enc.json` vault file, applies Windows NTFS ACL, and
/// verifies a full local decryption round-trip before returning success.
pub fn write_and_verify_vault_file(
    target_path: &Path,
    payload: &VaultSecretPayload,
    passphrase: &str,
) -> Result<String, String> {
    if !target_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.ends_with(".enc.json"))
        .unwrap_or(false)
    {
        return Err("INVALID_REQUEST: Export file path must end with '.enc.json'.".to_string());
    }
    if target_path.exists() {
        return Err(
            "FILE_EXISTS: Refusing to overwrite an existing encrypted vault file.".to_string(),
        );
    }
    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("IO_ERROR: Unable to create export directory ({e})"))?;
        }
    }

    let vault = encrypt_vault_payload(payload, passphrase)?;
    let serialized = serde_json::to_string_pretty(&vault)
        .map_err(|e| format!("IO_ERROR: Failed formatting vault JSON ({e})"))?;

    if serialized.contains(&payload.license_key) {
        return Err("CRYPTO_ERROR: Plaintext key detected in encrypted output; aborted.".to_string());
    }

    fs::write(target_path, &serialized)
        .map_err(|e| format!("IO_ERROR: Failed writing encrypted vault file ({e})"))?;
    apply_windows_acl(target_path);

    // Mandatory round-trip decryption verification
    let on_disk_raw = fs::read_to_string(target_path)
        .map_err(|e| format!("IO_ERROR: Failed reading back encrypted vault ({e})"))?;
    let on_disk: EncryptedVaultFile = serde_json::from_str(&on_disk_raw)
        .map_err(|e| format!("CRYPTO_ERROR: Failed parsing written vault ({e})"))?;
    let round_trip = decrypt_vault_payload(&on_disk, passphrase)?;
    if round_trip.license_key != payload.license_key || round_trip.license_id != payload.license_id
    {
        let _ = fs::remove_file(target_path);
        return Err("CRYPTO_ERROR: Vault decryption round-trip mismatch; file removed.".to_string());
    }

    Ok(target_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_vault_round_trip_and_wrong_passphrase_rejection() {
        let tmp_dir = std::env::temp_dir().join(format!("sspro-lm04-vault-{}", uuid::Uuid::new_v4()));
        let target = tmp_dir.join("customer-test.enc.json");

        let payload = VaultSecretPayload {
            environment: "staging".to_string(),
            api_url: "https://stockstudio-pro-license-staging.pages.dev".to_string(),
            license_id: "lic_01VAULTTEST".to_string(),
            key_prefix: "SSPRO-VAUL".to_string(),
            license_key: "SSPRO-VAUL-1111-2222-3333".to_string(),
            issued_at: "2026-11-23T16:00:00Z".to_string(),
        };

        let pass = "Strong-LM04-Test-Passphrase-2026!";
        let written = write_and_verify_vault_file(&target, &payload, pass).unwrap();
        assert!(written.ends_with(".enc.json"));

        let disk_text = fs::read_to_string(&target).unwrap();
        assert!(!disk_text.contains(&payload.license_key));

        let parsed: EncryptedVaultFile = serde_json::from_str(&disk_text).unwrap();
        let decrypted = decrypt_vault_payload(&parsed, pass).unwrap();
        assert_eq!(decrypted.license_key, payload.license_key);
        assert_eq!(decrypted.license_id, payload.license_id);

        let bad = decrypt_vault_payload(&parsed, "Wrong-Passphrase-Should-Reject!!");
        assert!(bad.is_err());

        // Refuses overwrite
        let overwrite_err = write_and_verify_vault_file(&target, &payload, pass).unwrap_err();
        assert!(overwrite_err.contains("FILE_EXISTS"));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn rejects_short_passphrase() {
        let payload = VaultSecretPayload {
            environment: "staging".to_string(),
            api_url: "https://example.com".to_string(),
            license_id: "lic_01SHORT".to_string(),
            key_prefix: "SSPRO-SHOR".to_string(),
            license_key: "SSPRO-SHOR-1111-2222-3333".to_string(),
            issued_at: "2026-11-23T16:00:00Z".to_string(),
        };
        let err = encrypt_vault_payload(&payload, "too-short").unwrap_err();
        assert!(err.contains("at least 16"));
    }

    #[test]
    fn rejects_corrupted_ciphertext_and_tampered_auth_tag() {
        let payload = VaultSecretPayload {
            environment: "staging".to_string(),
            api_url: "https://stockstudio-pro-license-staging.pages.dev".to_string(),
            license_id: "lic_01TAMPER".to_string(),
            key_prefix: "SSPRO-TAMP".to_string(),
            license_key: "SSPRO-TAMP-1111-2222-3333".to_string(),
            issued_at: "2026-11-23T16:00:00Z".to_string(),
        };
        let pass = "Strong-LM06-Tamper-Test-Passphrase!";
        let vault = encrypt_vault_payload(&payload, pass).unwrap();

        // Corrupt ciphertext
        let mut tampered_ct = vault.clone();
        let mut ct_bytes = B64.decode(&tampered_ct.ciphertext_b64).unwrap();
        ct_bytes[0] ^= 0xFF;
        tampered_ct.ciphertext_b64 = B64.encode(ct_bytes);
        assert!(decrypt_vault_payload(&tampered_ct, pass).is_err());

        // Corrupt GCM authentication tag
        let mut tampered_tag = vault;
        let mut tag_bytes = B64.decode(&tampered_tag.auth_tag_b64).unwrap();
        tag_bytes[0] ^= 0xAA;
        tampered_tag.auth_tag_b64 = B64.encode(tag_bytes);
        assert!(decrypt_vault_payload(&tampered_tag, pass).is_err());
    }
}
