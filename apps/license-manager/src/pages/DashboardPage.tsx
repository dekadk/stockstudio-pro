import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertOctagon,
  CalendarClock,
  CheckCircle2,
  Clock,
  KeyRound,
  Laptop,
  RefreshCw,
  Repeat,
  ShieldOff,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "../components/StateViews";
import type { AdminStatsResponse } from "../types/api";
import { formatDateTime } from "../utils/format";

interface DashboardPageProps {
  client: AdminBackendClient;
  onOpenRegistry: () => void;
}

interface MetricCardProps {
  label: string;
  value: number;
  sublabel?: string;
  icon: React.ReactNode;
  accent?: "orange" | "emerald" | "sky" | "rose" | "slate";
}

const ACCENT_MAP: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  orange: "text-brand-orange bg-brand-orange/12 border-brand-orange/30",
  emerald: "text-emerald-300 bg-emerald-500/12 border-emerald-500/30",
  sky: "text-sky-300 bg-sky-500/12 border-sky-500/30",
  rose: "text-rose-300 bg-rose-500/12 border-rose-500/30",
  slate: "text-slate-300 bg-surface-800 border-surface-600",
};

const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  sublabel,
  icon,
  accent = "slate",
}) => (
  <div className="panel p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </p>
        <p className="font-heading mt-2 text-2xl font-bold text-white">
          {value.toLocaleString()}
        </p>
        {sublabel && (
          <p className="mt-1 text-[11px] text-slate-400">{sublabel}</p>
        )}
      </div>
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${ACCENT_MAP[accent]}`}
      >
        {icon}
      </div>
    </div>
  </div>
);

export const DashboardPage: React.FC<DashboardPageProps> = ({
  client,
  onOpenRegistry,
}) => {
  const [data, setData] = useState<AdminStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.fetchDashboardStats();
      setData(res);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  if (loading && !data) {
    return <LoadingPanel label="Loading live statistics from /v1/admin/stats..." />;
  }

  if (error) {
    return (
      <ErrorPanel
        title="Failed to load dashboard statistics"
        message={error}
        onRetry={loadStats}
      />
    );
  }

  if (!data || data.stats.total_licenses === 0) {
    return (
      <EmptyPanel
        title="No licenses recorded yet"
        description="The connected environment currently has zero licenses in D1. Once licenses are issued, live status, subscription, and activation metrics will appear here."
        action={
          <button
            type="button"
            onClick={loadStats}
            className="btn-secondary text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh Statistics
          </button>
        }
      />
    );
  }

  const { stats } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">
            Dashboard
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Real-time aggregate metrics from D1 · Signing Key{" "}
            <code className="font-mono text-slate-300">{data.signing_kid}</code>{" "}
            · Updated {formatDateTime(data.server_time)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenRegistry}
            className="btn-primary text-xs"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Browse Registry
          </button>
          <button
            type="button"
            onClick={loadStats}
            disabled={loading}
            className="btn-secondary text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Primary KPI Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total Licenses"
          value={stats.total_licenses}
          sublabel={`${stats.issued_last_30d} issued in last 30 days`}
          icon={<KeyRound className="h-4 w-4" />}
          accent="orange"
        />
        <MetricCard
          label="Active Licenses"
          value={stats.by_status.active}
          sublabel="Currently valid & activated"
          icon={<CheckCircle2 className="h-4 w-4" />}
          accent="emerald"
        />
        <MetricCard
          label="Pending Activation"
          value={stats.by_status.pending_activation}
          sublabel="Issued, awaiting first device"
          icon={<Clock className="h-4 w-4" />}
          accent="sky"
        />
        <MetricCard
          label="Active Device Activations"
          value={stats.active_device_activations}
          sublabel="Live bound installations"
          icon={<Laptop className="h-4 w-4" />}
          accent="orange"
        />
      </div>

      {/* Risk & Lifecycle Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Suspended"
          value={stats.by_status.suspended}
          sublabel="Temporarily paused"
          icon={<AlertOctagon className="h-4 w-4" />}
          accent="orange"
        />
        <MetricCard
          label="Revoked"
          value={stats.by_status.revoked}
          sublabel="Permanently terminated"
          icon={<ShieldOff className="h-4 w-4" />}
          accent="rose"
        />
        <MetricCard
          label="Expired"
          value={stats.by_status.expired}
          sublabel={`${stats.by_status.past_due} past due`}
          icon={<CalendarClock className="h-4 w-4" />}
          accent="slate"
        />
        <MetricCard
          label="Expiring Within 7d"
          value={stats.expiring_within_7d}
          sublabel="Active subscriptions nearing end"
          icon={<Activity className="h-4 w-4" />}
          accent="sky"
        />
      </div>

      {/* Plan & Billing Breakdown */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="panel p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-sm font-semibold text-white">
              Subscription Billing Intervals
            </h2>
            <Repeat className="h-4 w-4 text-brand-orange" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-surface-700 bg-surface-950 p-3.5">
              <p className="text-[11px] uppercase tracking-wider text-slate-400">
                Monthly Subscriptions
              </p>
              <p className="font-heading mt-1.5 text-xl font-bold text-white">
                {stats.by_billing_interval.monthly}
              </p>
            </div>
            <div className="rounded-lg border border-surface-700 bg-surface-950 p-3.5">
              <p className="text-[11px] uppercase tracking-wider text-slate-400">
                Yearly Subscriptions
              </p>
              <p className="font-heading mt-1.5 text-xl font-bold text-white">
                {stats.by_billing_interval.yearly}
              </p>
            </div>
            <div className="rounded-lg border border-surface-700 bg-surface-950 p-3.5">
              <p className="text-[11px] uppercase tracking-wider text-slate-400">
                Lifetime / Perpetual
              </p>
              <p className="font-heading mt-1.5 text-xl font-bold text-brand-orange">
                {stats.by_billing_interval.lifetime}
              </p>
            </div>
          </div>
        </div>

        <div className="panel p-5">
          <h2 className="font-heading text-sm font-semibold text-white">
            License Type Distribution
          </h2>
          <div className="mt-4 space-y-3">
            {[
              {
                label: "Perpetual Licenses",
                count: stats.by_license_type.perpetual,
                barClass: "bg-brand-orange",
              },
              {
                label: "Subscription Licenses",
                count: stats.by_license_type.subscription,
                barClass: "bg-sky-400",
              },
            ].map((row) => {
              const pct =
                stats.total_licenses > 0
                  ? Math.round((row.count / stats.total_licenses) * 100)
                  : 0;
              return (
                <div key={row.label}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">{row.label}</span>
                    <span className="font-mono font-semibold text-white">
                      {row.count} ({pct}%)
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-800">
                    <div
                      className={`h-full rounded-full ${row.barClass}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
