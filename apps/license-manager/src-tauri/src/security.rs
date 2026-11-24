#[cfg(test)]
use std::collections::HashMap;
use std::fmt;
#[cfg(test)]
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::api::AdminMeResponse;

/// Isolated Windows Credential Manager service name per LM-01.
/// MUST NEVER match the customer desktop service name ("StockStudioPro").
pub const KEYRING_SERVICE_NAME: &str = "StockStudioPro-LicenseManager-Admin";

pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 900; // 15 minutes
pub const MIN_IDLE_TIMEOUT_SECS: u64 = 60;
pub const MAX_IDLE_TIMEOUT_SECS: u64 = 3600;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Staging,
    Production,
}

impl Environment {
    pub fn base_url(self) -> &'static str {
        match self {
            Environment::Staging => "https://stockstudio-pro-license-staging.pages.dev",
            Environment::Production => "https://stockstudio-pro-license-production.pages.dev",
        }
    }

    pub fn keyring_account(self) -> &'static str {
        match self {
            Environment::Staging => "staging-admin-key",
            Environment::Production => "production-admin-key",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Environment::Staging => "staging",
            Environment::Production => "production",
        }
    }
}

/// Credential persistence abstraction so production uses Windows Credential Manager
/// while unit tests use an isolated in-memory store.
pub trait AdminCredentialStore: Send + Sync {
    fn get_key(&self, env: Environment) -> Result<Option<Zeroizing<String>>, String>;
    fn set_key(&self, env: Environment, secret: &str) -> Result<(), String>;
    fn delete_key(&self, env: Environment) -> Result<(), String>;
    fn has_key(&self, env: Environment) -> bool {
        matches!(self.get_key(env), Ok(Some(_)))
    }
}

pub struct WindowsKeyringStore;

impl AdminCredentialStore for WindowsKeyringStore {
    fn get_key(&self, env: Environment) -> Result<Option<Zeroizing<String>>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, env.keyring_account())
            .map_err(|e| format!("Keyring initialization failed: {e}"))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Failed to read stored admin credential: {e}")),
        }
    }

    fn set_key(&self, env: Environment, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, env.keyring_account())
            .map_err(|e| format!("Keyring initialization failed: {e}"))?;
        entry
            .set_password(secret)
            .map_err(|e| format!("Failed to save admin credential to Windows Credential Manager: {e}"))
    }

    fn delete_key(&self, env: Environment) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, env.keyring_account())
            .map_err(|e| format!("Keyring initialization failed: {e}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Failed to remove stored admin credential: {e}")),
        }
    }
}

/// Sanitized session status returned to React. NEVER contains the admin key.
#[derive(Debug, Clone, Serialize)]
pub struct SessionStatusDto {
    pub unlocked: bool,
    pub environment: Environment,
    pub api_base_url: String,
    pub has_stored_credential: bool,
    pub idle_timeout_secs: u64,
    pub idle_remaining_secs: u64,
    pub credential_service: String,
    pub admin_me: Option<AdminMeResponse>,
    pub locked_reason: Option<String>,
}

pub struct AppSecurityState {
    environment: Environment,
    active_key: Option<Zeroizing<String>>,
    admin_me: Option<AdminMeResponse>,
    last_activity: Instant,
    idle_timeout_secs: u64,
    locked_reason: Option<String>,
    store: Box<dyn AdminCredentialStore>,
}

impl fmt::Debug for AppSecurityState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppSecurityState")
            .field("environment", &self.environment)
            .field("active_key", &self.active_key.as_ref().map(|_| "[REDACTED]"))
            .field("unlocked", &self.active_key.is_some())
            .field("idle_timeout_secs", &self.idle_timeout_secs)
            .finish()
    }
}

impl AppSecurityState {
    pub fn new(store: Box<dyn AdminCredentialStore>) -> Self {
        Self {
            environment: Environment::Staging,
            active_key: None,
            admin_me: None,
            last_activity: Instant::now(),
            idle_timeout_secs: DEFAULT_IDLE_TIMEOUT_SECS,
            locked_reason: None,
            store,
        }
    }

    pub fn environment(&self) -> Environment {
        self.environment
    }

