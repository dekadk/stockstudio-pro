import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Calendar,
  CalendarPlus,
  CheckCircle2,
  Cpu,
  Edit3,
  Laptop,
  PauseCircle,
  PlayCircle,
  PowerOff,
  RefreshCw,
  Shield,
  ShieldOff,
  User,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import {
  EditLicenseModal,
  ReasonActionModal,
  RenewSubscriptionModal,
} from "../components/AdminActionModals";
import {
  ForceDeactivateDeviceModal,
  RevokeLicenseModal,
} from "../components/LifecycleModals";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "../components/StateViews";
import { ProductChip, StatusBadge } from "../components/StatusBadge";
import type {
  ActivationSummary,
  AdminLicenseDetailResponse,
  AuditEventItem,
  Environment,
  LicenseSummary,
} from "../types/api";
import { formatDateTime } from "../utils/format";

interface LicenseDetailsPageProps {
  client: AdminBackendClient;
  environment: Environment;
  initialLicense: LicenseSummary;
  canReadEvents: boolean;
  canRevoke: boolean;
  canDeactivateDevice: boolean;
  canUpdateLicense: boolean;
  canSuspend: boolean;
  canReinstate: boolean;
  canRenew: boolean;
  onBack: () => void;
}

function parseEventMetadata(ev: AuditEventItem): Record<string, unknown> {
  if (ev.metadata && Object.keys(ev.metadata).length > 0) {
    return ev.metadata;
  }
  if (ev.metadata_json) {
    try {
      const parsed = JSON.parse(ev.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export const LicenseDetailsPage: React.FC<LicenseDetailsPageProps> = ({
  client,
  environment,
  initialLicense,
  canReadEvents,
  canRevoke,
  canDeactivateDevice,
  canUpdateLicense,
  canSuspend,
  canReinstate,
  canRenew,
  onBack,
}) => {
  const [detail, setDetail] = useState<AdminLicenseDetailResponse | null>(null);
  const [events, setEvents] = useState<AuditEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showSuspendModal, setShowSuspendModal] = useState(false);
  const [showReinstateModal, setShowReinstateModal] = useState(false);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [selectedActivation, setSelectedActivation] =
    useState<ActivationSummary | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationFeedback, setMutationFeedback] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detailRes, eventsRes] = await Promise.all([
        client.fetchLicenseDetails(initialLicense.license_id),
        canReadEvents
          ? client
              .fetchEvents({ license_id: initialLicense.license_id, limit: 25 })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      setDetail(detailRes);
      setEvents(eventsRes?.items ?? detailRes.events ?? []);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [client, initialLicense.license_id, canReadEvents]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const lic = detail?.license ?? initialLicense;

  const runMutation = async (
    fn: () => Promise<{
      outcome: string;
      detail: AdminLicenseDetailResponse | null;
      message: string | null;
      audit_event_verified: boolean;
    }>,
    onSuccessClose: () => void,
    fallbackMsg: string
  ) => {
    setMutationBusy(true);
    setMutationError(null);
    setMutationFeedback(null);
    try {
      const res = await fn();
      if (res.outcome === "completed") {
        if (res.detail) setDetail(res.detail);
        await loadDetail();
        onSuccessClose();
        setMutationFeedback(
          `${res.message || fallbackMsg} ${
            res.audit_event_verified ? "(Audit event verified)" : ""
          }`.trim()
        );
      } else {
        setMutationError(res.message || "Operation did not complete cleanly.");
      }
    } catch (err) {
      setMutationError(normalizeError(err));
    } finally {
      setMutationBusy(false);
    }
  };

  const handleConfirmRevoke = async (confirmPrefix: string, reason: string) => {
    await runMutation(
      () =>
        client.revokeLicense({
          expected_environment: environment,
          license_id: lic.license_id,
          expected_key_prefix: lic.key_prefix,
          confirm_key_prefix: confirmPrefix,
          reason,
        }),
      () => setShowRevokeModal(false),
      "License revoked."
    );
  };

  const handleConfirmForceDeactivate = async (
    confirmPrefix: string,
    reason: string
  ) => {
    if (!selectedActivation) return;
    await runMutation(
      () =>
        client.forceDeactivateDevice({
          expected_environment: environment,
          license_id: lic.license_id,
          activation_id: selectedActivation.activation_id,
          expected_key_prefix: lic.key_prefix,
          confirm_key_prefix: confirmPrefix,
          reason,
        }),
      () => setSelectedActivation(null),
      "Device force-deactivated."
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="btn-secondary px-2.5 py-2 text-xs"
          >
            <ArrowLeft className="h-4 w-4" />
            Registry
          </button>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-heading text-xl font-bold text-white">
                {lic.key_prefix}
              </h1>
              <StatusBadge status={lic.status} />
            </div>
            <p className="mt-0.5 font-mono text-xs text-slate-400">
              {lic.license_id}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canUpdateLicense && lic.status !== "revoked" && (
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setMutationError(null);
                setShowEditModal(true);
              }}
              className="btn-secondary text-xs"
            >
              <Edit3 className="h-3.5 w-3.5 text-brand-orange" />
              Edit License
            </button>
          )}
          {canRenew &&
            lic.license_type === "subscription" &&
            lic.status !== "revoked" && (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setMutationError(null);
                  setShowRenewModal(true);
                }}
                className="btn-secondary text-xs"
              >
                <CalendarPlus className="h-3.5 w-3.5 text-brand-orange" />
                Renew
              </button>
            )}
          {canSuspend &&
            lic.status !== "revoked" &&
            lic.status !== "suspended" && (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setMutationError(null);
                  setShowSuspendModal(true);
                }}
                className="btn-secondary text-xs"
              >
                <PauseCircle className="h-3.5 w-3.5 text-amber-400" />
                Suspend
              </button>
            )}
          {canReinstate && lic.status === "suspended" && (
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setMutationError(null);
                setShowReinstateModal(true);
              }}
              className="btn-primary text-xs"
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Reinstate
            </button>
          )}
          {canRevoke && lic.status !== "revoked" && (
            <button
              type="button"
              disabled={loading}
              title="Permanently revoke this license"
              onClick={() => {
                setMutationError(null);
                setShowRevokeModal(true);
              }}
              className="btn-danger-subtle text-xs"
            >
              <ShieldOff className="h-3.5 w-3.5" />
              Revoke License
            </button>
          )}
          <button
            type="button"
            onClick={loadDetail}
            disabled={loading}
            className="btn-secondary text-xs"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh Details
          </button>
        </div>
      </div>

      {mutationFeedback && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-xl border border-emerald-500/40 bg-emerald-950/30 px-4 py-3 text-xs text-emerald-200"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>{mutationFeedback}</span>
        </div>
      )}

      {error && (
        <ErrorPanel
          title="Could not refresh full license details"
          message={error}
          onRetry={loadDetail}
        />
      )}

      {loading && !detail && (
        <LoadingPanel label="Loading license details and event history..." />
      )}

      {/* Metadata & Customer Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Shield className="h-4 w-4 text-brand-orange" />
            <h2 className="font-heading">License Metadata</h2>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div>
              <dt className="text-slate-400">Plan Name</dt>
              <dd className="mt-0.5 font-medium text-slate-100">
                {lic.plan_name}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Plan Code</dt>
              <dd className="mt-0.5 font-mono text-slate-200">
                {lic.plan_code}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">License Type</dt>
              <dd className="mt-0.5 capitalize text-slate-200">
                {lic.license_type}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Billing Interval</dt>
              <dd className="mt-0.5 capitalize text-slate-200">
                {lic.billing_interval}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Created At</dt>
              <dd className="mt-0.5 text-slate-200">
                {formatDateTime(lic.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Updated At</dt>
              <dd className="mt-0.5 text-slate-200">
                {formatDateTime(lic.updated_at)}
              </dd>
            </div>
            {lic.notes && (
              <div className="col-span-2">
                <dt className="text-slate-400">Admin Notes</dt>
                <dd className="mt-1 rounded-lg border border-surface-700 bg-surface-950 p-2.5 text-slate-200">
                  {lic.notes}
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section className="panel p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <User className="h-4 w-4 text-brand-orange" />
            <h2 className="font-heading">Customer Information</h2>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div>
              <dt className="text-slate-400">Customer Name</dt>
              <dd className="mt-0.5 font-medium text-slate-100">
                {lic.customer_name || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Customer Email</dt>
              <dd className="mt-0.5 font-mono text-slate-200">
                {lic.customer_email || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">External Customer ID</dt>
              <dd className="mt-0.5 font-mono text-slate-200">
                {lic.external_customer_id || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">External Order ID</dt>
              <dd className="mt-0.5 font-mono text-slate-200">
                {lic.external_order_id || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Issued At</dt>
              <dd className="mt-0.5 text-slate-200">
                {formatDateTime(lic.issued_at)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">First Activated</dt>
              <dd className="mt-0.5 text-slate-200">
                {formatDateTime(lic.activated_at)}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {/* Entitlements & Expiration / Subscription */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Cpu className="h-4 w-4 text-brand-orange" />
            <h2 className="font-heading">Entitlements</h2>
          </div>
          <div className="mt-4 space-y-3 text-xs">
            <div>
              <p className="text-slate-400">Entitled Products</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {lic.entitlements.products.length > 0 ? (
                  lic.entitlements.products.map((p) => (
                    <ProductChip key={p} product={p} />
                  ))
                ) : (
                  <span className="text-slate-500">None</span>
                )}
              </div>
            </div>
            <div>
              <p className="text-slate-400">Features</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {lic.entitlements.features.length > 0 ? (
                  lic.entitlements.features.map((f) => (
                    <span
                      key={f}
                      className="rounded border border-surface-600 bg-surface-950 px-2 py-0.5 font-mono text-[11px] text-slate-300"
                    >
                      {f}
                    </span>
                  ))
                ) : (
                  <span className="text-slate-500">Standard feature set</span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 pt-1">
              <div>
                <p className="text-slate-400">Max Accounts</p>
                <p className="mt-0.5 font-mono text-slate-200">
                  {lic.entitlements.max_accounts ?? "Unlimited"}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Updates Until</p>
                <p className="mt-0.5 text-slate-200">
                  {lic.entitlements.updates_until
                    ? formatDateTime(lic.entitlements.updates_until)
                    : "Lifetime"}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Max App Version</p>
                <p className="mt-0.5 font-mono text-slate-200">
                  {lic.entitlements.max_app_version ?? "Unrestricted"}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="panel p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Calendar className="h-4 w-4 text-brand-orange" />
            <h2 className="font-heading">Expiration & Subscription Details</h2>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div>
              <dt className="text-slate-400">Lifetime License</dt>
              <dd className="mt-0.5 font-semibold text-slate-100">
                {lic.lifetime ? "Yes (Never Expires)" : "No"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Expires At</dt>
              <dd className="mt-0.5 text-slate-200">
                {lic.expires_at ? formatDateTime(lic.expires_at) : "Never"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Current Period Start</dt>
              <dd className="mt-0.5 text-slate-200">
                {formatDateTime(lic.current_period_start)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Current Period End</dt>
              <dd className="mt-0.5 text-slate-200">
                {formatDateTime(lic.current_period_end)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Grace Until</dt>
              <dd className="mt-0.5 text-slate-200">
                {formatDateTime(lic.grace_until)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Billing Provider</dt>
              <dd className="mt-0.5 text-slate-200">
                {detail?.billing_subscription?.provider || "Direct / Manual"}
              </dd>
            </div>
            {lic.revoked_at && (
              <div className="col-span-2 rounded-lg border border-rose-500/35 bg-rose-950/25 p-2.5 text-rose-200">
                Revoked at {formatDateTime(lic.revoked_at)}
                {lic.revocation_reason ? ` — ${lic.revocation_reason}` : ""}
              </div>
            )}
          </dl>
        </section>
      </div>

      {/* Device Management & Individual Force Deactivation */}
      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Laptop className="h-4 w-4 text-brand-orange" />
            <h2 className="font-heading">Device Management</h2>
          </div>
          <span className="font-mono text-xs font-semibold text-brand-orange">
            {lic.devices_used} / {lic.device_limit} active slots
          </span>
        </div>

        {detail && detail.activations.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-surface-700 text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Device / Activation</th>
                  <th className="pb-2 pr-4">Products</th>
                  <th className="pb-2 pr-4">Activated</th>
                  <th className="pb-2 pr-4">Last Seen</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {detail.activations.map((act) => (
                  <tr key={act.activation_id}>
                    <td className="py-2.5 pr-4">
                      <div className="font-medium text-slate-100">
                        {act.device_name || act.device_id}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400">
                        {act.activation_id}
                        {act.app_version ? ` · v${act.app_version}` : ""}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {lic.entitlements.products.map((p) => (
                          <ProductChip key={p} product={p} />
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-slate-300">
                      {formatDateTime(act.activated_at)}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-400">
                      {formatDateTime(act.last_validated_at)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusBadge status={act.status} />
                    </td>
                    <td className="py-2.5 text-right">
                      {act.status === "active" && canDeactivateDevice ? (
                        <button
                          type="button"
                          disabled={loading}
                          title={`Force deactivate ${act.device_name || act.activation_id}`}
                          aria-label={`Force Deactivate ${act.device_name || act.activation_id}`}
                          onClick={() => {
                            setMutationError(null);
                            setSelectedActivation(act);
                          }}
                          className="btn-secondary px-2.5 py-1 text-[11px]"
                        >
                          <PowerOff className="h-3 w-3 text-brand-orange" />
                          Force Deactivate
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-500">
                          {act.deactivation_reason || "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-400">
            No device activations recorded for this license.
          </p>
        )}
      </section>

      {/* Per-License Audit Events */}
      <section className="panel p-5">
        <h2 className="font-heading text-sm font-semibold text-white">
          License Events
        </h2>
        {events.length === 0 ? (
          <div className="mt-3">
            <EmptyPanel
              title="No events recorded"
              description="No audit events were returned for this license."
            />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-surface-700 text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Timestamp</th>
                  <th className="pb-2 pr-4">Event</th>
                  <th className="pb-2 pr-4">Actor</th>
                  <th className="pb-2 pr-4">Reason / Result</th>
                  <th className="pb-2">Env</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {events.map((ev) => {
                  const meta = parseEventMetadata(ev);
                  const semanticEvent =
                    typeof meta.action === "string"
                      ? `${ev.event_type} (${meta.action})`
                      : ev.event_type;
                  const reasonText =
                    typeof meta.reason === "string" ? meta.reason : "—";
                  const resultText =
                    typeof meta.result === "string"
                      ? meta.result
                      : ev.new_status || "—";
                  const envText =
                    typeof meta.environment === "string"
                      ? meta.environment
                      : "—";
                  return (
                    <tr key={ev.id}>
                      <td className="py-2.5 pr-4 text-slate-300">
                        {formatDateTime(ev.created_at)}
                      </td>
                      <td className="py-2.5 pr-4 font-mono font-medium text-brand-orange">
                        {semanticEvent}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-300">
                        {ev.actor_type}
                        {ev.actor_id ? ` (${ev.actor_id})` : ""}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-300">
                        <span>{reasonText}</span>
                        <span className="ml-1.5 font-mono text-[11px] text-slate-500">
                          [{resultText}]
                        </span>
                      </td>
                      <td className="py-2.5 font-mono text-[11px] uppercase text-slate-400">
                        {envText}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showRevokeModal && (
        <RevokeLicenseModal
          environment={environment}
          license={lic}
          busy={mutationBusy}
          error={mutationError}
          onCancel={() => setShowRevokeModal(false)}
          onConfirm={handleConfirmRevoke}
        />
      )}

      {selectedActivation && (
        <ForceDeactivateDeviceModal
          environment={environment}
          license={lic}
          activation={selectedActivation}
          busy={mutationBusy}
          error={mutationError}
          onCancel={() => setSelectedActivation(null)}
          onConfirm={handleConfirmForceDeactivate}
        />
      )}

      {showEditModal && (
        <EditLicenseModal
          environment={environment}
          license={lic}
          busy={mutationBusy}
          error={mutationError}
          onCancel={() => setShowEditModal(false)}
          onConfirm={(payload) =>
            runMutation(
              () =>
                client.updateLicense({
                  expected_environment: environment,
                  license_id: lic.license_id,
                  payload,
                }),
              () => setShowEditModal(false),
              "License updated."
            )
          }
        />
      )}

      {showSuspendModal && (
        <ReasonActionModal
          mode="suspend"
          environment={environment}
          license={lic}
          busy={mutationBusy}
          error={mutationError}
          onCancel={() => setShowSuspendModal(false)}
          onConfirm={(reason) =>
            runMutation(
              () =>
                client.suspendLicense({
                  expected_environment: environment,
                  license_id: lic.license_id,
                  reason,
                }),
              () => setShowSuspendModal(false),
              "License suspended."
            )
          }
        />
      )}

      {showReinstateModal && (
        <ReasonActionModal
          mode="reinstate"
          environment={environment}
          license={lic}
          busy={mutationBusy}
          error={mutationError}
          onCancel={() => setShowReinstateModal(false)}
          onConfirm={(reason) =>
            runMutation(
              () =>
                client.reinstateLicense({
                  expected_environment: environment,
                  license_id: lic.license_id,
                  reason,
                }),
              () => setShowReinstateModal(false),
              "License reinstated."
            )
          }
        />
      )}

      {showRenewModal && (
        <RenewSubscriptionModal
          environment={environment}
          license={lic}
          busy={mutationBusy}
          error={mutationError}
          onCancel={() => setShowRenewModal(false)}
          onConfirm={(payload) =>
            runMutation(
              () =>
                client.renewSubscription({
                  expected_environment: environment,
                  license_id: lic.license_id,
                  payload,
                }),
              () => setShowRenewModal(false),
              "Subscription renewed."
            )
          }
        />
      )}
    </div>
  );
};
