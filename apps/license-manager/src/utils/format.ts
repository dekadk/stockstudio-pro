import type { AdminIdentity } from "../types/api";

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(parsed)) + " UTC";
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

export function formatCountdown(totalSecs: number): string {
  const safe = Math.max(0, Math.floor(totalSecs));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatProductLabel(product: string): string {
  if (product === "desktop") return "Desktop";
  if (product === "vectorizer_extension") return "Vectorizer Ext";
  return product;
}

export function hasPermission(
  admin: AdminIdentity | null | undefined,
  permission: string
): boolean {
  if (!admin) return false;
  return admin.permissions.includes(permission);
}
