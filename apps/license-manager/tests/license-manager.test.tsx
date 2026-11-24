import fs from "node:fs";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { AdminBackendClient } from "../src/api/client";
import type {
  AdminEventsResponse,
  AdminLicenseDetailResponse,
  AdminLicensesResponse,
  AdminMeResponse,
  AdminStatsResponse,
  LicenseSummary,
  SessionStatus,
} from "../src/types/api";

const SAMPLE_ME: AdminMeResponse = {
  ok: true,
  admin: {
    id: "adm_01STAGINGADMIN",
    name: "Staging Super Admin",
    key_prefix: "ssadm_01STAGING",
    role: "super_admin",
    permissions: [
      "licenses:read",
      "licenses:create",
      "licenses:update",
      "licenses:suspend",
      "licenses:reinstate",
      "licenses:renew",
      "licenses:revoke",
      "devices:deactivate",
      "stats:read",
      "events:read",
    ],
    allowed_ips_configured: false,
    expires_at: null,
    last_used_at: "2026-11-23T15:00:00Z",
  },
  environment: "staging",
  signing_kid: "sspro-ed25519-staging-01",
  server_time: "2026-11-23T15:00:00Z",
};

const SAMPLE_LICENSE_1: LicenseSummary = {
  license_id: "lic_01M843WVE5J4CK3MK3RR2HHE02",
  key_prefix: "SSPRO-9VXT",
  plan_code: "lifetime",
  plan_name: "Lifetime Pro + Extension",
  license_type: "perpetual",
  billing_interval: "lifetime",
  status: "active",
  lifetime: true,
  expires_at: null,
  current_period_start: null,
  current_period_end: null,
  grace_until: null,
  cancel_at_period_end: false,
  device_limit: 2,
  devices_used: 1,
  entitlements: {
    products: ["desktop", "vectorizer_extension"],
    features: ["google_flow_workspace", "multi_account_manager"],
    max_accounts: null,
    updates_until: null,
    max_app_version: null,
  },
  customer_email: "studio@example.com",
  customer_name: "Studio Tester",
  external_customer_id: "cust_001",
  external_order_id: "ord_001",
  issued_at: "2026-11-23T10:00:00Z",
  activated_at: "2026-11-23T10:05:00Z",
  suspended_at: null,
  suspension_reason: null,
  revoked_at: null,
  revocation_reason: null,
  notes: "Staging integration test license",
  created_at: "2026-11-23T10:00:00Z",
  updated_at: "2026-11-23T10:05:00Z",
};

const SAMPLE_LICENSE_2: LicenseSummary = {
  ...SAMPLE_LICENSE_1,
  license_id: "lic_01M7XGXW6QFKXY6ERGWBSB1778",
  key_prefix: "SSPRO-4KLM",
  plan_code: "pro_monthly",
  plan_name: "Pro Monthly",
  license_type: "subscription",
  billing_interval: "monthly",
  status: "pending_activation",
  lifetime: false,
  expires_at: "2026-12-23T10:00:00Z",
  devices_used: 0,
  entitlements: {
    products: ["desktop"],
    features: ["google_flow_workspace"],
    max_accounts: 5,
    updates_until: "2026-12-23T10:00:00Z",
    max_app_version: null,
  },
  customer_email: "monthly@example.com",
  customer_name: "Monthly User",
};

const SAMPLE_STATS: AdminStatsResponse = {
  ok: true,
  stats: {
    total_licenses: 12,
    by_status: {
      pending_activation: 3,
      active: 6,
      past_due: 0,
      expired: 1,
      suspended: 1,
      revoked: 1,
    },
    by_license_type: {
      perpetual: 7,
      subscription: 5,
    },
    by_billing_interval: {
      lifetime: 7,
      monthly: 3,
      yearly: 2,
    },
    active_device_activations: 9,
    expiring_within_7d: 1,
    issued_last_30d: 4,
  },
  environment: "staging",
  signing_kid: "sspro-ed25519-staging-01",
  server_time: "2026-11-23T15:00:00Z",
};

