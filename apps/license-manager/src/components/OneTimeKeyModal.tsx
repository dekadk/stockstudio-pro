import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Eye,
  EyeOff,
  FileLock2,
  ShieldAlert,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import type { Environment, LicenseSummary } from "../types/api";
import { EnvironmentBadge, ProductChip } from "./StatusBadge";

interface OneTimeKeyModalProps {
  client: AdminBackendClient;
  environment: Environment;
  license: LicenseSummary;
  oneTimeKey: string;
  auditEventVerified: boolean;
  onDismissed: (openDetails: boolean) => void;
}

function maskKey(raw: string): string {
  const parts = raw.split("-");
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}-${parts
      .slice(2)
      .map(() => "••••")
      .join("-")}`;
  }
  return "••••••••••••••••••••••••";
}

export const OneTimeKeyModal: React.FC<OneTimeKeyModalProps> = ({
  client,
  environment,
  license,
  oneTimeKey,
  auditEventVerified,
  onDismissed,
}) => {
  const [revealed, setRevealed] = useState(false);
  const [clipboardSecsLeft, setClipboardSecsLeft] = useState<number>(0);
  const [clipboardError, setClipboardError] = useState<string | null>(null);

  const [showExport, setShowExport] = useState(false);
  const [exportPath, setExportPath] = useState(
    `${license.key_prefix.toLowerCase()}-${license.license_id.slice(-6)}.enc.json`
  );
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  const [acknowledged, setAcknowledged] = useState(false);
  const [dismissBusy, setDismissBusy] = useState(false);

  useEffect(() => {
    if (clipboardSecsLeft <= 0) return;
    const timer = window.setInterval(() => {
      setClipboardSecsLeft((s) => (s > 1 ? s - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [clipboardSecsLeft]);

  const handleCopy = async () => {
    setClipboardError(null);
    try {
      const secs = await client.copyOneTimeKeyToClipboard(license.license_id);
      setClipboardSecsLeft(secs);
    } catch (err) {
      setClipboardError(normalizeError(err));
    }
  };

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    setExportError(null);
    if (!exportPath.trim().endsWith(".enc.json")) {
      setExportError("Export path must end with .enc.json");
      return;
    }
    if (passphrase.length < 16) {
      setExportError("Passphrase must be at least 16 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setExportError("Passphrase confirmation does not match.");
      return;
    }

    const passToUse = passphrase;
    // Clear passphrase from React state immediately
    setPassphrase("");
    setConfirmPassphrase("");
    setExportBusy(true);
    try {
      const written = await client.exportOneTimeKeyVault(
        license.license_id,
        exportPath.trim(),
        passToUse
      );
      setExportedPath(written);
      setShowExport(false);
    } catch (err) {
      setExportError(normalizeError(err));
    } finally {
      setExportBusy(false);
    }
  };

  const handleClose = async (openDetails: boolean) => {
    if (!acknowledged) return;
    setDismissBusy(true);
    try {
      await client.dismissOneTimeKey();
    } finally {
      setDismissBusy(false);
      onDismissed(openDetails);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="one-time-key-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="panel-elevated max-h-[92vh] w-full max-w-2xl overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/15 text-emerald-300">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="one-time-key-title"
                className="font-heading text-lg font-bold text-white"
              >
                License Issued — One-Time Key Handoff
              </h2>
              <p className="font-mono text-xs text-slate-400">
                {license.license_id} · {license.key_prefix}
              </p>
            </div>
          </div>
          <EnvironmentBadge environment={environment} />
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-brand-orange/40 bg-brand-orange/10 p-3 text-xs text-amber-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-brand-orange" />
          <span>
            <strong>Shown Once Only:</strong> StockStudio Pro never stores
            plaintext license keys in D1 or browser storage. Copy or export an
            encrypted <code>.enc.json</code> vault before closing this dialog.
          </span>
        </div>

        {/* Verified Metadata Summary */}
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-surface-700 bg-surface-950 p-3.5 text-xs sm:grid-cols-4">
          <div>
            <span className="text-slate-400">Plan</span>
            <p className="mt-0.5 font-semibold text-slate-100">
              {license.plan_name}
            </p>
          </div>
          <div>
            <span className="text-slate-400">Type / Interval</span>
            <p className="mt-0.5 capitalize text-slate-200">
              {license.license_type} · {license.billing_interval}
            </p>
          </div>
          <div>
            <span className="text-slate-400">Device Limit</span>
            <p className="mt-0.5 font-mono text-slate-200">
              {license.device_limit}
            </p>
          </div>
          <div>
            <span className="text-slate-400">Audit Event</span>
            <p
              className={`mt-0.5 font-semibold ${
                auditEventVerified ? "text-emerald-300" : "text-amber-300"
              }`}
            >
              {auditEventVerified ? "license.issued ✓" : "Pending sync"}
            </p>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <span className="text-slate-400">Entitled Products</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {license.entitlements.products.map((p) => (
                <ProductChip key={p} product={p} />
              ))}
            </div>
          </div>
        </div>

        {/* Masked Raw Key Box */}
        <div className="mt-4 rounded-xl border border-surface-600 bg-surface-950 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Raw License Key (Volatile Memory Only)
            </span>
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              className="btn-secondary px-2.5 py-1 text-xs"
            >
              {revealed ? (
                <>
                  <EyeOff className="h-3.5 w-3.5" />
                  Hide Key
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" />
                  Reveal Key
                </>
              )}
            </button>
          </div>

          <div
            data-testid="one-time-key-display"
            className="mt-3 select-all rounded-lg border border-surface-700 bg-surface-900 px-3.5 py-3 text-center font-mono text-base font-bold tracking-wider text-brand-orange"
          >
            {revealed ? oneTimeKey : maskKey(oneTimeKey)}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleCopy}
              className="btn-primary text-xs"
            >
              {clipboardSecsLeft > 0 ? (
                <>
                  <ClipboardCheck className="h-3.5 w-3.5" />
                  Copied (auto-clears in {clipboardSecsLeft}s)
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy Key (30s Auto-Clear)
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowExport((v) => !v)}
              className="btn-secondary text-xs"
            >
              <FileLock2 className="h-3.5 w-3.5 text-brand-orange" />
              {showExport ? "Cancel Vault Export" : "Export Encrypted .enc.json"}
            </button>
          </div>

          {clipboardError && (
            <p className="mt-2 text-xs text-rose-300">{clipboardError}</p>
          )}
          {exportedPath && (
            <p className="mt-2 text-xs text-emerald-300">
              Encrypted vault saved & round-trip verified:{" "}
              <code className="font-mono">{exportedPath}</code>
            </p>
          )}
        </div>

        {/* Optional Encrypted .enc.json Export Form */}
        {showExport && (
          <form
            onSubmit={handleExport}
            className="mt-4 space-y-3 rounded-xl border border-surface-700 bg-surface-900 p-4"
          >
            <h3 className="font-heading text-xs font-semibold uppercase tracking-wider text-slate-300">
              Encrypted Vault Export (scrypt + AES-256-GCM + Windows ACL)
            </h3>
            <div>
              <label
                htmlFor="vault-export-path"
                className="block text-[11px] text-slate-400"
              >
                Target File Path (.enc.json)
              </label>
              <input
                id="vault-export-path"
                type="text"
                value={exportPath}
                onChange={(e) => setExportPath(e.target.value)}
                className="input-dark mt-1 font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="vault-passphrase"
                  className="block text-[11px] text-slate-400"
                >
                  Vault Passphrase (min 16 chars)
                </label>
                <input
                  id="vault-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="input-dark mt-1 text-xs"
                />
              </div>
              <div>
                <label
                  htmlFor="vault-passphrase-confirm"
                  className="block text-[11px] text-slate-400"
                >
                  Confirm Passphrase
                </label>
                <input
                  id="vault-passphrase-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  className="input-dark mt-1 text-xs"
                />
              </div>
            </div>
            {exportError && (
              <p className="text-xs text-rose-300">{exportError}</p>
            )}
            <button
              type="submit"
              disabled={exportBusy}
              className="btn-primary text-xs"
            >
              {exportBusy
                ? "Encrypting & Verifying Round-Trip..."
                : "Encrypt & Save Vault"}
            </button>
          </form>
        )}

        {/* Mandatory Secure Dismissal */}
        <div className="mt-5 border-t border-surface-700 pt-4">
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-surface-600 bg-surface-950 accent-brand-orange"
            />
            <span>
              I have securely delivered or backed up this license key and
              understand it cannot be retrieved again after closing.
            </span>
          </label>

          <div className="mt-4 flex flex-wrap justify-end gap-2.5">
            <button
              type="button"
              disabled={!acknowledged || dismissBusy}
              onClick={() => handleClose(true)}
              className="btn-secondary text-xs"
            >
              Close & View License Details
            </button>
            <button
              type="button"
              disabled={!acknowledged || dismissBusy}
              onClick={() => handleClose(false)}
              className="btn-primary text-xs"
            >
              {dismissBusy ? "Wiping Key..." : "Close & Wipe Key"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
