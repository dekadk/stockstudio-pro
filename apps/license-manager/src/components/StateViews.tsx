import React from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";

export const LoadingPanel: React.FC<{ label?: string }> = ({
  label = "Loading live data from Admin API...",
}) => (
  <div
    role="status"
    aria-live="polite"
    className="panel flex flex-col items-center justify-center gap-3 px-6 py-16 text-slate-400"
  >
    <RefreshCw className="h-6 w-6 animate-spin text-brand-orange" />
    <p className="text-sm font-medium">{label}</p>
  </div>
);

export const ErrorPanel: React.FC<{
  title?: string;
  message: string;
  onRetry?: () => void;
}> = ({ title = "Unable to load data", message, onRetry }) => (
  <div
    role="alert"
    className="rounded-xl border border-rose-500/35 bg-rose-950/25 p-5 text-rose-200"
  >
    <div className="flex items-start gap-3">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
      <div className="min-w-0 flex-1">
        <h3 className="font-heading text-sm font-semibold text-rose-100">
          {title}
        </h3>
        <p className="mt-1 break-words text-xs leading-relaxed text-rose-200/90">
          {message}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="btn-secondary mt-3 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        )}
      </div>
    </div>
  </div>
);

export const EmptyPanel: React.FC<{
  title: string;
  description: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <div className="panel flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-surface-700 bg-surface-850 text-slate-400">
      <Inbox className="h-5 w-5" />
    </div>
    <h3 className="font-heading mt-1 text-sm font-semibold text-slate-200">
      {title}
    </h3>
    <p className="max-w-md text-xs leading-relaxed text-slate-400">
      {description}
    </p>
    {action && <div className="mt-3">{action}</div>}
  </div>
);
