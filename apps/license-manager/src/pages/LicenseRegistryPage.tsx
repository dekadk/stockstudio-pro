import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "../components/StateViews";
import { ProductChip, StatusBadge } from "../components/StatusBadge";
import type { AdminLicensesResponse, LicenseSummary } from "../types/api";
import { formatShortDate } from "../utils/format";

interface LicenseRegistryPageProps {
  client: AdminBackendClient;
  onSelectLicense: (license: LicenseSummary) => void;
}

export const LicenseRegistryPage: React.FC<LicenseRegistryPageProps> = ({
  client,
  onSelectLicense,
}) => {
  const [searchInput, setSearchInput] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState("");
  const [licenseType, setLicenseType] = useState("");
  const [planCode, setPlanCode] = useState("");
  const [product, setProduct] = useState("");
  const [sort, setSort] = useState<"created_desc" | "created_asc">(
    "created_desc"
  );
  const [limit, setLimit] = useState(25);

  // Keyset cursor stack for deterministic Previous / Next navigation
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1];

  const [data, setData] = useState<AdminLicensesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLicenses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.fetchLicenses({
        limit,
        cursor: currentCursor ?? undefined,
        sort,
        status: status || undefined,
        license_type: licenseType || undefined,
        plan_code: planCode.trim() || undefined,
        product: product || undefined,
        q: appliedQuery || undefined,
      });
      setData(res);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [
    client,
    limit,
    currentCursor,
    sort,
    status,
    licenseType,
    planCode,
    product,
    appliedQuery,
  ]);

  useEffect(() => {
    void loadLicenses();
  }, [loadLicenses]);

  const resetPagination = () => setCursorStack([null]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    resetPagination();
    setAppliedQuery(searchInput.trim());
  };

  const handleClearFilters = () => {
    setSearchInput("");
    setAppliedQuery("");
    setStatus("");
    setLicenseType("");
    setPlanCode("");
    setProduct("");
    setSort("created_desc");
    resetPagination();
  };

  const handleNextPage = () => {
    if (data?.pagination.has_more && data.pagination.next_cursor) {
      setCursorStack((prev) => [...prev, data.pagination.next_cursor]);
    }
  };

  const handlePrevPage = () => {
    if (cursorStack.length > 1) {
      setCursorStack((prev) => prev.slice(0, -1));
    }
  };

  const hasActiveFilters = Boolean(
    appliedQuery || status || licenseType || planCode.trim() || product
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">
            License Registry
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Keyset-paginated directory from{" "}
            <code className="font-mono text-slate-300">
              GET /v1/admin/licenses
            </code>{" "}
            · Raw license keys and key hashes are never exposed.
          </p>
        </div>
        <button
          type="button"
          onClick={loadLicenses}
          disabled={loading}
          className="btn-secondary text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Search & Filters Toolbar */}
      <div className="panel space-y-3 p-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-wrap gap-2.5">
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              aria-label="Search licenses"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by license ID, key prefix (SSPRO-...), email, name, or order ID"
              className="input-dark pl-9"
            />
          </div>
          <button type="submit" className="btn-primary text-xs">
            Search
          </button>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="btn-secondary text-xs"
            >
              Reset Filters
            </button>
          )}
        </form>

        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters:
          </span>

          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              resetPagination();
              setStatus(e.target.value);
            }}
            className="input-dark w-auto py-1.5 text-xs"
          >
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="pending_activation">Pending Activation</option>
            <option value="past_due">Past Due</option>
            <option value="expired">Expired</option>
            <option value="suspended">Suspended</option>
            <option value="revoked">Revoked</option>
          </select>

          <select
            aria-label="Filter by license type"
            value={licenseType}
            onChange={(e) => {
              resetPagination();
              setLicenseType(e.target.value);
            }}
            className="input-dark w-auto py-1.5 text-xs"
          >
            <option value="">All Types</option>
            <option value="perpetual">Perpetual</option>
            <option value="subscription">Subscription</option>
          </select>

          <select
            aria-label="Filter by product"
            value={product}
            onChange={(e) => {
              resetPagination();
              setProduct(e.target.value);
            }}
            className="input-dark w-auto py-1.5 text-xs"
          >
            <option value="">All Products</option>
            <option value="desktop">Desktop</option>
            <option value="vectorizer_extension">Vectorizer Extension</option>
          </select>

          <input
            type="text"
            aria-label="Filter by plan code"
            value={planCode}
            onChange={(e) => {
              resetPagination();
              setPlanCode(e.target.value);
            }}
            placeholder="Plan code (e.g. lifetime)"
            className="input-dark w-40 py-1.5 text-xs"
          />

          <select
            aria-label="Sort order"
            value={sort}
            onChange={(e) => {
              resetPagination();
              setSort(e.target.value as "created_desc" | "created_asc");
            }}
            className="input-dark ml-auto w-auto py-1.5 text-xs"
          >
            <option value="created_desc">Newest First</option>
            <option value="created_asc">Oldest First</option>
          </select>

          <select
            aria-label="Page size"
            value={limit}
            onChange={(e) => {
              resetPagination();
              setLimit(Number(e.target.value));
            }}
            className="input-dark w-auto py-1.5 text-xs"
          >
            <option value={10}>10 / page</option>
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
          </select>
        </div>
      </div>

      {loading && !data && (
        <LoadingPanel label="Fetching license registry..." />
      )}

      {error && (
        <ErrorPanel
          title="Failed to load license registry"
          message={error}
          onRetry={loadLicenses}
        />
      )}

      {!error && data && data.items.length === 0 && (
        <EmptyPanel
          title="No matching licenses"
          description={
            hasActiveFilters
              ? "No licenses matched the current search and filter criteria."
              : "No licenses exist in this environment yet."
          }
          action={
            hasActiveFilters ? (
              <button
                type="button"
                onClick={handleClearFilters}
                className="btn-secondary text-xs"
              >
                Clear All Filters
              </button>
            ) : undefined
          }
        />
      )}

      {!error && data && data.items.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-surface-700 bg-surface-950/70 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">License ID / Prefix</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Plan & Products</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Devices</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {data.items.map((lic) => (
                  <tr
                    key={lic.license_id}
                    onClick={() => onSelectLicense(lic)}
                    className="cursor-pointer transition hover:bg-surface-800/70"
                  >
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs font-semibold text-white">
                        {lic.key_prefix}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                        {lic.license_id}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-200">
                        {lic.customer_name || "Unnamed Customer"}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {lic.customer_email || "No email recorded"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-200">
                        {lic.plan_name}{" "}
                        <span className="font-mono text-[11px] text-slate-400">
                          ({lic.license_type} · {lic.billing_interval})
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {lic.entitlements.products.map((p) => (
                          <ProductChip key={p} product={p} />
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={lic.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-200">
                      <span
                        className={
                          lic.devices_used >= lic.device_limit
                            ? "font-semibold text-brand-orange"
                            : ""
                        }
                      >
                        {lic.devices_used} / {lic.device_limit}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {formatShortDate(lic.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cursor Pagination Footer */}
          <div className="flex items-center justify-between border-t border-surface-700 bg-surface-950/50 px-4 py-3 text-xs text-slate-400">
            <span>
              Page {cursorStack.length} · Showing {data.items.length} license
              {data.items.length === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={cursorStack.length <= 1 || loading}
                onClick={handlePrevPage}
                className="btn-secondary px-2.5 py-1.5 text-xs"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Previous
              </button>
              <button
                type="button"
                disabled={!data.pagination.has_more || loading}
                onClick={handleNextPage}
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
