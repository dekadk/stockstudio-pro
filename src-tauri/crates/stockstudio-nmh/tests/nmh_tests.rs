use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL};
use base64::Engine;
use chrono::{TimeZone, Utc};
use ed25519_dalek::{Signer, SigningKey};
use uuid::Uuid;

use stockstudio_license_core::{
    compute_device_fingerprint, record_clock_anchor, write_state_file_atomic, LicenseState,
    SecretStore, EXPECTED_ISSUER, KEYRING_DEVICE_ID, PRODUCT_ID,
};
use stockstudio_nmh::framing::{read_frame, write_frame, FramingError, MAX_INBOUND_MESSAGE_BYTES};
use stockstudio_nmh::host::{handle_request_json, run_once, HostContext};
use stockstudio_nmh::manifest::{
    build_host_manifest_json, is_valid_chrome_extension_id, NativeHostManifest, NATIVE_HOST_NAME,
    NATIVE_HOST_REGISTRY_SUBKEY,
};
use stockstudio_nmh::protocol::NativeResponse;

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

fn temp_state_path(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sspro-nmh-test-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir.join("license-state.json")
}

fn frame_bytes(json: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    write_frame(&mut buf, json.as_bytes()).unwrap();
    buf
}

fn seed_signed_state(
    state_path: &PathBuf,
    secrets: &InMemorySecretStore,
    signing_key: &SigningKey,
    machine_guid: &str,
    license_type: &str,
    iat: &str,
    exp: &str,
    expires_at: Option<&str>,
    entitlements: serde_json::Value,
) {
    let device_id = Uuid::new_v4().to_string();
    secrets.set_secret(KEYRING_DEVICE_ID, &device_id).unwrap();
    let fp = compute_device_fingerprint(machine_guid, std::env::consts::ARCH);
    let is_perpetual = license_type == "perpetual";
    let payload = serde_json::json!({
        "ver": 1,
        "kid": "sspro-ed25519-test-01",
        "jti": "lse_01NMH00000000000000000000",
        "iss": EXPECTED_ISSUER,
        "aud": PRODUCT_ID,
        "iat": iat,
        "exp": exp,
        "offline_grace_until": exp,
        "license_id": "lic_01NMH00000000000000000000",
        "activation_id": "act_01NMH00000000000000000000",
        "device_id": device_id,
        "device_fingerprint": fp,
        "plan_code": if is_perpetual { "lifetime" } else { "pro_monthly" },
        "plan_name": if is_perpetual { "Lifetime" } else { "30 Days" },
        "license_type": license_type,
        "billing_interval": if is_perpetual { "lifetime" } else { "monthly" },
        "status": "active",
        "lifetime": is_perpetual,
        "expires_at": expires_at,
        "current_period_start": if is_perpetual { serde_json::Value::Null } else { serde_json::json!(iat) },
        "current_period_end": expires_at,
        "cancel_at_period_end": false,
        "device_limit": 2,
        "devices_used": 1,
        "entitlements": entitlements
    });
    let lease_token = sign_payload(signing_key, &payload);
    let state = LicenseState {
        plan: if is_perpetual {
            "Lifetime".to_string()
        } else {
            "30 Days".to_string()
        },
        status: "active".to_string(),
        device_id,
        lease_token,
        ..Default::default()
    };
    write_state_file_atomic(state_path, &state).unwrap();
}

#[test]
fn encodes_and_decodes_native_messaging_frames_and_rejects_invalid_lengths() {
    let payload = r#"{"request_id":"req_01","command":"get_license_status","product":"vectorizer_extension"}"#;
    let mut encoded = Vec::new();
    write_frame(&mut encoded, payload.as_bytes()).unwrap();
    assert_eq!(
        u32::from_le_bytes(encoded[..4].try_into().unwrap()) as usize,
        payload.len()
    );

    let mut cursor = Cursor::new(encoded);
    let decoded = read_frame(&mut cursor).unwrap();
    assert_eq!(decoded, payload);

    // 0-length frame rejected
    let mut zero_cursor = Cursor::new(0u32.to_le_bytes().to_vec());
    assert_eq!(
        read_frame(&mut zero_cursor),
        Err(FramingError::InvalidLength(0))
    );

    // Oversized inbound frame rejected before allocating
    let oversized_len = (MAX_INBOUND_MESSAGE_BYTES as u32) + 1;
    let mut over_cursor = Cursor::new(oversized_len.to_le_bytes().to_vec());
    assert_eq!(
        read_frame(&mut over_cursor),
        Err(FramingError::OversizedInbound(
            MAX_INBOUND_MESSAGE_BYTES + 1
        ))
    );

    // Empty stream rejected cleanly
    let mut empty_cursor = Cursor::new(Vec::<u8>::new());
    assert_eq!(
        read_frame(&mut empty_cursor),
        Err(FramingError::EmptyStream)
    );
}

