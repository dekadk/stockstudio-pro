import React from "react";
import type { Environment } from "../types/api";
import { formatProductLabel } from "../utils/format";

const STATUS_STYLES: Record<string, string> = {
  active: "border-emerald-500/35 bg-emerald-500/15 text-emerald-300",
  pending_activation: "border-sky-500/35 bg-sky-500/15 text-sky-300",
  past_due: "border-amber-500/35 bg-amber-500/15 text-amber-300",
  expired: "border-slate-500/40 bg-slate-500/15 text-slate-300",
  suspended: "border-orange-500/40 bg-orange-500/15 text-orange-300",
  revoked: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  deactivated: "border-slate-600 bg-slate-700/30 text-slate-400",
};

export const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const style =
    STATUS_STYLES[status] ?? "border-slate-600 bg-slate-700/30 text-slate-300";
  const label = status.replace(/_/g, " ");
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${style}`}
    >
      {label}
    </span>
  );
};

export const ProductChip: React.FC<{ product: string }> = ({ product }) => {
  const isExt = product === "vectorizer_extension";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${
        isExt
          ? "border-brand-orange/35 bg-brand-orange/10 text-brand-orange"
          : "border-surface-600 bg-surface-800 text-slate-300"
      }`}
    >
      {formatProductLabel(product)}
    </span>
  );
};

export const EnvironmentBadge: React.FC<{ environment: Environment | string }> = ({
  environment,
}) => {
  const isProd = environment.toLowerCase() === "production";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest ${
        isProd
          ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
          : "border-brand-orange/45 bg-brand-orange/15 text-brand-orange"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isProd ? "bg-rose-400" : "bg-brand-orange"
        }`}
      />
      {isProd ? "PRODUCTION" : "STAGING"}
    </span>
  );
};
