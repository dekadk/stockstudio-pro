import React, { useState } from "react";
import { KeyRound, Lock, ShieldAlert, ShieldCheck } from "lucide-react";
import type { Environment, SessionStatus } from "../types/api";
import { EnvironmentBadge } from "./StatusBadge";

interface UnlockGateProps {
  session: SessionStatus;
  busy: boolean;
  error: string | null;
  onSelectEnvironment: (env: Environment) => Promise<void>;
  onUnlockWithKey: (
    apiKey: string,
    rememberInKeyring: boolean
  ) => Promise<void>;
  onUnlockFromKeyring: () => Promise<void>;
}

export const UnlockGate: React.FC<UnlockGateProps> = ({
  session,
  busy,
  error,
  onSelectEnvironment,
  onUnlockWithKey,
  onUnlockFromKeyring,
}) => {
  const [keyInput, setKeyInput] = useState("");
  const [rememberInKeyring, setRememberInKeyring] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const submitted = keyInput.trim();
    if (!submitted) return;
    // Immediately clear React input state so key is never retained in renderer memory.
    setKeyInput("");
    await onUnlockWithKey(submitted, rememberInKeyring);
  };

  const isProd = session.environment === "production";

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-950 p-6">
      <div className="panel-elevated w-full max-w-md p-7">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-orange text-sm font-black text-surface-950">
              SS
            </div>
            <div>
              <h1 className="font-heading text-lg font-bold text-white">
                License Manager
              </h1>
              <p className="text-[11px] uppercase tracking-widest text-slate-400">
                StockStudio Pro Admin
              </p>
            </div>
          </div>
          <EnvironmentBadge environment={session.environment} />
        </div>

        {session.locked_reason && (
          <div className="mt-4 rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 text-xs text-slate-300">
            <span className="font-semibold text-brand-orange">Locked: </span>
            {session.locked_reason}
          </div>
        )}

        <div className="mt-5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Target Environment
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["staging", "production"] as Environment[]).map((env) => {
              const selected = session.environment === env;
              return (
                <button
                  key={env}
                  type="button"
                  disabled={busy}
                  onClick={() => onSelectEnvironment(env)}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-wider transition ${
                    selected
                      ? env === "production"
                        ? "border-rose-500/60 bg-rose-500/15 text-rose-200"
                        : "border-brand-orange/60 bg-brand-orange/15 text-brand-orange"
                      : "border-surface-700 bg-surface-950 text-slate-400 hover:border-surface-600 hover:text-slate-200"
                  }`}
                >
                  {env}
                </button>
              );
            })}
          </div>
          <p className="mt-2 font-mono text-[11px] text-slate-500">
            {session.api_base_url}
          </p>
        </div>

        {isProd && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>
              <strong>Production Environment Selected.</strong> Actions affect
              live customer licenses and require explicit confirmation.
            </span>
          </div>
        )}

        {session.has_stored_credential && (
          <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
              <ShieldCheck className="h-4 w-4" />
              Windows Credential Manager Key Available
            </div>
            <p className="mt-1 text-[11px] text-slate-400">
              Stored under isolated service{" "}
              <code className="text-slate-300">
                {session.credential_service}
              </code>
              .
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={onUnlockFromKeyring}
              className="btn-primary mt-3 w-full text-xs"
            >
              <Lock className="h-3.5 w-3.5" />
              {busy ? "Verifying via /v1/admin/me..." : "Unlock Stored Session"}
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-3.5">
          <div>
            <label
              htmlFor="admin-key-input"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Admin API Key (Verified in Rust Core)
            </label>
            <input
              id="admin-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste Admin API Key..."
              disabled={busy}
              className="input-dark mt-1.5 font-mono"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={rememberInKeyring}
              onChange={(e) => setRememberInKeyring(e.target.checked)}
              disabled={busy}
              className="h-4 w-4 rounded border-surface-600 bg-surface-950 accent-brand-orange"
            />
            Store in Windows Credential Manager (isolated service)
          </label>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-rose-500/40 bg-rose-950/35 px-3 py-2 text-xs text-rose-200"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || keyInput.trim().length === 0}
            className="btn-primary w-full"
          >
            <KeyRound className="h-4 w-4" />
            {busy ? "Authenticating..." : "Unlock License Manager"}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-slate-500">
          All Admin API requests execute inside the Rust core. Admin keys are
          held in zeroized memory and never written to browser storage.
        </p>
      </div>
    </div>
  );
};
