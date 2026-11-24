import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "../components/StateViews";
import type { AdminEventsResponse } from "../types/api";
import { formatDateTime } from "../utils/format";

interface EventsPageProps {
  client: AdminBackendClient;
  canReadEvents: boolean;
}

const EVENT_TYPE_OPTIONS = [
  "license.issued",
  "license.activated",
  "license.rebound_on_reinstall",
  "license.validated",
  "license.validation_failed",
  "license.device_limit_rejected",
  "license.deactivated",
  "license.expired",
  "license.past_due",
  "license.renewed",
  "license.suspended",
  "license.reinstated",
  "license.revoked",
  "license.updated",
];

export const EventsPage: React.FC<EventsPageProps> = ({
  client,
  canReadEvents,
}) => {
  const [eventType, setEventType] = useState("");
  const [actorType, setActorType] = useState("");
  const [licenseId, setLicenseId] = useState("");
  const [limit, setLimit] = useState(25);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1];

  const [data, setData] = useState<AdminEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    if (!canReadEvents) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await client.fetchEvents({
        limit,
        cursor: currentCursor ?? undefined,
        event_type: eventType || undefined,
        actor_type: actorType || undefined,
        license_id: licenseId.trim() || undefined,
      });
      setData(res);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [client, canReadEvents, limit, currentCursor, eventType, actorType, licenseId]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  if (!canReadEvents) {
    return (
      <div className="panel flex items-start gap-3 p-6 text-amber-200">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-brand-orange" />
        <div>
          <h2 className="font-heading text-base font-semibold text-white">
            Restricted by Role Permissions
          </h2>
          <p className="mt-1 text-xs text-slate-300">
            Your authenticated administrator role does not include{" "}
            <code className="font-mono text-brand-orange">events:read</code>.
            Audit log access is restricted to <code>super_admin</code>,{" "}
            <code>support_admin</code>, and <code>read_only</code> principals.
          </p>
        </div>
      </div>
    );
  }

  const resetPagination = () => setCursorStack([null]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">
            Events & Activity
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Sanitized audit trail from{" "}
            <code className="font-mono text-slate-300">
              GET /v1/admin/events
            </code>{" "}
            · Sensitive metadata keys are redacted server-side.
          </p>
        </div>
        <button
          type="button"
          onClick={loadEvents}
          disabled={loading}
          className="btn-secondary text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="panel flex flex-wrap items-center gap-2.5 p-4">
        <select
          aria-label="Filter by event type"
          value={eventType}
          onChange={(e) => {
            resetPagination();
            setEventType(e.target.value);
          }}
          className="input-dark w-auto py-1.5 text-xs"
        >
          <option value="">All Event Types</option>
          {EVENT_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by actor type"
          value={actorType}
          onChange={(e) => {
            resetPagination();
            setActorType(e.target.value);
          }}
          className="input-dark w-auto py-1.5 text-xs"
        >
          <option value="">All Actors</option>
          <option value="admin">Admin</option>
          <option value="client">Client</option>
          <option value="billing_webhook">Billing Webhook</option>
          <option value="system">System</option>
        </select>

        <input
          type="text"
          aria-label="Filter by license ID"
          value={licenseId}
          onChange={(e) => {
            resetPagination();
            setLicenseId(e.target.value);
          }}
          placeholder="Filter by license_id (optional)"
          className="input-dark w-64 py-1.5 font-mono text-xs"
        />

        <select
          aria-label="Events page size"
          value={limit}
          onChange={(e) => {
            resetPagination();
            setLimit(Number(e.target.value));
          }}
          className="input-dark ml-auto w-auto py-1.5 text-xs"
        >
          <option value={10}>10 / page</option>
          <option value={25}>25 / page</option>
          <option value={50}>50 / page</option>
        </select>
      </div>

      {loading && !data && <LoadingPanel label="Loading audit events..." />}

      {error && (
        <ErrorPanel
          title="Failed to load audit events"
          message={error}
          onRetry={loadEvents}
        />
      )}

      {!error && data && data.items.length === 0 && (
        <EmptyPanel
          title="No events found"
          description="No audit events match the active filters."
        />
      )}

      {!error && data && data.items.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-surface-700 bg-surface-950/70 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">License ID</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Reason / Result</th>
                  <th className="px-4 py-3">Env / IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {data.items.map((ev) => {
                  const meta = ev.metadata || {};
                  const actionLabel =
                    typeof meta.action === "string"
                      ? `${ev.event_type} (${meta.action})`
                      : ev.event_type;
                  const reasonText =
                    typeof meta.reason === "string" ? meta.reason : "";
                  const resultText =
                    typeof meta.result === "string"
                      ? meta.result
                      : ev.new_status || "";
                  const envText =
                    typeof meta.environment === "string"
                      ? meta.environment
                      : "";
                  return (
                    <tr key={ev.id} className="hover:bg-surface-800/50">
                      <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                        {formatDateTime(ev.created_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-brand-orange">
                        {actionLabel}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-slate-300">
                        {ev.license_id || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                        <span>{ev.actor_type}</span>
                        {ev.actor_id && (
                          <span className="ml-1 font-mono text-[11px] text-slate-500">
                            ({ev.actor_id})
                          </span>
                        )}
                      </td>
                      <td className="max-w-xs truncate px-4 py-3 text-slate-300">
                        {reasonText ||
                          (Object.keys(meta).length > 0
                            ? JSON.stringify(meta)
                            : "—")}
                        {resultText && (
                          <span className="ml-1.5 font-mono text-[11px] text-slate-500">
                            [{resultText}]
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-slate-400">
                        {envText ? `${envText.toUpperCase()} · ` : ""}
                        {ev.ip_hash_prefix || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-surface-700 bg-surface-950/50 px-4 py-3 text-xs text-slate-400">
            <span>
              Page {cursorStack.length} · Showing {data.items.length} event
              {data.items.length === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={cursorStack.length <= 1 || loading}
                onClick={() => setCursorStack((prev) => prev.slice(0, -1))}
                className="btn-secondary px-2.5 py-1.5 text-xs"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Previous
              </button>
              <button
                type="button"
                disabled={!data.pagination.has_more || loading}
                onClick={() => {
                  if (data.pagination.next_cursor) {
                    setCursorStack((prev) => [
                      ...prev,
                      data.pagination.next_cursor,
                    ]);
                  }
                }}
                className="btn-secondary px-2.5 py-1.5 text-xs"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
