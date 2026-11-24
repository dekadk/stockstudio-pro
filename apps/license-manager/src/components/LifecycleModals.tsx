import React, { useState } from "react";
import { AlertTriangle, Laptop, RefreshCw, ShieldOff, X } from "lucide-react";
import type {
  ActivationSummary,
  Environment,
  LicenseSummary,
} from "../types/api";
import { EnvironmentBadge, StatusBadge } from "./StatusBadge";

interface RevokeLicenseModalProps {
  environment: Environment;
  license: LicenseSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (confirmPrefix: string, reason: string) => Promise<void>;
}

export const RevokeLicenseModal: React.FC<RevokeLicenseModalProps> = ({
  environment,
  license,
  busy,
  error,
  onCancel,
  onConfirm,
}) => {
  const [prefixInput, setPrefixInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");

  const prefixMatches =
    prefixInput.trim().toUpperCase() === license.key_prefix.toUpperCase();
  const reasonValid = reasonInput.trim().length > 0;
  const canSubmit = prefixMatches && reasonValid && !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onConfirm(prefixInput.trim().toUpperCase(), reasonInput.trim());
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="panel-elevated w-full max-w-lg p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-rose-500/40 bg-rose-500/15 text-rose-400">
              <ShieldOff className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="revoke-dialog-title"
                className="font-heading text-lg font-bold text-white"
              >
                Revoke License Permanently
              </h2>
              <p className="font-mono text-xs text-slate-400">
                {license.license_id}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="Close revoke dialog"
            className="rounded-lg p-1 text-slate-400 hover:bg-surface-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-rose-500/45 bg-rose-950/35 p-3 text-xs text-rose-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <span>
            <strong>Irreversible Action:</strong> Revoking this license
            permanently terminates it and immediately revokes all active device
            activations. A revoked license cannot be reinstated.
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-surface-700 bg-surface-950 p-3.5 text-xs">
          <div>
            <dt className="text-slate-400">License Prefix</dt>
            <dd className="mt-0.5 font-mono font-semibold text-white">
              {license.key_prefix}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Current Status</dt>
            <dd className="mt-1">
              <StatusBadge status={license.status} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Customer</dt>
            <dd className="mt-0.5 text-slate-200">
              {license.customer_name || license.customer_email || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Environment</dt>
            <dd className="mt-1">
              <EnvironmentBadge environment={environment} />
            </dd>
          </div>
        </dl>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
          <div>
            <label
              htmlFor="revoke-prefix-input"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Type exact license prefix (<code>{license.key_prefix}</code>)
            </label>
            <input
              id="revoke-prefix-input"
              type="text"
              autoComplete="off"
              value={prefixInput}
              onChange={(e) => setPrefixInput(e.target.value)}
              placeholder={license.key_prefix}
              disabled={busy}
              className="input-dark mt-1.5 font-mono text-xs"
            />
          </div>

          <div>
            <label
              htmlFor="revoke-reason-input"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Revocation Reason (Recorded in Audit Log)
            </label>
            <textarea
              id="revoke-reason-input"
              rows={2}
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              placeholder="e.g., Chargeback, refund processed, lost key replacement..."
              disabled={busy}
              className="input-dark mt-1.5 text-xs"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-rose-500/40 bg-rose-950/35 px-3 py-2 text-xs text-rose-200"
            >
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2.5 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="btn-secondary text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Revoking via Rust Core...
                </>
              ) : (
                <>
                  <ShieldOff className="h-3.5 w-3.5" />
                  Confirm Permanent Revocation
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface ForceDeactivateDeviceModalProps {
  environment: Environment;
  license: LicenseSummary;
  activation: ActivationSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (confirmPrefix: string, reason: string) => Promise<void>;
}

export const ForceDeactivateDeviceModal: React.FC<
  ForceDeactivateDeviceModalProps
> = ({
  environment,
  license,
  activation,
  busy,
  error,
  onCancel,
  onConfirm,
}) => {
  const [prefixInput, setPrefixInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");

  const prefixMatches =
    prefixInput.trim().toUpperCase() === license.key_prefix.toUpperCase();
  const reasonValid = reasonInput.trim().length > 0;
  const canSubmit = prefixMatches && reasonValid && !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onConfirm(prefixInput.trim().toUpperCase(), reasonInput.trim());
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deactivate-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="panel-elevated w-full max-w-lg p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand-orange/40 bg-brand-orange/15 text-brand-orange">
              <Laptop className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="deactivate-dialog-title"
                className="font-heading text-lg font-bold text-white"
              >
                Force Deactivate Device
              </h2>
              <p className="font-mono text-xs text-slate-400">
                Activation {activation.activation_id}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="Close force deactivate dialog"
            className="rounded-lg p-1 text-slate-400 hover:bg-surface-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-surface-700 bg-surface-950 p-3.5 text-xs">
          <div>
            <dt className="text-slate-400">Selected Device</dt>
            <dd className="mt-0.5 font-semibold text-white">
              {activation.device_name || activation.device_id}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Activation ID</dt>
            <dd className="mt-0.5 font-mono text-[11px] text-slate-200">
              {activation.activation_id}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Target License</dt>
            <dd className="mt-0.5 font-mono text-brand-orange">
              {license.key_prefix} ({license.license_id})
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Environment</dt>
            <dd className="mt-1">
              <EnvironmentBadge environment={environment} />
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-slate-300">
          Only this single device activation will be deactivated and its slot
          released. Other devices on this license will remain unaffected.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
          <div>
            <label
              htmlFor="deactivate-prefix-input"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Type exact license prefix (<code>{license.key_prefix}</code>)
            </label>
            <input
              id="deactivate-prefix-input"
              type="text"
              autoComplete="off"
              value={prefixInput}
              onChange={(e) => setPrefixInput(e.target.value)}
              placeholder={license.key_prefix}
              disabled={busy}
              className="input-dark mt-1.5 font-mono text-xs"
            />
          </div>

          <div>
            <label
              htmlFor="deactivate-reason-input"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Deactivation Reason (Recorded in Audit Log)
            </label>
            <textarea
              id="deactivate-reason-input"
              rows={2}
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              placeholder="e.g., Customer replaced workstation, lost laptop..."
              disabled={busy}
              className="input-dark mt-1.5 text-xs"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-rose-500/40 bg-rose-950/35 px-3 py-2 text-xs text-rose-200"
            >
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2.5 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="btn-secondary text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="btn-primary text-xs"
            >
              {busy ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Deactivating via Rust Core...
                </>
              ) : (
                <>
                  <Laptop className="h-3.5 w-3.5" />
                  Confirm Force Deactivate
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
