use url::Url;

use crate::error::LicenseCoreError;

/// Staging development default base URL (compiled into debug/development builds ONLY
/// when `STOCKSTUDIO_LICENSE_API_URL` is not explicitly set).
/// Production (`!debug_assertions`) builds NEVER inherit this value.
#[cfg(debug_assertions)]
const DEFAULT_DEV_API_BASE_URL: &str =
    "https://stockstudio-pro-license-api-staging.dekadk00.workers.dev";

/// Public Ed25519 verifying key for Cloudflare staging, embedded in development
/// (`debug_assertions`) builds ONLY so `npm run tauri dev` restores sessions and
/// verifies offline leases cleanly after Windows restarts without temporary env vars.
/// Never embed private signing keys, API secrets, admin tokens, or license keys.
#[cfg(debug_assertions)]
const EMBEDDED_DEV_VERIFYING_KEYS: &[(&str, &str)] = &[(
    "sspro-ed25519-staging-01",
    "s82p+o4cwF90SFxmqAdodHW/iwjJ+hddSiTZufN7H14=",
)];

/// Public Ed25519 verifying keys compiled into production (`!debug_assertions`) binaries.
/// Strictly isolated from development/staging keys.
#[cfg(not(debug_assertions))]
const EMBEDDED_PROD_VERIFYING_KEYS: &[(&str, &str)] = &[(
    "sspro-ed25519-prod-01",
    "uy1Hyu3NEm9K1SLIdh2P7CEckfAjKBC8/Cn334jygjc=",
)];

pub fn validate_api_base_url(raw: &str) -> Result<String, LicenseCoreError> {
    let parsed = Url::parse(raw.trim()).map_err(|_| LicenseCoreError::InvalidApiUrl)?;
    let host = parsed
        .host_str()
        .ok_or(LicenseCoreError::InvalidApiUrl)?
        .to_ascii_lowercase();

    let is_local_loopback = host == "127.0.0.1" || host == "localhost" || host == "::1";
    if parsed.scheme() == "https" {
        // Never allow legacy Flowpilot host
        if host.contains("flowpilot") {
            return Err(LicenseCoreError::UnsupportedApiUrl);
        }
    } else if parsed.scheme() == "http" && cfg!(debug_assertions) && is_local_loopback {
        // Allowed only for local Wrangler dev in debug builds
    } else {
        return Err(LicenseCoreError::ApiRequiresHttps);
    }

    Ok(raw.trim().trim_end_matches('/').to_string())
}

pub fn resolve_api_base_url_for_mode(
    runtime_env: Option<String>,
    compile_env: Option<String>,
    is_debug_build: bool,
) -> Result<String, LicenseCoreError> {
    let raw = match runtime_env.or(compile_env) {
        Some(url) => url,
        None => {
            if is_debug_build {
                #[cfg(debug_assertions)]
                {
                    DEFAULT_DEV_API_BASE_URL.to_string()
                }
                #[cfg(not(debug_assertions))]
                {
                    return Err(LicenseCoreError::ApiNotConfigured);
                }
            } else {
                return Err(LicenseCoreError::ApiNotConfigured);
            }
        }
    };

    validate_api_base_url(&raw)
}

pub fn resolve_api_base_url() -> Result<String, LicenseCoreError> {
    let runtime_env = std::env::var("STOCKSTUDIO_LICENSE_API_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let compile_env = option_env!("STOCKSTUDIO_LICENSE_API_URL")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    resolve_api_base_url_for_mode(runtime_env, compile_env, cfg!(debug_assertions))
}

pub fn resolve_verifying_keys_for_mode(
    runtime_key: Option<(Option<String>, String)>,
    compile_key: Option<(Option<String>, String)>,
    is_debug_build: bool,
) -> Vec<(Option<String>, String)> {
    let mut keys: Vec<(Option<String>, String)> = Vec::new();

    if let Some((kid, pub_b64)) = runtime_key {
        keys.push((kid, pub_b64));
    }

    if let Some((kid, pub_b64)) = compile_key {
        keys.push((kid, pub_b64));
    }

    if is_debug_build {
        #[cfg(debug_assertions)]
        for &(kid, pub_b64) in EMBEDDED_DEV_VERIFYING_KEYS {
            keys.push((Some(kid.to_string()), pub_b64.to_string()));
        }
    } else {
        #[cfg(not(debug_assertions))]
        for &(kid, pub_b64) in EMBEDDED_PROD_VERIFYING_KEYS {
            keys.push((Some(kid.to_string()), pub_b64.to_string()));
        }
    }

    keys
}

pub fn resolve_verifying_keys() -> Vec<(Option<String>, String)> {
    let runtime_key = std::env::var("STOCKSTUDIO_LICENSE_PUBLIC_KEY_BASE64")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|pub_b64| {
            let kid = std::env::var("STOCKSTUDIO_LICENSE_SIGNING_KID")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            (kid, pub_b64)
        });

    let compile_key = option_env!("STOCKSTUDIO_LICENSE_PUBLIC_KEY_BASE64")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|pub_b64| {
            let kid = option_env!("STOCKSTUDIO_LICENSE_SIGNING_KID")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            (kid, pub_b64)
        });

    resolve_verifying_keys_for_mode(runtime_key, compile_key, cfg!(debug_assertions))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_mode_never_inherits_staging_keys() {
        let prod_keys = resolve_verifying_keys_for_mode(None, None, false);
        assert!(
            !prod_keys
                .iter()
                .any(|(kid, _)| kid.as_deref() == Some("sspro-ed25519-staging-01")),
            "production builds must never inherit staging verifying keys"
        );
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_build_embeds_verified_production_ed25519_key() {
        use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
        use base64::Engine;
        use ed25519_dalek::VerifyingKey;

        let prod_keys = resolve_verifying_keys_for_mode(None, None, false);
        let entry = prod_keys
            .iter()
            .find(|(kid, _)| kid.as_deref() == Some("sspro-ed25519-prod-01"))
            .expect("release build must embed sspro-ed25519-prod-01");
        assert_eq!(entry.1, "uy1Hyu3NEm9K1SLIdh2P7CEckfAjKBC8/Cn334jygjc=");
        let decoded = BASE64_STANDARD
            .decode(entry.1.trim())
            .expect("embedded production public key must be valid base64");
        assert_eq!(decoded.len(), 32, "Ed25519 public key must be 32 bytes");
        assert!(
            VerifyingKey::from_bytes(&decoded.try_into().unwrap()).is_ok(),
            "embedded production public key must be a valid Ed25519 verifying key"
        );
    }
}