#[test]
fn rejects_malformed_json_unknown_commands_and_correlates_request_id() {
    let state_path = temp_state_path("protocol");
    let secrets = InMemorySecretStore::default();
    let ctx = HostContext {
        state_path: &state_path,
        verifying_keys: &[],
        secrets: &secrets,
        machine_guid: "guid-test",
        now_utc: Utc.with_ymd_and_hms(2026, 11, 21, 12, 0, 0).unwrap(),
    };

    let malformed = handle_request_json("{ not valid json", &ctx);
    assert!(!malformed.authorized);
    assert_eq!(malformed.error_code.as_deref(), Some("MALFORMED_JSON"));

    let missing_id = handle_request_json(
        r#"{"command":"get_license_status","product":"vectorizer_extension"}"#,
        &ctx,
    );
    assert!(!missing_id.authorized);
    assert_eq!(missing_id.error_code.as_deref(), Some("INVALID_REQUEST_ID"));

    let unknown_cmd = handle_request_json(
        r#"{"request_id":"req_abc_123","command":"dump_secrets","product":"vectorizer_extension"}"#,
        &ctx,
    );
    assert!(!unknown_cmd.authorized);
    assert_eq!(unknown_cmd.request_id, "req_abc_123");
    assert_eq!(
        unknown_cmd.error_code.as_deref(),
        Some("UNSUPPORTED_COMMAND")
    );

    let wrong_product = handle_request_json(
        r#"{"request_id":"req_abc_124","command":"get_license_status","product":"desktop"}"#,
        &ctx,
    );
    assert!(!wrong_product.authorized);
    assert_eq!(wrong_product.request_id, "req_abc_124");
    assert_eq!(
        wrong_product.error_code.as_deref(),
        Some("UNSUPPORTED_PRODUCT")
    );

    let _ = fs::remove_dir_all(state_path.parent().unwrap());
}

