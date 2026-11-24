import React, { useState } from "react";
import {
  Clock,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import { ErrorPanel } from "../components/StateViews";
import { EnvironmentBadge } from "../components/StatusBadge";
import type { Environment, SessionStatus } from "../types/api";
import { formatCountdown, formatDateTime } from "../utils/format";

interface AdminProfilePageProps {
  client: AdminBackendClient;
  session: SessionStatus;
  onSessionUpdated: (next: SessionStatus) => void;
}

export const AdminProfilePage: React.FC<AdminProfilePageProps> = ({
  client,
  session,
  onSessionUpdated,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const admin = session.admin_me?.admin ?? null;

  const runAction = async (fn: () => Promise<SessionStatus>, okMsg?: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await fn();
      onSessionUpdated(next);
      if (okMsg) setMessage(okMsg);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshMe = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await client.fetchAdminMe();
      const next = await client.getSessionStatus();
      onSessionUpdated(next);
      setMessage("Verified administrator identity against /v1/admin/me.");
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">
            Admin Profile & Security
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Authenticated administrator principal, RBAC permissions, credential
            storage status, and idle auto-lock controls.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={handleRefreshMe}
          className="btn-secondary text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          Re-Verify Identity
        </button>
      </div>

      {error && <ErrorPanel title="Security action failed" message={error} />}
      {message && (
        <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/25 px-4 py-2.5 text-xs text-emerald-200">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Identity Card */}
        <section className="panel p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <ShieldCheck className="h-4 w-4 text-brand-orange" />
              <h2 className="font-heading">Authenticated Identity</h2>
            </div>
            <EnvironmentBadge environment={session.environment} />
          </div>

          {admin ? (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <div>
                <dt className="text-slate-400">Admin ID</dt>
                <dd className="mt-0.5 font-mono text-slate-100">{admin.id}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Display Name</dt>
                <dd className="mt-0.5 font-medium text-slate-100">
                  {admin.name}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Role</dt>
                <dd className="mt-0.5 font-mono font-semibold text-brand-orange">
                  {admin.role}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Key Prefix</dt>
                <dd className="mt-0.5 font-mono text-slate-200">
                  {admin.key_prefix}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Signing Key ID</dt>
                <dd className="mt-0.5 font-mono text-slate-200">
                  {session.admin_me?.signing_kid || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">IP Allowlist</dt>
                <dd className="mt-0.5 text-slate-200">
                  {admin.allowed_ips_configured ? "Enforced" : "Not configured"}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-400">Last Verified</dt>
                <dd className="mt-0.5 text-slate-200">
                  {formatDateTime(admin.last_used_at)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-xs text-slate-400">
              No active administrator profile loaded.
            </p>
          )}
        </section>

        {/* Permissions Matrix */}
        <section className="panel p-5">
          <h2 className="font-heading text-sm font-semibold text-white">
            Effective Role Permissions
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Returned directly by{" "}
            <code className="font-mono text-slate-300">GET /v1/admin/me</code>.
            LM-03 UI operates in read-only mode regardless of write grants.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(admin?.permissions ?? []).map((perm) => (
              <span
                key={perm}
                className="rounded-md border border-brand-orange/30 bg-brand-orange/10 px-2.5 py-1 font-mono text-[11px] font-medium text-brand-orange"
              >
                {perm}
              </span>
            ))}
          </div>
        </section>
      </div>

      {/* Credential & Idle Auto-Lock Controls */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <KeyRound className="h-4 w-4 text-brand-orange" />
            <h2 className="font-heading">Credential & Lock Status</h2>
          </div>

          <dl className="mt-4 space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">Session Lock State</dt>
              <dd className="font-semibold text-emerald-300">
                {session.unlocked ? "Unlocked (In Zeroized RAM)" : "Locked"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">Windows Credential Manager</dt>
              <dd className="font-mono text-slate-200">
                {session.has_stored_credential
                  ? "Stored (Encrypted by OS)"
                  : "Not Stored (Session-Only)"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">Isolated Service Name</dt>
              <dd className="font-mono text-[11px] text-slate-300">
                {session.credential_service}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">API Gateway</dt>
              <dd className="font-mono text-[11px] text-slate-300">
                {session.api_base_url}
              </dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => client.lockSession())}
              className="btn-secondary text-xs"
            >
              <Lock className="h-3.5 w-3.5 text-brand-orange" />
              Lock Session Now
            </button>
            {session.has_stored_credential && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runAction(
                    () => client.forgetStoredCredential(),
                    "Removed stored key from Windows Credential Manager."
                  )
                }
                className="btn-danger-subtle text-xs"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Forget Stored Key
              </button>
            )}
          </div>
        </section>

        <section className="panel p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Clock className="h-4 w-4 text-brand-orange" />
            <h2 className="font-heading">Idle Auto-Lock & Environment</h2>
          </div>

          <div className="mt-4 flex items-center justify-between rounded-lg border border-surface-700 bg-surface-950 p-3.5">
            <div>
              <p className="text-xs font-medium text-slate-200">
                Time Until Auto-Lock
              </p>
              <p className="text-[11px] text-slate-400">
                In-memory key is zeroized automatically on expiry
              </p>
            </div>
            <span className="font-mono text-lg font-bold text-brand-orange">
              {formatCountdown(session.idle_remaining_secs)}
            </span>
          </div>

          <div className="mt-4">
            <label
              htmlFor="idle-timeout-select"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Idle Timeout Duration
            </label>
            <select
              id="idle-timeout-select"
              disabled={busy}
              value={session.idle_timeout_secs}
              onChange={(e) =>
                runAction(
                  () => client.setIdleTimeout(Number(e.target.value)),
                  "Updated idle auto-lock timeout."
                )
              }
              className="input-dark mt-1.5 text-xs"
            >
              <option value={300}>5 minutes</option>
              <option value={900}>15 minutes (Recommended)</option>
              <option value={1800}>30 minutes</option>
            </select>
          </div>

          <div className="mt-4 border-t border-surface-800 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Switch Environment (Auto-Locks Session)
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["staging", "production"] as Environment[]).map((env) => (
                <button
                  key={env}
                  type="button"
                  disabled={busy || session.environment === env}
                  onClick={() => runAction(() => client.setEnvironment(env))}
                  className="btn-secondary text-xs uppercase"
                >
                  Switch to {env}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