    pub fn set_environment(&mut self, env: Environment) {
        if self.environment != env {
            self.environment = env;
            self.lock_with_reason(Some("Environment switched — session locked for safety.".to_string()));
        }
    }

    pub fn set_idle_timeout_secs(&mut self, secs: u64) -> Result<(), String> {
        if !(MIN_IDLE_TIMEOUT_SECS..=MAX_IDLE_TIMEOUT_SECS).contains(&secs) {
            return Err(format!(
                "Idle timeout must be between {MIN_IDLE_TIMEOUT_SECS} and {MAX_IDLE_TIMEOUT_SECS} seconds."
            ));
        }
        self.idle_timeout_secs = secs;
        self.last_activity = Instant::now();
        Ok(())
    }

    pub fn enforce_idle_lock(&mut self) -> bool {
        if self.active_key.is_some()
            && self.last_activity.elapsed() >= Duration::from_secs(self.idle_timeout_secs)
        {
            self.lock_with_reason(Some("Session locked automatically due to inactivity.".to_string()));
            return true;
        }
        false
    }

    pub fn touch(&mut self) {
        if self.active_key.is_some() {
            self.last_activity = Instant::now();
        }
    }

    pub fn unlock(&mut self, key: Zeroizing<String>, profile: AdminMeResponse) {
        self.active_key = Some(key);
        self.admin_me = Some(profile);
        self.last_activity = Instant::now();
        self.locked_reason = None;
    }

    pub fn update_profile(&mut self, profile: AdminMeResponse) {
        if self.active_key.is_some() {
            self.admin_me = Some(profile);
        }
    }

    pub fn lock(&mut self) {
        self.lock_with_reason(Some("Session locked by administrator.".to_string()));
    }

    /// Automatically locks and zeroizes the session if the server rejects the
    /// active credential (e.g., 401 UNAUTHORIZED_TOKEN).
    pub fn lock_if_unauthorized(&mut self, err: &str) {
        if err.starts_with("UNAUTHORIZED_TOKEN:") || err.starts_with("HTTP_401:") {
            self.lock_with_reason(Some(
                "Session locked automatically after authentication rejection (401).".to_string(),
            ));
        }
    }

    fn lock_with_reason(&mut self, reason: Option<String>) {
        // Dropping Zeroizing<String> immediately zeroes the underlying heap buffer.
        self.active_key = None;
        self.admin_me = None;
        self.locked_reason = reason;
    }

    pub fn get_active_key_and_env(&mut self) -> Result<(Zeroizing<String>, Environment), String> {
        if self.enforce_idle_lock() {
            return Err("SESSION_LOCKED: Session expired due to inactivity. Please unlock again.".to_string());
        }
        match &self.active_key {
            Some(k) => {
                self.last_activity = Instant::now();
                Ok((k.clone(), self.environment))
            }
            None => Err("SESSION_LOCKED: License Manager is locked. Unlock with your Admin API key.".to_string()),
        }
    }

    pub fn has_permission(&self, permission: &str) -> bool {
        self.admin_me
            .as_ref()
            .map(|me| me.admin.permissions.iter().any(|p| p == permission))
            .unwrap_or(false)
    }

    pub fn store(&self) -> &dyn AdminCredentialStore {
        self.store.as_ref()
    }

    pub fn status(&mut self) -> SessionStatusDto {
        self.enforce_idle_lock();
        let unlocked = self.active_key.is_some();
        let elapsed = self.last_activity.elapsed().as_secs();
        let idle_remaining_secs = if unlocked {
            self.idle_timeout_secs.saturating_sub(elapsed)
        } else {
            0
        };
        SessionStatusDto {
            unlocked,
            environment: self.environment,
            api_base_url: self.environment.base_url().to_string(),
            has_stored_credential: self.store.has_key(self.environment),
            idle_timeout_secs: self.idle_timeout_secs,
            idle_remaining_secs,
            credential_service: KEYRING_SERVICE_NAME.to_string(),
            admin_me: self.admin_me.clone(),
            locked_reason: self.locked_reason.clone(),
        }
    }
}