#[test]
fn evaluates_missing_corrupted_unentitled_valid_expired_and_offline_grace_states() {
    let (signing_key, pub_b64) = make_keypair(55);
    let keys = vec![(Some("sspro-ed25519-test-01".to_string()), pub_b64)];
    let machine_guid = "guid-nmh-test";
    let day2 = Utc.with_ymd_and_hms(2026, 11, 22, 12, 0, 0).unwrap();

    // 1. Missing license state
    let missing_path = temp_state_path("missing");
    let secrets_missing = InMemorySecretStore::default();
    let ctx_missing = HostContext {
        state_path: &missing_path,
        verifying_keys: &keys,
        secrets: &secrets_missing,
        machine_guid,
        now_utc: day2,
    };
    let res_missing = handle_request_json(
        r#"{"request_id":"req_1","command":"get_license_status","product":"vectorizer_extension"}"#,
        &ctx_missing,
    );
    assert!(!res_missing.authorized);
    assert_eq!(res_missing.request_id, "req_1");
    assert_eq!(res_missing.error_code.as_deref(), Some("NOT_ACTIVATED"));

    // 2. Corrupted license state
    fs::write(&missing_path, "{ corrupted_state").unwrap();
    let res_corrupt = handle_request_json(
        r#"{"request_id":"req_2","command":"get_license_status","product":"vectorizer_extension"}"#,
        &ctx_missing,
    );
    assert!(!res_corrupt.authorized);
    assert_eq!(
        res_corrupt.error_code.as_deref(),
        Some("CORRUPTED_PERSISTED_STATE")
    );

    // 3. Legacy desktop-only license (missing vectorizer_extension entitlement) -> denied
    let unentitled_path = temp_state_path("unentitled");
    let secrets_unentitled = InMemorySecretStore::default();
    seed_signed_state(
        &unentitled_path,
        &secrets_unentitled,
        &signing_key,
        machine_guid,
        "perpetual",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        None,
        serde_json::json!({ "features": ["google_flow_workspace"] }),
    );
    let ctx_unentitled = HostContext {
        state_path: &unentitled_path,
        verifying_keys: &keys,
        secrets: &secrets_unentitled,
        machine_guid,
        now_utc: day2,
    };
    let res_unentitled = handle_request_json(
        r#"{"request_id":"req_3","command":"get_license_status","product":"vectorizer_extension"}"#,
        &ctx_unentitled,
    );
    assert!(!res_unentitled.authorized);
    assert_eq!(
        res_unentitled.error_code.as_deref(),
        Some("PRODUCT_NOT_ENTITLED")
    );

    // 4. Valid unified license with vectorizer_extension entitlement (within 7-day offline grace)
    let valid_path = temp_state_path("valid");
    let secrets_valid = InMemorySecretStore::default();
    seed_signed_state(
        &valid_path,
        &secrets_valid,
        &signing_key,
        machine_guid,
        "perpetual",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        None,
        serde_json::json!({
            "products": ["desktop", "vectorizer_extension"],
            "features": ["google_flow_workspace"]
        }),
    );
    let mut reader = Cursor::new(frame_bytes(
        r#"{"request_id":"req_valid_4","command":"get_license_status","product":"vectorizer_extension"}"#,
    ));
    let mut writer = Vec::new();
    let ctx_valid = HostContext {
        state_path: &valid_path,
        verifying_keys: &keys,
        secrets: &secrets_valid,
        machine_guid,
        now_utc: day2,
    };
    let res_valid = run_once(&mut reader, &mut writer, &ctx_valid).unwrap();
    assert!(res_valid.authorized);
    assert_eq!(res_valid.request_id, "req_valid_4");
    assert_eq!(res_valid.license_status, "active");
    assert_eq!(res_valid.plan_name.as_deref(), Some("Lifetime"));
    assert_eq!(
        res_valid.products,
        vec!["desktop".to_string(), "vectorizer_extension".to_string()]
    );
    assert_eq!(res_valid.error_code, None);

    // Verify serialized wire payload NEVER leaks secrets
    let wire_json = read_frame(&mut Cursor::new(writer)).unwrap();
    for forbidden in [
        "license_key",
        "activation_token",
        "lease_token",
        "device_fingerprint",
        "SSPRO-",
        "ssact_",
    ] {
        assert!(
            !wire_json.contains(forbidden),
            "wire response must never contain {forbidden}"
        );
    }

    // 5. Clock rollback (>5 minutes earlier than day2 anchor) -> denied
    record_clock_anchor(&secrets_valid, day2);
    let ctx_rollback = HostContext {
        now_utc: Utc.with_ymd_and_hms(2026, 11, 22, 11, 50, 0).unwrap(),
        ..ctx_valid
    };
    let res_rollback = handle_request_json(
        r#"{"request_id":"req_5","command":"get_license_status","product":"vectorizer_extension"}"#,
        &ctx_rollback,
    );
    assert!(!res_rollback.authorized);
    assert_eq!(
        res_rollback.error_code.as_deref(),
        Some("CLOCK_ROLLBACK_DETECTED")
    );

    // 6. Expired 7-day offline grace -> denied
    let ctx_grace_exp = HostContext {
        now_utc: Utc.with_ymd_and_hms(2026, 11, 27, 12, 0, 1).unwrap(),
        ..ctx_valid
    };
    let res_grace_exp = handle_request_json(
        r#"{"request_id":"req_6","command":"get_license_status","product":"vectorizer_extension"}"#,
        &ctx_grace_exp,
    );
    assert!(!res_grace_exp.authorized);
    assert_eq!(
        res_grace_exp.error_code.as_deref(),
        Some("OFFLINE_GRACE_EXPIRED")
    );

    // 7. Expired subscription -> denied (even within 7-day lease window)
    let sub_path = temp_state_path("sub-exp");
    let secrets_sub = InMemorySecretStore::default();
    seed_signed_state(
        &sub_path,
        &secrets_sub,
        &signing_key,
        machine_guid,
        "subscription",
        "2026-11-20T12:00:00Z",
        "2026-11-27T12:00:00Z",
        Some("2026-11-21T12:00:00Z"),
        serde_json::json!({ "products": ["desktop", "vectorizer_extension"] }),
    );
    let ctx_sub = HostContext {
        state_path: &sub_path,
        verifying_keys: &keys,
        secrets: &secrets_sub,
        machine_guid,
        now_utc: day2,
    };
    let res_sub = handle_request_json(
        r#"{"request_id":"req_7","command":"get_license_status","product":"vectorizer_extension"}"#,
        &ctx_sub,
    );
    assert!(!res_sub.authorized);
    assert_eq!(res_sub.error_code.as_deref(), Some("LICENSE_EXPIRED"));

    let _ = fs::remove_dir_all(missing_path.parent().unwrap());
    let _ = fs::remove_dir_all(unentitled_path.parent().unwrap());
    let _ = fs::remove_dir_all(valid_path.parent().unwrap());
    let _ = fs::remove_dir_all(sub_path.parent().unwrap());
}

