import { invoke } from "@tauri-apps/api/core";
import type {
  AdminEventsResponse,
  AdminLicenseDetailResponse,
  AdminLicensesResponse,
  AdminMeResponse,
  AdminStatsResponse,
  Environment,
  ForceDeactivateDeviceCommandInput,
  IssueLicenseCommandInput,
  IssueLicenseResult,
  LifecycleMutationResult,
  ListEventsQuery,
  ListLicensesQuery,
  ReasonMutationCommandInput,
  RenewSubscriptionCommandInput,
  RevokeLicenseCommandInput,
  SessionStatus,
  UpdateLicenseCommandInput,
} from "../types/api";

/**
 * Strictly typed IPC boundary between React and the Rust Tauri core.
 * React NEVER attaches Authorization headers, NEVER receives the Admin API key,
 * and NEVER makes direct external HTTP calls.
 */
export interface AdminBackendClient {
  getSessionStatus(): Promise<SessionStatus>;
  setEnvironment(environment: Environment): Promise<SessionStatus>;
  setIdleTimeout(timeoutSecs: number): Promise<SessionStatus>;
  unlockWithKey(
    apiKey: string,
    rememberInKeyring: boolean
  ): Promise<SessionStatus>;
  unlockFromKeyring(): Promise<SessionStatus>;
  lockSession(): Promise<SessionStatus>;
  forgetStoredCredential(): Promise<SessionStatus>;
  touchActivity(): Promise<SessionStatus>;
  fetchAdminMe(): Promise<AdminMeResponse>;
  fetchDashboardStats(): Promise<AdminStatsResponse>;
  fetchLicenses(params?: ListLicensesQuery): Promise<AdminLicensesResponse>;
  fetchLicenseDetails(licenseId: string): Promise<AdminLicenseDetailResponse>;
  fetchEvents(params?: ListEventsQuery): Promise<AdminEventsResponse>;
  issueLicense(input: IssueLicenseCommandInput): Promise<IssueLicenseResult>;
  copyOneTimeKeyToClipboard(licenseId: string): Promise<number>;
  exportOneTimeKeyVault(
    licenseId: string,
    targetPath: string,
    passphrase: string
  ): Promise<string>;
  dismissOneTimeKey(): Promise<void>;
  revokeLicense(
    input: RevokeLicenseCommandInput
  ): Promise<LifecycleMutationResult>;
  forceDeactivateDevice(
    input: ForceDeactivateDeviceCommandInput
  ): Promise<LifecycleMutationResult>;
  updateLicense(
    input: UpdateLicenseCommandInput
  ): Promise<LifecycleMutationResult>;
  suspendLicense(
    input: ReasonMutationCommandInput
  ): Promise<LifecycleMutationResult>;
  reinstateLicense(
    input: ReasonMutationCommandInput
  ): Promise<LifecycleMutationResult>;
  renewSubscription(
    input: RenewSubscriptionCommandInput
  ): Promise<LifecycleMutationResult>;
}

export const tauriAdminClient: AdminBackendClient = {
  getSessionStatus: () => invoke<SessionStatus>("get_session_status"),
  setEnvironment: (environment) =>
    invoke<SessionStatus>("set_environment", { environment }),
  setIdleTimeout: (timeoutSecs) =>
    invoke<SessionStatus>("set_idle_timeout", { timeoutSecs }),
  unlockWithKey: (apiKey, rememberInKeyring) =>
    invoke<SessionStatus>("unlock_with_key", { apiKey, rememberInKeyring }),
  unlockFromKeyring: () => invoke<SessionStatus>("unlock_from_keyring"),
  lockSession: () => invoke<SessionStatus>("lock_session"),
  forgetStoredCredential: () =>
    invoke<SessionStatus>("forget_stored_credential"),
  touchActivity: () => invoke<SessionStatus>("touch_activity"),
  fetchAdminMe: () => invoke<AdminMeResponse>("fetch_admin_me"),
  fetchDashboardStats: () => invoke<AdminStatsResponse>("fetch_dashboard_stats"),
  fetchLicenses: (params) =>
    invoke<AdminLicensesResponse>("fetch_licenses", { params: params ?? {} }),
  fetchLicenseDetails: (licenseId) =>
    invoke<AdminLicenseDetailResponse>("fetch_license_details", { licenseId }),
  fetchEvents: (params) =>
    invoke<AdminEventsResponse>("fetch_events", { params: params ?? {} }),
  issueLicense: (input) =>
    invoke<IssueLicenseResult>("issue_license", { input }),
  copyOneTimeKeyToClipboard: (licenseId) =>
    invoke<number>("copy_one_time_key_to_clipboard", { licenseId }),
  exportOneTimeKeyVault: (licenseId, targetPath, passphrase) =>
    invoke<string>("export_one_time_key_vault", {
      licenseId,
      targetPath,
      passphrase,
    }),
  dismissOneTimeKey: () => invoke<void>("dismiss_one_time_key"),
  revokeLicense: (input) =>
    invoke<LifecycleMutationResult>("revoke_license", { input }),
  forceDeactivateDevice: (input) =>
    invoke<LifecycleMutationResult>("force_deactivate_device", { input }),
  updateLicense: (input) =>
    invoke<LifecycleMutationResult>("update_license", { input }),
  suspendLicense: (input) =>
    invoke<LifecycleMutationResult>("suspend_license", { input }),
  reinstateLicense: (input) =>
    invoke<LifecycleMutationResult>("reinstate_license", { input }),
  renewSubscription: (input) =>
    invoke<LifecycleMutationResult>("renew_subscription", { input }),
};

export function normalizeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred while communicating with the Rust backend.";
}
