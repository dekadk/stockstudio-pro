import React, { useState } from "react";
import {
  CalendarPlus,
  Edit3,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  X,
} from "lucide-react";
import type { Environment, LicenseSummary, ProductCode } from "../types/api";
import { EnvironmentBadge } from "./StatusBadge";

interface EditLicenseModalProps {
  environment: Environment;
  license: LicenseSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (payload: {
    device_limit: number;
    customer_email?: string;
    customer_name?: string;
    notes?: string;
    entitlements: { products: ProductCode[] };
  }) => Promise<void>;
}

export const EditLicenseModal: React.FC<EditLicenseModalProps> = ({
  environment,
  license,
  busy,
  error,
  onCancel,
  onConfirm,
}) => {
  const [deviceLimit, setDeviceLimit] = useState(String(license.device_limit));
  const [customerEmail, setCustomerEmail] = useState(
    license.customer_email || ""
  );
  const [customerName, setCustomerName] = useState(license.customer_name || "");
  const [notes, setNotes] = useState(license.notes || "");
  const [includeDesktop, setIncludeDesktop] = useState(
    license.entitlements.products.includes("desktop")
  );
  const [includeExtension, setIncludeExtension] = useState(
    license.entitlements.products.includes("vectorizer_extension")
  );

  const products: ProductCode[] = [];
  if (includeDesktop) products.push("desktop");
  if (includeExtension) products.push("vectorizer_extension");

  const parsedLimit = Number(deviceLimit);
  const limitValid =
    Number.isInteger(parsedLimit) &&
    parsedLimit >= Math.max(1, license.devices_used) &&
    parsedLimit <= 100;
  const canSubmit = limitValid && products.length > 0 && !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onConfirm({
      device_limit: parsedLimit,
      customer_email: customerEmail.trim(),
      customer_name: customerName.trim(),
      notes: notes.trim(),
      entitlements: { products },
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-license-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="panel-elevated w-full max-w-lg p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand-orange/40 bg-brand-orange/15 text-brand-orange">
              <Edit3 className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="edit-license-title"
                className="font-heading text-lg font-bold text-white"
              >
                Edit License Metadata & Entitlements
              </h2>
              <p className="font-mono text-xs text-slate-400">
                {license.key_prefix} · {license.license_id}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="Close edit dialog"
            className="rounded-lg p-1 text-slate-400 hover:bg-surface-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Target Environment</span>
            <EnvironmentBadge environment={environment} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="edit-device-limit"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Device Limit (min {Math.max(1, license.devices_used)})
              </label>
              <input
                id="edit-device-limit"
                type="number"
                value={deviceLimit}
                onChange={(e) => setDeviceLimit(e.target.value)}
                disabled={busy}
                className="input-dark mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="edit-customer-name"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Customer Name
              </label>
              <input
                id="edit-customer-name"
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                disabled={busy}
                className="input-dark mt-1 text-xs"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="edit-customer-email"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Customer Email
            </label>
            <input
              id="edit-customer-email"
              type="text"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              disabled={busy}
              className="input-dark mt-1 text-xs"
            />
          </div>

          <div>
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Product Entitlements
            </span>
            <div className="mt-1.5 flex flex-wrap gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-slate-200">
                <input
                  type="checkbox"
                  checked={includeDesktop}
                  onChange={(e) => setIncludeDesktop(e.target.checked)}
                  disabled={busy}
                  className="h-4 w-4 rounded border-surface-600 bg-surface-950 accent-brand-orange"
                />
                Desktop (<code>desktop</code>)
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-slate-200">
                <input
                  type="checkbox"
                  checked={includeExtension}
                  onChange={(e) => setIncludeExtension(e.target.checked)}
                  disabled={busy}
                  className="h-4 w-4 rounded border-surface-600 bg-surface-950 accent-brand-orange"
                />
                Vectorizer Extension (<code>vectorizer_extension</code>)
              </label>
            </div>
          </div>

          <div>
            <label
              htmlFor="edit-notes"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Admin Notes
            </label>
            <textarea
              id="edit-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
              className="input-dark mt-1 text-xs"
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
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface ReasonActionModalProps {
  mode: "suspend" | "reinstate";
  environment: Environment;
  license: LicenseSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

export const ReasonActionModal: React.FC<ReasonActionModalProps> = ({
  mode,
  environment,
  license,
  busy,
  error,
  onCancel,
  onConfirm,
}) => {
  const [reason, setReason] = useState("");
  const isSuspend = mode === "suspend";
  const canSubmit = reason.trim().length > 0 && !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onConfirm(reason.trim());
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reason-action-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="panel-elevated w-full max-w-md p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand-orange/40 bg-brand-orange/15 text-brand-orange">
              {isSuspend ? (
                <PauseCircle className="h-5 w-5" />
              ) : (
                <PlayCircle className="h-5 w-5" />
              )}
            </div>
            <div>
              <h2
                id="reason-action-title"
                className="font-heading text-lg font-bold text-white"
              >
                {isSuspend ? "Suspend License" : "Reinstate License"}
              </h2>
              <p className="font-mono text-xs text-slate-400">
                {license.key_prefix} · {license.license_id}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="Close action dialog"
            className="rounded-lg p-1 text-slate-400 hover:bg-surface-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Environment</span>
            <EnvironmentBadge environment={environment} />
          </div>

          <div>
            <label
              htmlFor="lifecycle-reason-input"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              {isSuspend ? "Suspension Reason" : "Reinstatement Reason"}
            </label>
            <textarea
              id="lifecycle-reason-input"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                isSuspend
                  ? "e.g., Temporary hold pending payment verification..."
                  : "e.g., Payment confirmed, restoring customer access..."
              }
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
              {busy
                ? "Submitting..."
                : isSuspend
                ? "Confirm Suspend"
                : "Confirm Reinstate"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface RenewSubscriptionModalProps {
  environment: Environment;
  license: LicenseSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (payload: {
    billing_provider: string;
    external_payment_id: string;
    new_period_start: string;
    new_period_end: string;
    reason?: string;
  }) => Promise<void>;
}

export const RenewSubscriptionModal: React.FC<RenewSubscriptionModalProps> = ({
  environment,
  license,
  busy,
  error,
  onCancel,
  onConfirm,
}) => {
  const defaultStart =
    license.current_period_end ||
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const startMs = Number.isFinite(Date.parse(defaultStart))
    ? Date.parse(defaultStart)
    : Date.now();
  const days = license.billing_interval === "yearly" ? 365 : 30;
  const defaultEnd = new Date(startMs + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  const [paymentId, setPaymentId] = useState("");
  const [provider, setProvider] = useState("manual_admin");
  const [periodStart, setPeriodStart] = useState(defaultStart);
  const [periodEnd, setPeriodEnd] = useState(defaultEnd);
  const [reason, setReason] = useState("");

  const datesValid =
    Number.isFinite(Date.parse(periodStart)) &&
    Number.isFinite(Date.parse(periodEnd)) &&
    Date.parse(periodEnd) > Date.parse(periodStart);
  const canSubmit = paymentId.trim().length > 0 && datesValid && !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onConfirm({
      billing_provider: provider.trim() || "manual_admin",
      external_payment_id: paymentId.trim(),
      new_period_start: periodStart.trim(),
      new_period_end: periodEnd.trim(),
      reason: reason.trim() || undefined,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="renew-sub-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="panel-elevated w-full max-w-lg p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand-orange/40 bg-brand-orange/15 text-brand-orange">
              <CalendarPlus className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="renew-sub-title"
                className="font-heading text-lg font-bold text-white"
              >
                Renew Subscription Period
              </h2>
              <p className="font-mono text-xs text-slate-400">
                {license.key_prefix} · {license.billing_interval}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="Close renew dialog"
            className="rounded-lg p-1 text-slate-400 hover:bg-surface-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Environment</span>
            <EnvironmentBadge environment={environment} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="renew-payment-id"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                External Payment / Invoice ID
              </label>
              <input
                id="renew-payment-id"
                type="text"
                value={paymentId}
                onChange={(e) => setPaymentId(e.target.value)}
                placeholder="inv_2026_001"
                disabled={busy}
                className="input-dark mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="renew-provider"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Billing Provider
              </label>
              <input
                id="renew-provider"
                type="text"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={busy}
                className="input-dark mt-1 font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="renew-period-start"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                New Period Start (ISO UTC)
              </label>
              <input
                id="renew-period-start"
                type="text"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                disabled={busy}
                className="input-dark mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="renew-period-end"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                New Period End (ISO UTC)
              </label>
              <input
                id="renew-period-end"
                type="text"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                disabled={busy}
                className="input-dark mt-1 font-mono text-xs"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="renew-reason"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Notes / Reason (Optional)
            </label>
            <input
              id="renew-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Confirmed manual renewal payment"
              disabled={busy}
              className="input-dark mt-1 text-xs"
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
              {busy ? "Renewing..." : "Confirm Renewal"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