#[test]
fn executes_standalone_nmh_binary_via_framed_stdin_stdout_without_desktop_running() {
    let exe = env!("CARGO_BIN_EXE_stockstudio-nmh");
    let state_path = temp_state_path("standalone-bin");

    // Helper to spawn stockstudio-nmh.exe with a single framed request
    let run_bin = |input_bytes: &[u8]| -> (std::process::ExitStatus, Vec<u8>) {
        let mut child = Command::new(exe)
            .env("STOCKSTUDIO_NMH_STATE_PATH", &state_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("stockstudio-nmh.exe must spawn");

        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(input_bytes)
            .unwrap();
        drop(child.stdin.take());

        let output = child.wait_with_output().unwrap();
        (output.status, output.stdout)
    };

    // 1. Missing license file (Desktop not running) -> clean framed NOT_ACTIVATED response
    let req1 = frame_bytes(
        r#"{"request_id":"standalone_01","command":"get_license_status","product":"vectorizer_extension"}"#,
    );
    let (status1, stdout1) = run_bin(&req1);
    assert!(status1.success());
    let json1 = read_frame(&mut Cursor::new(stdout1)).unwrap();
    let resp1: NativeResponse = serde_json::from_str(&json1).unwrap();
    assert_eq!(resp1.request_id, "standalone_01");
    assert!(!resp1.authorized);
    assert_eq!(resp1.error_code.as_deref(), Some("NOT_ACTIVATED"));

    // 2. Corrupted license-state.json -> clean framed CORRUPTED_PERSISTED_STATE response
    fs::write(&state_path, "not-json").unwrap();
    let req2 = frame_bytes(
        r#"{"request_id":"standalone_02","command":"get_license_status","product":"vectorizer_extension"}"#,
    );
    let (status2, stdout2) = run_bin(&req2);
    assert!(status2.success());
    let json2 = read_frame(&mut Cursor::new(stdout2)).unwrap();
    let resp2: NativeResponse = serde_json::from_str(&json2).unwrap();
    assert_eq!(resp2.request_id, "standalone_02");
    assert!(!resp2.authorized);
    assert_eq!(
        resp2.error_code.as_deref(),
        Some("CORRUPTED_PERSISTED_STATE")
    );

    // 3. Unknown command -> clean framed UNSUPPORTED_COMMAND response
    let req3 = frame_bytes(
        r#"{"request_id":"standalone_03","command":"unknown_op","product":"vectorizer_extension"}"#,
    );
    let (status3, stdout3) = run_bin(&req3);
    assert!(status3.success());
    let json3 = read_frame(&mut Cursor::new(stdout3)).unwrap();
    let resp3: NativeResponse = serde_json::from_str(&json3).unwrap();
    assert_eq!(resp3.request_id, "standalone_03");
    assert!(!resp3.authorized);
    assert_eq!(resp3.error_code.as_deref(), Some("UNSUPPORTED_COMMAND"));

    // 4. Oversized frame length -> exits non-zero and writes ZERO stray bytes to stdout
    let over_len = ((MAX_INBOUND_MESSAGE_BYTES as u32) + 10).to_le_bytes();
    let (status4, stdout4) = run_bin(&over_len);
    assert!(!status4.success());
    assert!(
        stdout4.is_empty(),
        "stdout must stay empty on framing error"
    );

    let _ = fs::remove_dir_all(state_path.parent().unwrap());
}

#[test]
fn generates_valid_host_manifest_and_rejects_wildcards_or_placeholders() {
    assert_eq!(NATIVE_HOST_NAME, "com.stockstudiopro.license");
    assert_eq!(
        NATIVE_HOST_REGISTRY_SUBKEY,
        r"Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license"
    );

    let synthetic_valid_id = "abcdefghijklmnopabcdefghijklmnop";
    assert!(is_valid_chrome_extension_id(synthetic_valid_id));

    for bad in [
        "",
        "*",
        "__STOCKSTUDIO_EXTENSION_ID_PLACEHOLDER__",
        "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
        "abcdefghijklmnopabcdefghijklmnoq", // 'q' is outside a-p
        "short",
    ] {
        assert!(!is_valid_chrome_extension_id(bad), "must reject {bad}");
        assert!(build_host_manifest_json(r"C:\App\stockstudio-nmh.exe", bad).is_err());
    }

    let json = build_host_manifest_json(
        r"C:\Users\Demo\AppData\Local\StockStudio Pro\stockstudio-nmh.exe",
        synthetic_valid_id,
    )
    .expect("valid manifest must build");
    let parsed: NativeHostManifest = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.name, "com.stockstudiopro.license");
    assert_eq!(parsed.host_type, "stdio");
    assert_eq!(
        parsed.path,
        r"C:\Users\Demo\AppData\Local\StockStudio Pro\stockstudio-nmh.exe"
    );
    assert_eq!(
        parsed.allowed_origins,
        vec![format!("chrome-extension://{synthetic_valid_id}/")]
    );
}
