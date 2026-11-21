use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL};
use base64::Engine;
use chrono::{TimeZone, Utc};
use ed25519_dalek::{Signer, SigningKey};
use uuid::Uuid;

use stockstudio_license_core::{
    compute_device_fingerprint, evaluate_offline_lease, evaluate_product_verdict, read_state_file,
    record_clock_anchor, verify_signed_lease_token, write_state_file_atomic, DeviceIdentity,
    LicenseCoreError, LicenseEntitlements, LicenseState, ProductEntitlement, SecretStore,
    EXPECTED_ISSUER, PRODUCT_ID,
};

#[derive(Default)]
struct InMemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for InMemorySecretStore {
    fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.map.lock().unwrap().get(account).cloned())
    }
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        self.map
            .lock()
            .unwrap()
            .insert(account.to_string(), value.to_string());
        Ok(())
    }
    fn delete_secret(&self, account: &str) -> Result<(), String> {
        self.map.lock().unwrap().remove(account);
        Ok(())
    }
}

fn make_keypair(seed_byte: u8) -> (SigningKey, String) {
    let signing_key = SigningKey::from_bytes(&[seed_byte; 32]);
    let pub_b64 = BASE64_STANDARD.encode(signing_key.verifying_key().as_bytes());
    (signing_key, pub_b64)
}

fn sign_payload(signing_key: &SigningKey, payload: &serde_json::Value) -> String {
    let encoded_payload = BASE64_URL.encode(serde_json::to_vec(payload).unwrap());
    let signing_input = format!("v1.{encoded_payload}");
    let sig = signing_key.sign(signing_input.as_bytes());
    let encoded_sig = BASE64_URL.encode(sig.to_bytes());
    format!("v1.{encoded_payload}.{encoded_sig}")
}

fn test_identity() -> DeviceIdentity {
    DeviceIdentity {
        device_id: Uuid::new_v4().to_string(),
        device_fingerprint: compute_device_fingerprint("test-machine-guid", "x86_64"),
        device_name: "TEST-WORKSTATION".to_string(),
        platform: "windows",
        os_version: "windows".to_string(),
        arch: "x86_64",
    }
}

fn build_lease_json(
    identity: &DeviceIdentity,
    kid: &str,
    license_type: &str,
    status: &str,
    iat: &str,
    exp: &str,
    expires_at: Option<&str>,
    entitlements: serde_json::Value,
) -> serde_json::Value {
    let is_perpetual = license_type == "perpetual";
    serde_json::json!({
        "ver": 1,
        "kid": kid,
        "jti": "lse_01CORE00000000000000000000",
        "iss": EXPECTED_ISSUER,
        "aud": PRODUCT_ID,
        "iat": iat,
        "exp": exp,
        "offline_grace_until": exp,
        "license_id": "lic_01CORE00000000000000000000",
        "activation_id": "act_01CORE00000000000000000000",
        "device_id": identity.device_id,
        "device_fingerprint": identity.device_fingerprint,
        "plan_code": if is_perpetual { "lifetime" } else { "pro_monthly" },
        "plan_name": if is_perpetual { "Lifetime" } else { "30 Days" },
        "license_type": license_type,
        "billing_interval": if is_perpetual { "lifetime" } else { "monthly" },
        "status": status,
        "lifetime": is_perpetual,
        "expires_at": expires_at,
        "current_period_start": if is_perpetual { serde_json::Value::Null } else { serde_json::json!(iat) },
        "current_period_end": expires_at,
        "cancel_at_period_end": false,
        "device_limit": 2,
        "devices_used": 1,
        "entitlements": entitlements
    })
}

