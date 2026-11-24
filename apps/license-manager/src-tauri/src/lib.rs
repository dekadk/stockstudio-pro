pub mod api;
pub mod clipboard;
pub mod commands;
pub mod security;
pub mod vault;

use std::sync::Mutex;

use api::AdminApiClient;
use commands::IssuanceRuntimeState;
use security::{AppSecurityState, WindowsKeyringStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let api_client =
        AdminApiClient::new().expect("Failed to initialize HTTPS Admin API client");
    let security_state = AppSecurityState::new(Box::new(WindowsKeyringStore));
    let issuance_state = IssuanceRuntimeState::new();

    tauri::Builder::default()
        .manage(Mutex::new(security_state))
        .manage(Mutex::new(issuance_state))
        .manage(api_client)
        .invoke_handler(tauri::generate_handler![
            commands::get_session_status,
            commands::set_environment,
            commands::set_idle_timeout,
            commands::unlock_with_key,
            commands::unlock_from_keyring,
            commands::lock_session,
            commands::forget_stored_credential,
            commands::touch_activity,
            commands::fetch_admin_me,
            commands::fetch_dashboard_stats,
            commands::fetch_licenses,
            commands::fetch_license_details,
            commands::fetch_events,
            commands::issue_license,
            commands::copy_one_time_key_to_clipboard,
            commands::export_one_time_key_vault,
            commands::dismiss_one_time_key,
            commands::revoke_license,
            commands::force_deactivate_device,
            commands::update_license,
            commands::suspend_license,
            commands::reinstate_license,
            commands::renew_subscription,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StockStudio Pro License Manager");
}