#[cfg(test)]
pub struct InMemoryCredentialStore {
    entries: Mutex<HashMap<Environment, Zeroizing<String>>>,
}

#[cfg(test)]
impl Default for InMemoryCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl InMemoryCredentialStore {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
impl AdminCredentialStore for InMemoryCredentialStore {
    fn get_key(&self, env: Environment) -> Result<Option<Zeroizing<String>>, String> {
        let guard = self.entries.lock().unwrap();
        Ok(guard.get(&env).cloned())
    }

    fn set_key(&self, env: Environment, secret: &str) -> Result<(), String> {
        let mut guard = self.entries.lock().unwrap();
        guard.insert(env, Zeroizing::new(secret.to_string()));
        Ok(())
    }

    fn delete_key(&self, env: Environment) -> Result<(), String> {
        let mut guard = self.entries.lock().unwrap();
        guard.remove(&env);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::AdminIdentityDto;

    fn sample_me(env: &str) -> AdminMeResponse {
        AdminMeResponse {
            ok: true,
            admin: AdminIdentityDto {
                id: "adm_01TEST".to_string(),
                name: "Test Admin".to_string(),
                key_prefix: "ssadm_01TEST".to_string(),
                role: "super_admin".to_string(),
                permissions: vec!["licenses:read".to_string(), "stats:read".to_string()],
                allowed_ips_configured: false,
                expires_at: None,
                last_used_at: Some("2026-11-23T15:00:00Z".to_string()),
            },
            environment: env.to_string(),
            signing_kid: "sspro-ed25519-staging-01".to_string(),
            server_time: "2026-11-23T15:00:00Z".to_string(),
        }
    }

    #[test]
    fn debug_output_never_exposes_secret_key() {
        let mut state = AppSecurityState::new(Box::new(InMemoryCredentialStore::new()));
        let secret = "ssadm_01SECRET_SHOULD_NEVER_APPEAR_IN_DEBUG";
        state.unlock(Zeroizing::new(secret.to_string()), sample_me("staging"));
        let debug_text = format!("{state:?}");
        assert!(!debug_text.contains(secret));
        assert!(debug_text.contains("[REDACTED]"));
    }

    #[test]
    fn switching_environment_locks_active_session() {
        let mut state = AppSecurityState::new(Box::new(InMemoryCredentialStore::new()));
        state.unlock(Zeroizing::new("ssadm_01TEST_SECRET".to_string()), sample_me("staging"));
        assert!(state.status().unlocked);

        state.set_environment(Environment::Production);
        let status = state.status();
        assert!(!status.unlocked);
        assert_eq!(status.environment, Environment::Production);
        assert!(status.admin_me.is_none());
        assert!(state.get_active_key_and_env().is_err());
    }

    #[test]
    fn idle_timeout_automatically_locks_session() {
        let mut state = AppSecurityState::new(Box::new(InMemoryCredentialStore::new()));
        state.unlock(Zeroizing::new("ssadm_01TEST_SECRET".to_string()), sample_me("staging"));
        state.idle_timeout_secs = 60;
        state.last_activity = Instant::now() - Duration::from_secs(65);

        assert!(state.enforce_idle_lock());
        let status = state.status();
        assert!(!status.unlocked);
        assert!(status.locked_reason.unwrap_or_default().contains("inactivity"));
    }

    #[test]
    fn keyring_service_is_isolated_from_customer_app() {
        assert_ne!(KEYRING_SERVICE_NAME, "StockStudioPro");
        assert!(KEYRING_SERVICE_NAME.contains("LicenseManager"));
    }

    #[test]
    fn locks_and_zeroizes_session_on_401_unauthorized() {
        let mut state = AppSecurityState::new(Box::new(InMemoryCredentialStore::new()));
        state.unlock(Zeroizing::new("ssadm_01REVOKED".to_string()), sample_me("staging"));
        assert!(state.status().unlocked);

        state.lock_if_unauthorized("UNAUTHORIZED_TOKEN: Admin key revoked");
        let status = state.status();
        assert!(!status.unlocked);
        assert!(status.admin_me.is_none());
        assert!(status.locked_reason.unwrap_or_default().contains("401"));
    }
}
