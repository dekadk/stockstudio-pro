import React, { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  normalizeError,
  tauriAdminClient,
  type AdminBackendClient,
} from "./api/client";
import { Sidebar, type NavRoute } from "./components/Sidebar";
import { ErrorPanel, LoadingPanel } from "./components/StateViews";
import { UnlockGate } from "./components/UnlockGate";
import { AdminProfilePage } from "./pages/AdminProfilePage";
import { DashboardPage } from "./pages/DashboardPage";
import { EventsPage } from "./pages/EventsPage";
import { IssueLicensePage } from "./pages/IssueLicensePage";
import { LicenseDetailsPage } from "./pages/LicenseDetailsPage";
import { LicenseRegistryPage } from "./pages/LicenseRegistryPage";
import { StudioToolsPage } from "./pages/StudioToolsPage";
import type { Environment, LicenseSummary, SessionStatus } from "./types/api";
import { hasPermission } from "./utils/format";

export interface AppProps {
  client?: AdminBackendClient;
  /** Disable background 15s idle poll during deterministic unit tests */
  disableIdlePolling?: boolean;
}

export const App: React.FC<AppProps> = ({
  client = tauriAdminClient,
  disableIdlePolling = false,
}) => {
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [route, setRoute] = useState<NavRoute>("dashboard");
  const [selectedLicense, setSelectedLicense] = useState<LicenseSummary | null>(
    null
  );

  const refreshSession = useCallback(async () => {
    try {
      const status = await client.getSessionStatus();
      setSession(status);
      setBootError(null);
    } catch (err) {
      setBootError(normalizeError(err));
    }
  }, [client]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // Periodically poll Rust session status to reflect idle auto-lock countdown.
  useEffect(() => {
    if (disableIdlePolling || !session?.unlocked) return;
    const timer = window.setInterval(() => {
      void refreshSession();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [disableIdlePolling, session?.unlocked, refreshSession]);

  const handleSelectEnvironment = async (env: Environment) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const next = await client.setEnvironment(env);
      setSession(next);
      setSelectedLicense(null);
      setRoute("dashboard");
    } catch (err) {
      setAuthError(normalizeError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleUnlockWithKey = async (
    apiKey: string,
    rememberInKeyring: boolean
  ) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const next = await client.unlockWithKey(apiKey, rememberInKeyring);
      setSession(next);
      setRoute("dashboard");
    } catch (err) {
      setAuthError(normalizeError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleUnlockFromKeyring = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const next = await client.unlockFromKeyring();
      setSession(next);
      setRoute("dashboard");
    } catch (err) {
      setAuthError(normalizeError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLockNow = async () => {
    try {
      const next = await client.lockSession();
      setSession(next);
      setSelectedLicense(null);
    } catch (err) {
      setAuthError(normalizeError(err));
    }
  };

  if (bootError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-950 p-6">
        <div className="w-full max-w-lg">
          <ErrorPanel
            title="Rust Backend Unavailable"
            message={bootError}
            onRetry={refreshSession}
          />
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-950 p-6">
        <LoadingPanel label="Initializing License Manager security core..." />
      </div>
    );
  }

  if (!session.unlocked) {
    return (
      <UnlockGate
        session={session}
        busy={authBusy}
        error={authError}
        onSelectEnvironment={handleSelectEnvironment}
        onUnlockWithKey={handleUnlockWithKey}
        onUnlockFromKeyring={handleUnlockFromKeyring}
      />
    );
  }

  const admin = session.admin_me?.admin ?? null;
  const canReadEvents = hasPermission(admin, "events:read");
  const canCreateLicense = hasPermission(admin, "licenses:create");
  const canRevoke = hasPermission(admin, "licenses:revoke");
  const canDeactivateDevice = hasPermission(admin, "devices:deactivate");
  const canUpdateLicense = hasPermission(admin, "licenses:update");
  const canSuspend = hasPermission(admin, "licenses:suspend");
  const canReinstate = hasPermission(admin, "licenses:reinstate");
  const canRenew = hasPermission(admin, "licenses:renew");
  const isProd = session.environment === "production";

  return (
    <div className="flex h-screen overflow-hidden bg-surface-950 text-slate-200">
      <Sidebar
        activeRoute={route}
        onNavigate={(nextRoute) => {
          setRoute(nextRoute);
          if (nextRoute !== "details") {
            setSelectedLicense(null);
          }
        }}
        session={session}
        onLockNow={handleLockNow}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Persistent Environment Banner */}
        <header
          className={`flex items-center justify-between border-b px-6 py-2.5 text-xs ${
            isProd
              ? "border-rose-500/40 bg-rose-950/40 text-rose-200"
              : "border-surface-700 bg-surface-900/90 text-slate-300"
          }`}
        >
          <div className="flex items-center gap-2">
            {isProd && <ShieldAlert className="h-4 w-4 text-rose-400" />}
            <span className="font-semibold uppercase tracking-wider">
              {isProd
                ? "PRODUCTION — LIVE CUSTOMER DATA"
                : "STAGING ENVIRONMENT — INTEGRATION SANDBOX"}
            </span>
          </div>
          <span className="font-mono text-[11px] text-slate-400">
            {session.api_base_url}
          </span>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-6xl">
            {route === "dashboard" && (
              <DashboardPage
                client={client}
                onOpenRegistry={() => setRoute("registry")}
              />
            )}

            {route === "registry" && (
              <LicenseRegistryPage
                client={client}
                onSelectLicense={(lic) => {
                  setSelectedLicense(lic);
                  setRoute("details");
                }}
              />
            )}

            {route === "issue" && (
              <IssueLicensePage
                client={client}
                environment={session.environment}
                apiBaseUrl={session.api_base_url}
                canCreateLicense={canCreateLicense}
                onNavigateRegistry={() => setRoute("registry")}
                onNavigateEvents={() => setRoute("events")}
                onOpenLicenseDetails={(lic) => {
                  setSelectedLicense(lic);
                  setRoute("details");
                }}
              />
            )}

            {route === "details" && selectedLicense && (
              <LicenseDetailsPage
                client={client}
                environment={session.environment}
                initialLicense={selectedLicense}
                canReadEvents={canReadEvents}
                canRevoke={canRevoke}
                canDeactivateDevice={canDeactivateDevice}
                canUpdateLicense={canUpdateLicense}
                canSuspend={canSuspend}
                canReinstate={canReinstate}
                canRenew={canRenew}
                onBack={() => {
                  setSelectedLicense(null);
                  setRoute("registry");
                }}
              />
            )}

            {route === "tools" && (
              <StudioToolsPage
                client={client}
                environment={session.environment}
                canEdit={canUpdateLicense}
                canDelete={canRevoke}
              />
            )}

            {route === "events" && (
              <EventsPage client={client} canReadEvents={canReadEvents} />
            )}

            {route === "security" && (
              <AdminProfilePage
                client={client}
                session={session}
                onSessionUpdated={setSession}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