fn temp_dir_for(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sspro-core-test-{name}-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn verifies_valid_and_rejects_invalid_ed25519_signatures() {
    let (signing_key, pub_b64) = make_keypair(7);
    let (wrong_key, _) = make_keypair(99);
    let identity = test_identity();
    let keys = vec![(Some("kid-01".to_string()), pub_b64)];

    let payload = build_lease_json(
        &identity,
        "kid-01",
        "perpetual",
        "active",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        None,
        serde_json::json!({ "features": ["google_flow_workspace"] }),
    );

    let valid_token = sign_payload(&signing_key, &payload);
    let verified = verify_signed_lease_token(
        &valid_token,
        &keys,
        &identity.device_id,
        &identity.device_fingerprint,
    )
    .expect("valid Ed25519 signature must pass");
    assert_eq!(verified.kid, "kid-01");
    assert!(verified.lifetime);

    let wrong_sig_token = sign_payload(&wrong_key, &payload);
    let err = verify_signed_lease_token(
        &wrong_sig_token,
        &keys,
        &identity.device_id,
        &identity.device_fingerprint,
    )
    .expect_err("wrong signing key must fail");
    assert_eq!(err, LicenseCoreError::InvalidLeaseSignature);
}

#[test]
fn rejects_unknown_signing_key_id() {
    let (signing_key, pub_b64) = make_keypair(11);
    let identity = test_identity();
    let keys = vec![(Some("kid-known-01".to_string()), pub_b64)];

    let payload = build_lease_json(
        &identity,
        "kid-unknown-99",
        "perpetual",
        "active",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        None,
        serde_json::json!({}),
    );
    let token = sign_payload(&signing_key, &payload);

    let err = verify_signed_lease_token(
        &token,
        &keys,
        &identity.device_id,
        &identity.device_fingerprint,
    )
    .expect_err("unknown kid must be rejected");
    assert_eq!(err, LicenseCoreError::UnknownSigningKeyId);
}

#[test]
fn evaluates_perpetual_and_active_vs_expired_subscription_and_cap() {
    let (signing_key, pub_b64) = make_keypair(15);
    let identity = test_identity();
    let keys = vec![(Some("kid-01".to_string()), pub_b64)];
    let secrets = InMemorySecretStore::default();

    // 1. Perpetual license within 7-day grace
    let perp_payload = build_lease_json(
        &identity,
        "kid-01",
        "perpetual",
        "active",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        None,
        serde_json::json!({}),
    );
    let perp_state = LicenseState {
        device_id: identity.device_id.clone(),
        lease_token: sign_payload(&signing_key, &perp_payload),
        ..Default::default()
    };
    let day5 = Utc.with_ymd_and_hms(2026, 11, 25, 12, 0, 0).unwrap();
    let ok_perp = evaluate_offline_lease(&perp_state, &keys, &identity, &secrets, day5)
        .expect("perpetual license within 7 days must succeed");
    assert!(ok_perp.lifetime);
    assert!(ok_perp.is_offline_grace);

    // 2. Active subscription within both 7-day grace and expires_at
    let sub_secrets = InMemorySecretStore::default();
    let sub_payload = build_lease_json(
        &identity,
        "kid-01",
        "subscription",
        "active",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        Some("2026-11-23T12:00:00Z"), // expires in 3 days (shorter than 7-day lease!)
        serde_json::json!({}),
    );
    let sub_state = LicenseState {
        device_id: identity.device_id.clone(),
        lease_token: sign_payload(&signing_key, &sub_payload),
        ..Default::default()
    };
    let day2 = Utc.with_ymd_and_hms(2026, 11, 22, 12, 0, 0).unwrap();
    let ok_sub = evaluate_offline_lease(&sub_state, &keys, &identity, &sub_secrets, day2)
        .expect("active subscription before expires_at must succeed");
    assert!(!ok_sub.lifetime);
    assert_eq!(ok_sub.license_type, "subscription");

    // 3. Subscription expiration cap enforced even though 7-day lease has not ended
    let day4 = Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap();
    let cap_err = evaluate_offline_lease(&sub_state, &keys, &identity, &sub_secrets, day4)
        .expect_err("subscription must not exceed expires_at");
    assert_eq!(cap_err, LicenseCoreError::LicenseExpired);
}

#[test]
fn enforces_seven_day_offline_grace_ceiling_and_five_minute_clock_rollback() {
    let (signing_key, pub_b64) = make_keypair(21);
    let identity = test_identity();
    let keys = vec![(Some("kid-01".to_string()), pub_b64)];
    let secrets = InMemorySecretStore::default();

    // Even if a lease claims exp = 30 days, hard 7-day offline ceiling must apply
    let payload = build_lease_json(
        &identity,
        "kid-01",
        "perpetual",
        "active",
        "2026-11-20T12:00:00Z",
        "2026-12-20T12:00:00Z",
        None,
        serde_json::json!({}),
    );
    let saved = LicenseState {
        device_id: identity.device_id.clone(),
        lease_token: sign_payload(&signing_key, &payload),
        ..Default::default()
    };

    // Within 5-minute clock rollback tolerance against iat (4m59s earlier) -> allowed
    let within_tol = Utc.with_ymd_and_hms(2026, 11, 20, 11, 55, 1).unwrap();
    assert!(evaluate_offline_lease(&saved, &keys, &identity, &secrets, within_tol).is_ok());

    // Beyond 5-minute clock rollback against iat (5m01s earlier) -> rejected
    let past_tol = Utc.with_ymd_and_hms(2026, 11, 20, 11, 54, 59).unwrap();
    assert_eq!(
        evaluate_offline_lease(&saved, &keys, &identity, &secrets, past_tol),
        Err(LicenseCoreError::ClockRollbackDetected)
    );

    // Record clock anchor at day 3, then roll back 6 minutes -> rejected
    let day3 = Utc.with_ymd_and_hms(2026, 11, 23, 12, 0, 0).unwrap();
    record_clock_anchor(&secrets, day3);
    let rolled_back_anchor = Utc.with_ymd_and_hms(2026, 11, 23, 11, 54, 0).unwrap();
    assert_eq!(
        evaluate_offline_lease(&saved, &keys, &identity, &secrets, rolled_back_anchor),
        Err(LicenseCoreError::ClockRollbackDetected)
    );

    // Hard 7-day ceiling (7d + 1s after iat) -> rejected despite 30-day exp claim
    let day7_plus_1s = Utc.with_ymd_and_hms(2026, 11, 27, 12, 0, 1).unwrap();
    assert_eq!(
        evaluate_offline_lease(&saved, &keys, &identity, &secrets, day7_plus_1s),
        Err(LicenseCoreError::OfflineGraceExpired)
    );
}

#[test]
fn parses_product_entitlements_without_silently_granting_extension_to_legacy_licenses() {
    // Legacy license (no `products` field) -> desktop allowed, extension NOT silently granted
    let legacy: LicenseEntitlements = serde_json::from_value(serde_json::json!({
        "features": ["google_flow_workspace", "multi_account_manager"]
    }))
    .unwrap();
    assert!(legacy.is_product_entitled(ProductEntitlement::Desktop));
    assert!(!legacy.is_product_entitled(ProductEntitlement::VectorizerExtension));

    // Unified license explicitly listing both products -> both allowed
    let unified: LicenseEntitlements = serde_json::from_value(serde_json::json!({
        "products": ["desktop", "vectorizer_extension"],
        "features": ["google_flow_workspace"]
    }))
    .unwrap();
    assert!(unified.is_product_entitled(ProductEntitlement::Desktop));
    assert!(unified.is_product_entitled(ProductEntitlement::VectorizerExtension));

    // Evaluate sanitized verdict -> never exposes secrets and enforces product entitlement
    let (signing_key, pub_b64) = make_keypair(33);
    let identity = test_identity();
    let keys = vec![(Some("kid-01".to_string()), pub_b64)];
    let secrets = InMemorySecretStore::default();
    let now = Utc.with_ymd_and_hms(2026, 11, 21, 12, 0, 0).unwrap();

    let legacy_lease = build_lease_json(
        &identity,
        "kid-01",
        "perpetual",
        "active",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        None,
        serde_json::json!({ "features": ["google_flow_workspace"] }),
    );
    let legacy_saved = LicenseState {
        device_id: identity.device_id.clone(),
        lease_token: sign_payload(&signing_key, &legacy_lease),
        ..Default::default()
    };
    let ext_verdict = evaluate_product_verdict(
        Some(&legacy_saved),
        &keys,
        &identity,
        &secrets,
        ProductEntitlement::VectorizerExtension,
        now,
    );
    assert!(!ext_verdict.authorized);
    assert_eq!(
        ext_verdict.error_code.as_deref(),
        Some("PRODUCT_NOT_ENTITLED")
    );
}

#[test]
fn handles_corrupted_persisted_state_and_atomic_writes_cleanly() {
    let dir = temp_dir_for("atomic-storage");
    let state_path = dir.join("license-state.json");

    // 1. Corrupted JSON rejected with typed error
    fs::write(&state_path, "{ invalid json").unwrap();
    assert!(matches!(
        read_state_file(&state_path),
        Err(LicenseCoreError::CorruptedPersistedState(_))
    ));

    // 2. Empty file rejected with typed error
    fs::write(&state_path, "   ").unwrap();
    assert!(matches!(
        read_state_file(&state_path),
        Err(LicenseCoreError::CorruptedPersistedState(_))
    ));

    // 3. Atomic write overwrites cleanly and leaves no lingering .tmp files
    let state1 = LicenseState {
        plan: "Lifetime".to_string(),
        status: "active".to_string(),
        lifetime: true,
        device_id: Uuid::new_v4().to_string(),
        ..Default::default()
    };
    write_state_file_atomic(&state_path, &state1).expect("first atomic write must succeed");
    assert_eq!(read_state_file(&state_path).unwrap(), Some(state1));

    let state2 = LicenseState {
        plan: "30 Days".to_string(),
        status: "active".to_string(),
        lifetime: false,
        device_id: Uuid::new_v4().to_string(),
        ..Default::default()
    };
    write_state_file_atomic(&state_path, &state2).expect("second atomic write must succeed");
    assert_eq!(read_state_file(&state_path).unwrap(), Some(state2));

    let lingering_tmps: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        lingering_tmps.is_empty(),
        "atomic write must not leave lingering .tmp files"
    );

    let _ = fs::remove_dir_all(&dir);
}
