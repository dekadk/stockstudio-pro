import React from "react";
import {
  Activity,
  KeyRound,
  LayoutDashboard,
  Lock,
  PlusCircle,
  ShieldCheck,
  Clock,
  Wrench,
} from "lucide-react";
import type { SessionStatus } from "../types/api";
import { formatCountdown, hasPermission } from "../utils/format";
import { EnvironmentBadge } from "./StatusBadge";

export type NavRoute =
  | "dashboard"
  | "registry"
  | "issue"
  | "details"
  | "tools"
  | "events"
  | "security";

interface SidebarProps {
  activeRoute: NavRoute;
  onNavigate: (route: NavRoute) => void;
  session: SessionStatus;
  onLockNow: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeRoute,
  onNavigate,
  session,
  onLockNow,
}) => {
  const admin = session.admin_me?.admin ?? null;
  const canReadEvents = hasPermission(admin, "events:read");
  const canCreateLicense = hasPermission(admin, "licenses:create");

  const navItems: Array<{
    id: NavRoute;
    label: string;
    icon: React.ReactNode;
    allowed: boolean;
  }> = [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: <LayoutDashboard className="h-4 w-4" />,
      allowed: hasPermission(admin, "stats:read"),
    },
    {
      id: "registry",
      label: "License Registry",
      icon: <KeyRound className="h-4 w-4" />,
      allowed: hasPermission(admin, "licenses:read"),
    },
    {
      id: "issue",
      label: "Issue License",
      icon: <PlusCircle className="h-4 w-4" />,
      allowed: canCreateLicense,
    },
    {
      id: "tools",
      label: "Tool Links",
      icon: <Wrench className="h-4 w-4" />,
      allowed: true,
    },
    {
      id: "events",
      label: "Events & Activity",
      icon: <Activity className="h-4 w-4" />,
      allowed: canReadEvents,
    },
    {
      id: "security",
      label: "Admin & Security",
      icon: <ShieldCheck className="h-4 w-4" />,
      allowed: true,
    },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-surface-700 bg-surface-900 px-3.5 py-5">
      <div className="px-2">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-orange text-sm font-black text-surface-950">
            SS
          </div>
          <div>
            <p className="font-heading text-sm font-bold tracking-tight text-white">
              StockStudio Pro
            </p>
            <p className="text-[11px] font-medium uppercase tracking-widest text-slate-400">
              License Manager
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-lg border border-surface-700 bg-surface-950/80 px-2.5 py-2">
          <EnvironmentBadge environment={session.environment} />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {canCreateLicense ? "Admin" : "Read-Only"}
          </span>
        </div>
      </div>

      <nav className="mt-6 flex-1 space-y-1" aria-label="Main navigation">
        {navItems.map((item) => {
          const isActive =
            activeRoute === item.id ||
            (activeRoute === "details" && item.id === "registry");
          return (
            <button
              key={item.id}
              type="button"
              disabled={!item.allowed}
              onClick={() => onNavigate(item.id)}
              title={
                item.allowed
                  ? item.label
                  : "Your admin role does not have permission to view this section."
              }
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition ${
                isActive
                  ? "bg-brand-orange/15 text-brand-orange ring-1 ring-brand-orange/35"
                  : item.allowed
                  ? "text-slate-300 hover:bg-surface-800 hover:text-white"
                  : "cursor-not-allowed text-slate-600"
              }`}
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {!item.allowed && (
                <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
                  RBAC
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3 border-t border-surface-700 pt-4">
        <div className="rounded-lg border border-surface-700 bg-surface-950/70 p-3">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-brand-orange" />
              Idle Auto-Lock
            </span>
            <span className="font-mono font-semibold text-slate-200">
              {formatCountdown(session.idle_remaining_secs)}
            </span>
          </div>
          {admin && (
            <div className="mt-2.5 border-t border-surface-800 pt-2">
              <p className="truncate text-xs font-semibold text-slate-100">
                {admin.name}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                {admin.role} · {admin.key_prefix}
              </p>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onLockNow}
          className="btn-secondary w-full justify-center text-xs"
        >
          <Lock className="h-3.5 w-3.5 text-brand-orange" />
          Lock Session Now
        </button>
      </div>
    </aside>
  );
};
