import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  PlusCircle,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import { OneTimeKeyModal } from "../components/OneTimeKeyModal";
import { EnvironmentBadge, ProductChip } from "../components/StatusBadge";
import type {
  BillingInterval,
  CreateLicensePayload,
  Environment,
  IssueLicenseResult,
  LicenseSummary,
  LicenseType,
  ProductCode,
} from "../types/api";

interface IssueLicensePageProps {
  client: AdminBackendClient;
  environment: Environment;
  apiBaseUrl: string;
  canCreateLicense: boolean;
  onNavigateRegistry: () => void;
  onNavigateEvents: () => void;
  onOpenLicenseDetails: (license: LicenseSummary) => void;
}

type PlanPreset = "lifetime" | "monthly" | "yearly";

function generateDraftIdempotencyKey(env: Environment): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `lm-${env}-${rand}`;
}

function defaultPeriodDates(days: number): { start: string; end: string } {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
  );
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    end: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export const IssueLicensePage: React.FC<IssueLicensePageProps> = ({
  client,
  environment,
  apiBaseUrl,
  canCreateLicense,
  onNavigateRegistry,
  onNavigateEvents,
  onOpenLicenseDetails,
}) => {
  const [preset, setPreset] = useState<PlanPreset>("lifetime");
  const [planCode, setPlanCode] = useState("lifetime");
  const [planName, setPlanName] = useState("Lifetime Pro");
  const [deviceLimit, setDeviceLimit] = useState("2");

  const defaultMonth = useMemo(() => defaultPeriodDates(30), []);
  const [periodStart, setPeriodStart] = useState(defaultMonth.start);
  const [periodEnd, setPeriodEnd] = useState(defaultMonth.end);

  const [includeDesktop, setIncludeDesktop] = useState(true);
  const [includeExtension, setIncludeExtension] = useState(true);

  const [customerEmail, setCustomerEmail] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [externalCustomerId, setExternalCustomerId] = useState("");
  const [externalOrderId, setExternalOrderId] = useState("");
  const [notes, setNotes] = useState("");

  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    generateDraftIdempotencyKey(environment)
  );

  const [reviewing, setReviewing] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [prodConfirmPhrase, setProdConfirmPhrase] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<IssueLicenseResult | null>(null);

  if (!canCreateLicense) {
    return (
      <div className="panel flex items-start gap-3 p-6 text-amber-200">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-brand-orange" />
        <div>
          <h2 className="font-heading text-base font-semibold text-white">
            Restricted by Role Permissions
          </h2>
          <p className="mt-1 text-xs text-slate-300">
            Issuing licenses requires the{" "}
            <code className="font-mono text-brand-orange">licenses:create</code>{" "}
            permission (<code>super_admin</code> or <code>billing_system</code>
            ).
          </p>
        </div>
      </div>
    );
  }

  const isProd = environment === "production";
  const licenseType: LicenseType =
    preset === "lifetime" ? "perpetual" : "subscription";
  const billingInterval: BillingInterval =
    preset === "lifetime" ? "lifetime" : preset;

  const selectedProducts: ProductCode[] = [];
  if (includeDesktop) selectedProducts.push("desktop");
  if (includeExtension) selectedProducts.push("vectorizer_extension");

  const applyPreset = (next: PlanPreset) => {
    setPreset(next);
    setReviewing(false);
    setValidationError(null);
    if (next === "lifetime") {
      setPlanCode("lifetime");
      setPlanName("Lifetime Pro");
    } else if (next === "monthly") {
      setPlanCode("pro_monthly");
      setPlanName("Pro Monthly");
      const d = defaultPeriodDates(30);
      setPeriodStart(d.start);
      setPeriodEnd(d.end);
    } else {
      setPlanCode("pro_yearly");
      setPlanName("Pro Yearly");
      const d = defaultPeriodDates(365);
      setPeriodStart(d.start);
      setPeriodEnd(d.end);
    }
  };

  const validateForm = (): CreateLicensePayload | null => {
    const trimmedCode = planCode.trim();
    const trimmedName = planName.trim();
    if (!trimmedCode || !trimmedName) {
      setValidationError("Plan code and plan name are required.");
      return null;
    }

    const parsedLimit = Number(deviceLimit);
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 100
    ) {
      setValidationError("Device limit must be an integer between 1 and 100.");
      return null;
    }

    if (selectedProducts.length === 0) {
      setValidationError(
        "Select at least one entitlement (Desktop or Vectorizer Extension)."
      );
      return null;
    }

    const trimmedEmail = customerEmail.trim();
    if (
      trimmedEmail.length > 0 &&
      (!trimmedEmail.includes("@") || !trimmedEmail.includes("."))
    ) {
      setValidationError("Customer email must be a valid email address.");
      return null;
    }

    if (licenseType === "subscription") {
      const sMs = Date.parse(periodStart.trim());
      const eMs = Date.parse(periodEnd.trim());
      if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) {
        setValidationError(
          "Subscription period start and end must be valid ISO-8601 UTC timestamps."
        );
        return null;
      }
      if (eMs <= sMs) {
        setValidationError(
          "Subscription period end must be after period start."
        );
        return null;
      }
    }

    setValidationError(null);
    return {
      plan_code: trimmedCode,
      plan_name: trimmedName,
      license_type: licenseType,
      billing_interval: billingInterval,
      device_limit: parsedLimit,
      ...(licenseType === "subscription"
        ? {
            current_period_start: periodStart.trim(),
            current_period_end: periodEnd.trim(),
            expires_at: periodEnd.trim(),
          }
        : {}),
      ...(trimmedEmail ? { customer_email: trimmedEmail } : {}),
      ...(customerName.trim() ? { customer_name: customerName.trim() } : {}),
      ...(externalCustomerId.trim()
        ? { external_customer_id: externalCustomerId.trim() }
        : {}),
      ...(externalOrderId.trim()
        ? { external_order_id: externalOrderId.trim() }
        : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      entitlements: {
        products: selectedProducts,
      },
    };
  };

  const handleProceedToReview = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = validateForm();
    if (!payload) return;
    setConfirmChecked(false);
    setProdConfirmPhrase("");
    setOutcome(null);
    setReviewing(true);
  };

  const handleConfirmAndIssue = async () => {
    const payload = validateForm();
    if (!payload || !confirmChecked) return;
    if (isProd && prodConfirmPhrase.trim() !== "ISSUE PRODUCTION") return;

    setSubmitting(true);
    setValidationError(null);
    try {
      const res = await client.issueLicense({
        expected_environment: environment,
        idempotency_key: idempotencyKey,
        payload,
      });
      setOutcome(res);
      if (res.outcome !== "created") {
        setReviewing(false);
      }
    } catch (err) {
      setValidationError(normalizeError(err));
      setReviewing(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartNewDraft = () => {
    setOutcome(null);
    setReviewing(false);
    setConfirmChecked(false);
    setProdConfirmPhrase("");
    setValidationError(null);
    setIdempotencyKey(generateDraftIdempotencyKey(environment));
  };

  const prodPhraseSatisfied =
    !isProd || prodConfirmPhrase.trim() === "ISSUE PRODUCTION";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">
            Issue New License
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Submits{" "}
            <code className="font-mono text-slate-300">
              POST /v1/admin/licenses
            </code>{" "}
            exclusively through Rust with idempotency protection and one-time
            key handoff.
          </p>
        </div>
        <EnvironmentBadge environment={environment} />
      </div>

      {/* Prominent Environment Safeguard */}
      <div
        className={`flex items-start gap-3 rounded-xl border p-4 text-xs ${
          isProd
            ? "border-rose-500/50 bg-rose-950/35 text-rose-100"
            : "border-brand-orange/40 bg-brand-orange/10 text-amber-100"
        }`}
      >
        <ShieldAlert
          className={`mt-0.5 h-5 w-5 shrink-0 ${
            isProd ? "text-rose-400" : "text-brand-orange"
          }`}
        />
        <div>
          <p className="font-semibold uppercase tracking-wider">
            {isProd
              ? "PRODUCTION ISSUANCE — LIVE CUSTOMER DATABASE"
              : "STAGING ISSUANCE — SAFE INTEGRATION SANDBOX"}
          </p>
          <p className="mt-0.5 font-mono text-[11px] opacity-85">
            Target Gateway: {apiBaseUrl} · Draft Idempotency-Key:{" "}
            {idempotencyKey}
          </p>
        </div>
      </div>

      {/* Uncertain Outcome Panel (Timeout / Dropped Connection) */}
      {outcome?.outcome === "uncertain" && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/50 bg-amber-950/35 p-5 text-xs text-amber-100"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div className="flex-1 space-y-2">
              <h2 className="font-heading text-sm font-bold text-white">
                Uncertain Issuance Outcome — Automatic Retry Blocked
              </h2>
              <p>{outcome.message}</p>
              <p className="font-mono text-[11px] text-amber-200/80">
                Idempotency-Key: {outcome.idempotency_key}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={onNavigateRegistry}
                  className="btn-primary text-xs"
                >
                  Inspect License Registry
                </button>
                <button
                  type="button"
                  onClick={onNavigateEvents}
                  className="btn-secondary text-xs"
                >
                  Inspect Events & Activity
                </button>
                <button
                  type="button"
                  onClick={handleStartNewDraft}
                  className="btn-secondary text-xs"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Start Fresh Draft (After Verification)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate Conflict (HTTP 409) */}
      {outcome?.outcome === "duplicate_conflict" && (
        <div
          role="alert"
          className="rounded-xl border border-brand-orange/50 bg-brand-orange/10 p-5 text-xs text-amber-100"
        >
          <h2 className="font-heading text-sm font-bold text-white">
            Duplicate Issuance Prevented (HTTP 409)
          </h2>
          <p className="mt-1">{outcome.message}</p>
          {outcome.existing_license_id && (
            <p className="mt-1.5 font-mono text-[11px]">
              Existing License: {outcome.existing_license_id} (
              {outcome.existing_key_prefix || "—"})
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onNavigateRegistry}
              className="btn-secondary text-xs"
            >
              View in Registry
            </button>
            <button
              type="button"
              onClick={handleStartNewDraft}
              className="btn-primary text-xs"
            >
              Start New License Draft
            </button>
          </div>
        </div>
      )}

      {/* Rejected (400/401/403) */}
      {outcome?.outcome === "rejected" && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-xs text-rose-200"
        >
          <strong>Issuance Rejected:</strong> {outcome.message}
        </div>
      )}

      {validationError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-xs text-rose-200"
        >
          {validationError}
        </div>
      )}

      {/* Step 1: Create License Form */}
      {!reviewing && (
        <form onSubmit={handleProceedToReview} className="panel space-y-5 p-6">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              License Plan Model
            </label>
            <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {(
                [
                  {
                    id: "lifetime",
                    title: "Perpetual / Lifetime",
                    sub: "Never expires · billing_interval: lifetime",
                  },
                  {
                    id: "monthly",
                    title: "Monthly Subscription",
                    sub: "30-day period · billing_interval: monthly",
                  },
                  {
                    id: "yearly",
                    title: "Yearly Subscription",
                    sub: "365-day period · billing_interval: yearly",
                  },
                ] as const
              ).map((item) => {
                const active = preset === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => applyPreset(item.id)}
                    className={`rounded-xl border p-3.5 text-left transition ${
                      active
                        ? "border-brand-orange bg-brand-orange/15 text-white"
                        : "border-surface-700 bg-surface-950 text-slate-300 hover:border-surface-600"
                    }`}
                  >
                    <p className="font-heading text-sm font-semibold">
                      {item.title}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {item.sub}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label
                htmlFor="issue-plan-code"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Plan Code
              </label>
              <input
                id="issue-plan-code"
                type="text"
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value)}
                className="input-dark mt-1.5 font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="issue-plan-name"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Plan Display Name
              </label>
              <input
                id="issue-plan-name"
                type="text"
                value={planName}
                onChange={(e) => setPlanName(e.target.value)}
                className="input-dark mt-1.5 text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="issue-device-limit"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Device Limit (1–100)
              </label>
              <input
                id="issue-device-limit"
                type="number"
                value={deviceLimit}
                onChange={(e) => setDeviceLimit(e.target.value)}
                className="input-dark mt-1.5 font-mono text-xs"
              />
            </div>
          </div>

          {licenseType === "subscription" && (
            <div className="grid grid-cols-1 gap-4 rounded-xl border border-surface-700 bg-surface-950 p-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="issue-period-start"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  Period Start (ISO-8601 UTC)
                </label>
                <input
                  id="issue-period-start"
                  type="text"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="input-dark mt-1.5 font-mono text-xs"
                />
              </div>
              <div>
                <label
                  htmlFor="issue-period-end"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  Period End / Expires At (ISO-8601 UTC)
                </label>
                <input
                  id="issue-period-end"
                  type="text"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="input-dark mt-1.5 font-mono text-xs"
                />
              </div>
            </div>
          )}

          <div>
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Product Entitlements
            </span>
            <div className="mt-2 flex flex-wrap gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={includeDesktop}
                  onChange={(e) => setIncludeDesktop(e.target.checked)}
                  className="h-4 w-4 rounded border-surface-600 bg-surface-950 accent-brand-orange"
                />
                Desktop Application (<code>desktop</code>)
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={includeExtension}
                  onChange={(e) => setIncludeExtension(e.target.checked)}
                  className="h-4 w-4 rounded border-surface-600 bg-surface-950 accent-brand-orange"
                />
                Vectorizer Chrome Extension (<code>vectorizer_extension</code>)
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="issue-customer-email"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Customer Email (Optional)
              </label>
              <input
                id="issue-customer-email"
                type="text"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="customer@example.com"
                className="input-dark mt-1.5 text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="issue-customer-name"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Customer Name (Optional)
              </label>
              <input
                id="issue-customer-name"
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Full name or studio"
                className="input-dark mt-1.5 text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="issue-external-customer"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                External Customer ID (Optional)
              </label>
              <input
                id="issue-external-customer"
                type="text"
                value={externalCustomerId}
                onChange={(e) => setExternalCustomerId(e.target.value)}
                className="input-dark mt-1.5 font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="issue-external-order"
                className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                External Order ID (Optional)
              </label>
              <input
                id="issue-external-order"
                type="text"
                value={externalOrderId}
                onChange={(e) => setExternalOrderId(e.target.value)}
                className="input-dark mt-1.5 font-mono text-xs"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="issue-notes"
              className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              Administrative Notes (Optional)
            </label>
            <textarea
              id="issue-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Order context, invoice reference, or internal note..."
              className="input-dark mt-1.5 text-xs"
            />
          </div>

          <div className="flex justify-end gap-2.5 border-t border-surface-800 pt-4">
            <button type="submit" className="btn-primary">
              <PlusCircle className="h-4 w-4" />
              Review Issuance Summary
            </button>
          </div>
        </form>
      )}

      {/* Step 2: Explicit Confirmation Summary */}
      {reviewing && (
        <div className="panel-elevated space-y-5 p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-lg font-bold text-white">
              Confirm License Issuance
            </h2>
            <EnvironmentBadge environment={environment} />
          </div>

          <dl className="grid grid-cols-2 gap-4 rounded-xl border border-surface-700 bg-surface-950 p-4 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-slate-400">Plan</dt>
              <dd className="mt-0.5 font-semibold text-white">
                {planName} ({planCode})
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Type / Billing Interval</dt>
              <dd className="mt-0.5 capitalize text-slate-200">
                {licenseType} · {billingInterval}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Device Limit</dt>
              <dd className="mt-0.5 font-mono font-semibold text-brand-orange">
                {deviceLimit}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Customer</dt>
              <dd className="mt-0.5 text-slate-200">
                {customerName.trim() || "—"} ({customerEmail.trim() || "—"})
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Validity</dt>
              <dd className="mt-0.5 font-mono text-[11px] text-slate-200">
                {licenseType === "perpetual"
                  ? "Lifetime (No Expiry)"
                  : `${periodStart} → ${periodEnd}`}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Entitlements</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {selectedProducts.map((p) => (
                  <ProductChip key={p} product={p} />
                ))}
              </dd>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-slate-400">Idempotency-Key</dt>
              <dd className="mt-0.5 font-mono text-[11px] text-slate-300">
                {idempotencyKey}
              </dd>
            </div>
          </dl>

          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(e) => setConfirmChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-surface-600 bg-surface-950 accent-brand-orange"
            />
            <span>
              I confirm all license parameters above are accurate and authorize
              issuing this license in{" "}
              <strong className="uppercase">{environment}</strong>.
            </span>
          </label>

          {isProd && (
            <div>
              <label
                htmlFor="prod-confirm-phrase"
                className="block text-[11px] font-semibold uppercase tracking-wider text-rose-300"
              >
                Production Guard — Type <code>ISSUE PRODUCTION</code> to enable
              </label>
              <input
                id="prod-confirm-phrase"
                type="text"
                value={prodConfirmPhrase}
                onChange={(e) => setProdConfirmPhrase(e.target.value)}
                placeholder="ISSUE PRODUCTION"
                className="input-dark mt-1.5 font-mono text-xs"
              />
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2.5 border-t border-surface-800 pt-4">
            <button
              type="button"
              disabled={submitting}
              onClick={() => setReviewing(false)}
              className="btn-secondary text-xs"
            >
              Back to Edit
            </button>
            <button
              type="button"
              disabled={submitting || !confirmChecked || !prodPhraseSatisfied}
              onClick={handleConfirmAndIssue}
              className="btn-primary text-xs"
            >
              {submitting ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Issuing via Rust Core...
                </>
              ) : (
                <>
                  <KeyRound className="h-3.5 w-3.5" />
                  Confirm & Issue License
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* One-Time Key Handoff Modal */}
      {outcome?.outcome === "created" &&
        outcome.license &&
        outcome.one_time_license_key && (
          <OneTimeKeyModal
            client={client}
            environment={environment}
            license={outcome.license}
            oneTimeKey={outcome.one_time_license_key}
            auditEventVerified={outcome.audit_event_verified}
            onDismissed={(openDetails) => {
              const createdLicense = outcome.license!;
              // Immediately wipe volatile key from React state
              handleStartNewDraft();
              if (openDetails) {
                onOpenLicenseDetails(createdLicense);
              }
            }}
          />
        )}

      {/* Success Toast Placeholder if needed */}
      {outcome?.outcome === "created" && !outcome.one_time_license_key && (
        <div className="panel flex items-center gap-2 p-4 text-xs text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          License created and one-time key dismissed.
        </div>
      )}
    </div>
  );
};