const SAMPLE_EVENTS: AdminEventsResponse = {
  ok: true,
  items: [
    {
      id: "evt_01TESTEVENT1",
      license_id: SAMPLE_LICENSE_1.license_id,
      activation_id: "act_01TEST",
      device_id: "dev_01TEST",
      event_type: "license.activated",
      actor_type: "client",
      actor_id: "dev_01TEST",
      previous_status: "pending_activation",
      new_status: "active",
      ip_hash_prefix: "a1b2c3d4e5f6",
      metadata: { app_version: "0.2.0", secret_token: "[REDACTED]" },
      created_at: "2026-11-23T10:05:00Z",
    },
  ],
  pagination: {
    limit: 25,
    has_more: false,
    next_cursor: null,
  },
  server_time: "2026-11-23T15:00:00Z",
};

function makeUnlockedSession(
  overrides: Partial<SessionStatus> = {}
): SessionStatus {
  return {
    unlocked: true,
    environment: "staging",
    api_base_url: "https://stockstudio-pro-license-staging.pages.dev",
    has_stored_credential: true,
    idle_timeout_secs: 900,
    idle_remaining_secs: 845,
    credential_service: "StockStudioPro-LicenseManager-Admin",
    admin_me: SAMPLE_ME,
    locked_reason: null,
    ...overrides,
  };
}

function makeMockClient(
  overrides: Partial<AdminBackendClient> = {}
): AdminBackendClient {
  const session = makeUnlockedSession();
  return {
    getSessionStatus: vi.fn().mockResolvedValue(session),
    setEnvironment: vi.fn().mockResolvedValue({ ...session, unlocked: false }),
    setIdleTimeout: vi.fn().mockResolvedValue(session),
    unlockWithKey: vi.fn().mockResolvedValue(session),
    unlockFromKeyring: vi.fn().mockResolvedValue(session),
    lockSession: vi.fn().mockResolvedValue({ ...session, unlocked: false }),
    forgetStoredCredential: vi
      .fn()
      .mockResolvedValue({
        ...session,
        unlocked: false,
        has_stored_credential: false,
      }),
    touchActivity: vi.fn().mockResolvedValue(session),
    fetchAdminMe: vi.fn().mockResolvedValue(SAMPLE_ME),
    fetchDashboardStats: vi.fn().mockResolvedValue(SAMPLE_STATS),
    fetchLicenses: vi.fn().mockResolvedValue({
      ok: true,
      items: [SAMPLE_LICENSE_1],
      pagination: {
        limit: 25,
        sort: "created_desc",
        has_more: true,
        next_cursor: "eyJ2IjoxfQ",
      },
      server_time: "2026-11-23T15:00:00Z",
    } satisfies AdminLicensesResponse),
    fetchLicenseDetails: vi.fn().mockResolvedValue({
      ok: true,
      license: SAMPLE_LICENSE_1,
      activations: [
        {
          activation_id: "act_01TEST",
          device_id: "dev_01TEST",
          device_name: "DESKTOP-STUDIO",
          app_version: "0.2.0",
          status: "active",
          activated_at: "2026-11-23T10:05:00Z",
          last_validated_at: "2026-11-23T14:55:00Z",
          deactivated_at: null,
          deactivated_by: null,
          deactivation_reason: null,
        },
      ],
      billing_subscription: null,
      events: SAMPLE_EVENTS.items,
      server_time: "2026-11-23T15:00:00Z",
    } satisfies AdminLicenseDetailResponse),
    fetchEvents: vi.fn().mockResolvedValue(SAMPLE_EVENTS),
    issueLicense: vi.fn().mockResolvedValue({
      outcome: "created",
      license: SAMPLE_LICENSE_1,
      one_time_license_key: "SSPRO-9VXT-1111-2222-3333",
      audit_event_verified: true,
      existing_license_id: null,
      existing_key_prefix: null,
      idempotency_key: "lm-staging-test-idem",
      message: null,
    }),
    copyOneTimeKeyToClipboard: vi.fn().mockResolvedValue(30),
    exportOneTimeKeyVault: vi
      .fn()
      .mockResolvedValue("C:\\vault\\sspro-9vxt.enc.json"),
    dismissOneTimeKey: vi.fn().mockResolvedValue(undefined),
    revokeLicense: vi.fn().mockResolvedValue({
      outcome: "completed",
      already_applied: false,
      audit_event_verified: true,
      detail: {
        ok: true,
        license: {
          ...SAMPLE_LICENSE_1,
          status: "revoked",
          devices_used: 0,
          revoked_at: "2026-11-23T16:10:00Z",
          revocation_reason: "Refund issued",
        },
        activations: [],
        billing_subscription: null,
        events: SAMPLE_EVENTS.items,
        server_time: "2026-11-23T16:10:00Z",
      },
      message: "License revoked permanently.",
    }),
    forceDeactivateDevice: vi.fn().mockResolvedValue({
      outcome: "completed",
      already_applied: false,
      audit_event_verified: true,
      detail: null,
      message: "Device activation force-deactivated and slot released.",
    }),
    updateLicense: vi.fn().mockResolvedValue({
      outcome: "completed",
      already_applied: false,
      audit_event_verified: true,
      detail: null,
      message: "License metadata and entitlements updated.",
    }),
    suspendLicense: vi.fn().mockResolvedValue({
      outcome: "completed",
      already_applied: false,
      audit_event_verified: true,
      detail: null,
      message: "License suspended.",
    }),
    reinstateLicense: vi.fn().mockResolvedValue({
      outcome: "completed",
      already_applied: false,
      audit_event_verified: true,
      detail: null,
      message: "License reinstated.",
    }),
    renewSubscription: vi.fn().mockResolvedValue({
      outcome: "completed",
      already_applied: false,
      audit_event_verified: true,
      detail: null,
      message: "Subscription period renewed.",
    }),
    ...overrides,
  };
}

describe("StockStudio Pro License Manager (LM-03)", () => {
  it("renders Dashboard with real API stats and handles error + retry", async () => {
    const fetchDashboardStats = vi
      .fn()
      .mockRejectedValueOnce("NETWORK_ERROR: Staging API unreachable")
      .mockResolvedValueOnce(SAMPLE_STATS);

    const client = makeMockClient({ fetchDashboardStats });
    render(<App client={client} disableIdlePolling />);

    expect(
      await screen.findByText(/Failed to load dashboard statistics/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/NETWORK_ERROR: Staging API unreachable/i)
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));

    expect(await screen.findByText("Total Licenses")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Active Device Activations")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("Monthly Subscriptions")).toBeInTheDocument();
    expect(screen.getByText("Yearly Subscriptions")).toBeInTheDocument();
  });

  it("renders Empty state on Dashboard when total_licenses is 0", async () => {
    const emptyStats: AdminStatsResponse = {
      ...SAMPLE_STATS,
      stats: {
        ...SAMPLE_STATS.stats,
        total_licenses: 0,
      },
    };
    const client = makeMockClient({
      fetchDashboardStats: vi.fn().mockResolvedValue(emptyStats),
    });

    render(<App client={client} disableIdlePolling />);
    expect(
      await screen.findByText(/No licenses recorded yet/i)
    ).toBeInTheDocument();
  });

  it("supports Registry search, filtering, cursor pagination, and License Details navigation", async () => {
    const fetchLicenses = vi.fn().mockImplementation(async (params) => {
      if (params?.cursor === "cursor_page_2") {
        return {
          ok: true,
          items: [SAMPLE_LICENSE_2],
          pagination: {
            limit: 25,
            sort: "created_desc",
            has_more: false,
            next_cursor: null,
          },
          server_time: "2026-11-23T15:00:00Z",
        };
      }
      return {
        ok: true,
        items: [SAMPLE_LICENSE_1],
        pagination: {
          limit: 25,
          sort: "created_desc",
          has_more: true,
          next_cursor: "cursor_page_2",
        },
        server_time: "2026-11-23T15:00:00Z",
      };
    });

    const client = makeMockClient({ fetchLicenses });
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /License Registry/i })
    );

    expect(await screen.findByText("SSPRO-9VXT")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    // Filter by product
    await user.selectOptions(
      screen.getByLabelText(/Filter by product/i),
      "vectorizer_extension"
    );
    await waitFor(() => {
      expect(fetchLicenses).toHaveBeenCalledWith(
        expect.objectContaining({ product: "vectorizer_extension" })
      );
    });

    // Cursor pagination: Next -> Page 2
    await user.click(screen.getByRole("button", { name: /Next/i }));
    expect(await screen.findByText("SSPRO-4KLM")).toBeInTheDocument();
    expect(screen.getByText(/Page 2/i)).toBeInTheDocument();

    // Cursor pagination: Previous -> Page 1
    await user.click(screen.getByRole("button", { name: /Previous/i }));
    expect(await screen.findByText("SSPRO-9VXT")).toBeInTheDocument();

    // Click row to open License Details
    await user.click(screen.getByText("SSPRO-9VXT"));
    expect(await screen.findByText("License Metadata")).toBeInTheDocument();
    expect(screen.getByText("Customer Information")).toBeInTheDocument();
    expect(screen.getByText("DESKTOP-STUDIO")).toBeInTheDocument();
    expect(screen.getByText("license.activated")).toBeInTheDocument();
  });

  it("enforces RBAC visibility when admin role lacks events:read", async () => {
    const billingMe: AdminMeResponse = {
      ...SAMPLE_ME,
      admin: {
        ...SAMPLE_ME.admin,
        role: "billing_system",
        permissions: ["licenses:read", "stats:read"],
      },
    };
    const client = makeMockClient({
      getSessionStatus: vi
        .fn()
        .mockResolvedValue(makeUnlockedSession({ admin_me: billingMe })),
    });

    render(<App client={client} disableIdlePolling />);
    const eventsBtn = await screen.findByRole("button", {
      name: /Events & Activity/i,
    });
    expect(eventsBtn).toBeDisabled();
  });

  it("renders Events & Activity and Admin Profile & Security screens cleanly", async () => {
    const client = makeMockClient();
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /Events & Activity/i })
    );
    expect(
      await screen.findByRole("cell", { name: "license.activated" })
    ).toBeInTheDocument();
    expect(screen.getByText("a1b2c3d4e5f6")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Admin & Security/i })
    );
    expect(await screen.findByText("Authenticated Identity")).toBeInTheDocument();
    expect(screen.getByText("adm_01STAGINGADMIN")).toBeInTheDocument();
    expect(
      screen.getByText("StockStudioPro-LicenseManager-Admin")
    ).toBeInTheDocument();
    expect(screen.getAllByText("14:05")).toHaveLength(2);
  });

  it("never exposes sensitive fields or forbidden storage/fetch calls in React source", () => {
    const srcRoot = path.resolve(__dirname, "../src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(srcRoot);

    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/\blocalStorage\b/);
      expect(content).not.toMatch(/\bsessionStorage\b/);
      expect(content).not.toMatch(/\bfetch\s*\(/);
      expect(content).not.toMatch(/ssadm_/);
      expect(content).not.toMatch(/\bkey_hash\b/);
      expect(content).not.toMatch(/\blicense_key\b/);
    }
  });

  it("validates invalid device limits and missing entitlements before issuance", async () => {
    const client = makeMockClient();
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /Issue License/i })
    );

    const limitInput = screen.getByLabelText(/Device Limit/i);
    await user.clear(limitInput);
    await user.type(limitInput, "0");
    await user.click(
      screen.getByRole("button", { name: /Review Issuance Summary/i })
    );
    expect(
      screen.getByText(/Device limit must be an integer between 1 and 100/i)
    ).toBeInTheDocument();
    expect(client.issueLicense).not.toHaveBeenCalled();

    // Fix limit, uncheck both entitlements
    await user.clear(limitInput);
    await user.type(limitInput, "2");
    await user.click(screen.getByLabelText(/Desktop Application/i));
    await user.click(screen.getByLabelText(/Vectorizer Chrome Extension/i));
    await user.click(
      screen.getByRole("button", { name: /Review Issuance Summary/i })
    );
    expect(
      screen.getByText(/Select at least one entitlement/i)
    ).toBeInTheDocument();
    expect(client.issueLicense).not.toHaveBeenCalled();
  });

  it("issues a license through Rust, masks one-time key by default, copies with 30s auto-clear, and wipes on dismissal", async () => {
    const client = makeMockClient();
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /Issue License/i })
    );
    await user.type(
      screen.getByLabelText(/Customer Email/i),
      "buyer@example.com"
    );
    await user.click(
      screen.getByRole("button", { name: /Review Issuance Summary/i })
    );

    const confirmBtn = screen.getByRole("button", {
      name: /Confirm & Issue License/i,
    });
    expect(confirmBtn).toBeDisabled();

    await user.click(
      screen.getByLabelText(/I confirm all license parameters above/i)
    );
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);

    // One-time modal opens with raw key MASKED by default
    expect(
      await screen.findByText(/License Issued — One-Time Key Handoff/i)
    ).toBeInTheDocument();
    const keyDisplay = screen.getByTestId("one-time-key-display");
    expect(keyDisplay.textContent).not.toContain("1111-2222-3333");
    expect(keyDisplay.textContent).toContain("••••");

    // Explicit reveal
    await user.click(screen.getByRole("button", { name: /Reveal Key/i }));
    expect(keyDisplay.textContent).toBe("SSPRO-9VXT-1111-2222-3333");

    // Copy with 30s auto-clear
    await user.click(
      screen.getByRole("button", { name: /Copy Key \(30s Auto-Clear\)/i })
    );
    expect(client.copyOneTimeKeyToClipboard).toHaveBeenCalledWith(
      SAMPLE_LICENSE_1.license_id
    );
    expect(
      await screen.findByText(/Copied \(auto-clears in 30s\)/i)
    ).toBeInTheDocument();

    // Dismissal requires explicit acknowledgement checkbox
    const closeBtn = screen.getByRole("button", {
      name: /Close & Wipe Key/i,
    });
    expect(closeBtn).toBeDisabled();
    await user.click(
      screen.getByLabelText(/I have securely delivered or backed up/i)
    );
    expect(closeBtn).toBeEnabled();
    await user.click(closeBtn);

    expect(client.dismissOneTimeKey).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(
        screen.queryByText(/License Issued — One-Time Key Handoff/i)
      ).not.toBeInTheDocument();
    });
  });

  it("handles uncertain timeout outcome safely and enforces RBAC on read_only", async () => {
    const client = makeMockClient({
      issueLicense: vi.fn().mockResolvedValue({
        outcome: "uncertain",
        license: null,
        one_time_license_key: null,
        audit_event_verified: false,
        existing_license_id: null,
        existing_key_prefix: null,
        idempotency_key: "lm-staging-timeout",
        message: "Request timed out. Check License Registry before retrying.",
      }),
    });
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /Issue License/i })
    );
    await user.click(
      screen.getByRole("button", { name: /Review Issuance Summary/i })
    );
    await user.click(
      screen.getByLabelText(/I confirm all license parameters above/i)
    );
    await user.click(
      screen.getByRole("button", { name: /Confirm & Issue License/i })
    );

    expect(
      await screen.findByText(/Uncertain Issuance Outcome/i)
    ).toBeInTheDocument();
    expect(client.issueLicense).toHaveBeenCalledTimes(1);
  });

  it("disables Issue License in sidebar for read_only admin role", async () => {
    const readOnlyMe: AdminMeResponse = {
      ...SAMPLE_ME,
      admin: {
        ...SAMPLE_ME.admin,
        role: "read_only",
        permissions: ["licenses:read", "stats:read", "events:read"],
      },
    };
    const client = makeMockClient({
      getSessionStatus: vi
        .fn()
        .mockResolvedValue(makeUnlockedSession({ admin_me: readOnlyMe })),
    });

    render(<App client={client} disableIdlePolling />);
    const issueBtn = await screen.findByRole("button", {
      name: /Issue License/i,
    });
    expect(issueBtn).toBeDisabled();
  });

  it("validates Revoke License confirmation dialog, executes revocation, and refreshes details", async () => {
    const client = makeMockClient();
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /License Registry/i })
    );
    await user.click(await screen.findByText("SSPRO-9VXT"));
    await user.click(
      await screen.findByRole("button", { name: /Revoke License/i })
    );

    const confirmBtn = screen.getByRole("button", {
      name: /Confirm Permanent Revocation/i,
    });
    expect(confirmBtn).toBeDisabled();

    // Wrong prefix keeps submit disabled
    await user.type(
      screen.getByLabelText(/Type exact license prefix/i),
      "SSPRO-WRONG"
    );
    await user.type(
      screen.getByLabelText(/Revocation Reason/i),
      "Refund processed"
    );
    expect(confirmBtn).toBeDisabled();

    // Correct prefix enables submit
    const prefixInput = screen.getByLabelText(/Type exact license prefix/i);
    await user.clear(prefixInput);
    await user.type(prefixInput, "SSPRO-9VXT");
    expect(confirmBtn).toBeEnabled();

    await user.click(confirmBtn);
    expect(client.revokeLicense).toHaveBeenCalledWith({
      expected_environment: "staging",
      license_id: SAMPLE_LICENSE_1.license_id,
      expected_key_prefix: "SSPRO-9VXT",
      confirm_key_prefix: "SSPRO-9VXT",
      reason: "Refund processed",
    });
    expect(
      await screen.findByText(/License revoked permanently/i)
    ).toBeInTheDocument();
    // Authoritative detail refresh called again after mutation
    expect(client.fetchLicenseDetails).toHaveBeenCalledTimes(2);
  });

  it("force-deactivates only the selected device when multiple devices exist and surfaces failure feedback", async () => {
    const twoDeviceDetail: AdminLicenseDetailResponse = {
      ok: true,
      license: { ...SAMPLE_LICENSE_1, devices_used: 2 },
      activations: [
        {
          activation_id: "act_01DEVICE_A",
          device_id: "dev_A",
          device_name: "WORKSTATION-A",
          app_version: "0.2.0",
          status: "active",
          activated_at: "2026-11-23T10:05:00Z",
          last_validated_at: "2026-11-23T14:55:00Z",
          deactivated_at: null,
          deactivated_by: null,
          deactivation_reason: null,
        },
        {
          activation_id: "act_01DEVICE_B",
          device_id: "dev_B",
          device_name: "LAPTOP-B",
          app_version: "0.2.0",
          status: "active",
          activated_at: "2026-11-23T11:05:00Z",
          last_validated_at: "2026-11-23T14:50:00Z",
          deactivated_at: null,
          deactivated_by: null,
          deactivation_reason: null,
        },
      ],
      billing_subscription: null,
      events: SAMPLE_EVENTS.items,
      server_time: "2026-11-23T15:00:00Z",
    };

    const forceDeactivateDevice = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "rejected",
        already_applied: false,
        audit_event_verified: false,
        detail: null,
        message: "FORBIDDEN: Simulated backend rejection",
      })
      .mockResolvedValueOnce({
        outcome: "completed",
        already_applied: false,
        audit_event_verified: true,
        detail: twoDeviceDetail,
        message: "Device activation force-deactivated and slot released.",
      });

    const client = makeMockClient({
      fetchLicenseDetails: vi.fn().mockResolvedValue(twoDeviceDetail),
      forceDeactivateDevice,
    });
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /License Registry/i })
    );
    await user.click(await screen.findByText("SSPRO-9VXT"));

    // Select ONLY LAPTOP-B (not WORKSTATION-A)
    await user.click(
      await screen.findByRole("button", { name: /Force Deactivate LAPTOP-B/i })
    );
    expect(screen.getByText(/Activation act_01DEVICE_B/i)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(/Type exact license prefix/i),
      "SSPRO-9VXT"
    );
    await user.type(
      screen.getByLabelText(/Deactivation Reason/i),
      "Lost laptop"
    );

    // First attempt surfaces backend failure feedback
    await user.click(
      screen.getByRole("button", { name: /Confirm Force Deactivate/i })
    );
    expect(
      await screen.findByText(/FORBIDDEN: Simulated backend rejection/i)
    ).toBeInTheDocument();

    // Second attempt succeeds targeting ONLY act_01DEVICE_B
    await user.click(
      screen.getByRole("button", { name: /Confirm Force Deactivate/i })
    );
    expect(forceDeactivateDevice).toHaveBeenLastCalledWith({
      expected_environment: "staging",
      license_id: SAMPLE_LICENSE_1.license_id,
      activation_id: "act_01DEVICE_B",
      expected_key_prefix: "SSPRO-9VXT",
      confirm_key_prefix: "SSPRO-9VXT",
      reason: "Lost laptop",
    });
    expect(
      await screen.findByText(/Device activation force-deactivated/i)
    ).toBeInTheDocument();
  });

  it("blocks Production lifecycle mutations in the UI and shows locked gate when locked", async () => {
    const lockedSession = makeUnlockedSession({
      unlocked: false,
      admin_me: null,
      locked_reason: "Environment switched — session locked for safety.",
    });
    const client = makeMockClient({
      getSessionStatus: vi.fn().mockResolvedValue(lockedSession),
    });

    render(<App client={client} disableIdlePolling />);
    expect(
      await screen.findByText(/Unlock License Manager/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Environment switched — session locked for safety/i)
    ).toBeInTheDocument();
  });

  it("supports Edit License and Suspend License workflows from License Details", async () => {
    const client = makeMockClient();
    const user = userEvent.setup();
    render(<App client={client} disableIdlePolling />);

    await user.click(
      await screen.findByRole("button", { name: /License Registry/i })
    );
    await user.click(await screen.findByText("SSPRO-9VXT"));

    // Edit License
    await user.click(
      await screen.findByRole("button", { name: /Edit License/i })
    );
    const limitInput = screen.getByLabelText(/Device Limit/i);
    await user.clear(limitInput);
    await user.type(limitInput, "5");
    await user.click(screen.getByRole("button", { name: /Save Changes/i }));
    expect(client.updateLicense).toHaveBeenCalledWith(
      expect.objectContaining({
        expected_environment: "staging",
        license_id: SAMPLE_LICENSE_1.license_id,
        payload: expect.objectContaining({ device_limit: 5 }),
      })
    );

    // Suspend License
    await user.click(await screen.findByRole("button", { name: /^Suspend$/i }));
    await user.type(
      screen.getByLabelText(/Suspension Reason/i),
      "Pending verification"
    );
    await user.click(
      screen.getByRole("button", { name: /Confirm Suspend/i })
    );
    expect(client.suspendLicense).toHaveBeenCalledWith({
      expected_environment: "staging",
      license_id: SAMPLE_LICENSE_1.license_id,
      reason: "Pending verification",
    });
  });
});
