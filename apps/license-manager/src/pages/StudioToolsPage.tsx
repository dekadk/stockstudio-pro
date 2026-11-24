import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Edit3,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { normalizeError, type AdminBackendClient } from "../api/client";
import { ErrorPanel, LoadingPanel } from "../components/StateViews";
import { EnvironmentBadge } from "../components/StatusBadge";
import type { Environment, StudioToolItem } from "../types/api";

interface StudioToolsPageProps {
  client: AdminBackendClient;
  environment: Environment;
  canEdit: boolean;
  canDelete: boolean;
}

interface ToolFormState {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  badge: string;
  enabled: boolean;
  sort_order: string;
}

const EMPTY_FORM: ToolFormState = {
  id: "",
  name: "",
  category: "Google Flow Tool",
  description: "",
  url: "",
  badge: "FLOW",
  enabled: true,
  sort_order: "50",
};

function inferBadgeFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (
    lower.includes("gemini.google") ||
    lower.includes("aistudio.google.com") ||
    lower.includes("bard.google.com")
  ) {
    return "GEMINI";
  }
  return "FLOW";
}

export const StudioToolsPage: React.FC<StudioToolsPageProps> = ({
  client,
  environment,
  canEdit,
  canDelete,
}) => {
  const [tools, setTools] = useState<StudioToolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadTools = useCallback(async () => {
    if (!client.fetchStudioTools) {
      setError("Studio Tools API is not available in this client.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await client.fetchStudioTools();
      setTools(resp.tools ?? []);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadTools();
  }, [loadTools, environment]);

  const openCreateModal = () => {
    const nextOrder =
      tools.reduce((max, item) => Math.max(max, item.sort_order), 0) + 10;
    setForm({
      ...EMPTY_FORM,
      sort_order: String(nextOrder),
    });
    setEditingToolId(null);
    setFormError(null);
    setModalMode("create");
  };

  const openEditModal = (tool: StudioToolItem) => {
    setForm({
      id: tool.id,
      name: tool.name,
      category: tool.category,
      description: tool.description,
      url: tool.url,
      badge: tool.badge,
      enabled: tool.enabled,
      sort_order: String(tool.sort_order),
    });
    setEditingToolId(tool.id);
    setFormError(null);
    setModalMode("edit");
  };

  const handleToggleEnabled = async (tool: StudioToolItem) => {
    if (!canEdit || !client.updateStudioTool) return;
    setBusyId(tool.id);
    setError(null);
    setNotice(null);
    try {
      const nextEnabled = !tool.enabled;
      const resp = await client.updateStudioTool({
        expected_environment: environment,
        tool_id: tool.id,
        payload: { enabled: nextEnabled },
      });
      if (resp.tool) {
        setTools((prev) =>
          prev.map((item) => (item.id === tool.id ? resp.tool! : item))
        );
      } else {
        await loadTools();
      }
      setNotice(
        `${tool.name} is now ${nextEnabled ? "ON (visible to users)" : "OFF (hidden from users)"}.`
      );
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (tool: StudioToolItem) => {
    if (!canDelete || !client.deleteStudioTool) return;
    const confirmed = window.confirm(
      `Delete "${tool.name}" (${tool.id}) from ${environment.toUpperCase()}? This removes it from all users on next sync.`
    );
    if (!confirmed) return;
    setBusyId(tool.id);
    setError(null);
    setNotice(null);
    try {
      await client.deleteStudioTool({
        expected_environment: environment,
        tool_id: tool.id,
      });
      setTools((prev) => prev.filter((item) => item.id !== tool.id));
      setNotice(`Deleted tool "${tool.name}".`);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedName = form.name.trim();
    const trimmedUrl = form.url.trim();
    if (!trimmedName) {
      setFormError("Tool name is required.");
      return;
    }
    if (!trimmedUrl.startsWith("https://")) {
      setFormError("URL must start with https:// (Google Flow or Gemini link).");
      return;
    }

    const parsedOrder = Number.parseInt(form.sort_order, 10);
    const sortOrder = Number.isFinite(parsedOrder) ? parsedOrder : 50;

    setSubmitting(true);
    try {
      if (modalMode === "create") {
        if (!client.createStudioTool) {
          throw new Error("Create tool command unavailable.");
        }
        await client.createStudioTool({
          expected_environment: environment,
          payload: {
            id: form.id.trim() || undefined,
            name: trimmedName,
            category: form.category.trim() || "Google Flow Tool",
            description: form.description.trim(),
            url: trimmedUrl,
            badge: (form.badge.trim() || inferBadgeFromUrl(trimmedUrl)).toUpperCase(),
            enabled: form.enabled,
            sort_order: sortOrder,
          },
        });
        setNotice(`Added "${trimmedName}" to ${environment.toUpperCase()}.`);
      } else if (modalMode === "edit" && editingToolId) {
        if (!client.updateStudioTool) {
          throw new Error("Update tool command unavailable.");
        }
        await client.updateStudioTool({
          expected_environment: environment,
          tool_id: editingToolId,
          payload: {
            name: trimmedName,
            category: form.category.trim() || "Google Flow Tool",
            description: form.description.trim(),
            url: trimmedUrl,
            badge: (form.badge.trim() || inferBadgeFromUrl(trimmedUrl)).toUpperCase(),
            enabled: form.enabled,
            sort_order: sortOrder,
          },
        });
        setNotice(`Updated "${trimmedName}" in ${environment.toUpperCase()}.`);
      }
      setModalMode(null);
      await loadTools();
    } catch (err) {
      setFormError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && tools.length === 0) {
    return <LoadingPanel label="Loading Studio Tool links..." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Wrench className="h-5 w-5 text-brand-orange" />
            <h1 className="font-heading text-2xl font-bold tracking-tight text-white">
              Studio Tool Links
            </h1>
            <EnvironmentBadge environment={environment} />
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Edit Google Flow &amp; Gemini Canvas tool URLs, add new tools, or toggle
            features ON/OFF without rebuilding the desktop installer.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadTools()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-surface-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-3.5 py-2 text-xs font-bold text-surface-950 transition hover:brightness-110"
            >
              <Plus className="h-4 w-4" />
              Add New Tool
            </button>
          )}
        </div>
      </div>

      {environment === "production" && (
        <div className="flex items-center gap-3 rounded-xl border border-rose-500/40 bg-rose-950/30 px-4 py-3 text-xs text-rose-200">
          <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
          <span>
            <strong>Production Mode:</strong> Saving a URL edit, toggling ON/OFF, or
            adding a tool publishes immediately to all active StockStudio Pro desktop
            users on their next app launch or Sync Tools click.
          </span>
        </div>
      )}

      {notice && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-950/30 px-4 py-3 text-xs text-emerald-200">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-300 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <ErrorPanel
          title="Unable to sync Studio Tools"
          message={error}
          onRetry={loadTools}
        />
      )}

      <div className="grid gap-3">
        {tools.map((tool) => {
          const isBusy = busyId === tool.id;
          return (
            <div
              key={tool.id}
              className={`rounded-xl border p-4 transition ${
                tool.enabled
                  ? "border-surface-700 bg-surface-900"
                  : "border-surface-800 bg-surface-900/50 opacity-75"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-heading text-base font-bold text-white">
                      {tool.name}
                    </h2>
                    <span className="rounded bg-surface-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">
                      {tool.id}
                    </span>
                    <span className="rounded bg-brand-orange/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-orange">
                      {tool.badge}
                    </span>
                    <span className="rounded bg-surface-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                      Order #{tool.sort_order}
                    </span>
                  </div>

                  {tool.description && (
                    <p className="mt-1.5 text-xs text-slate-400">{tool.description}</p>
                  )}

                  <div className="mt-2 flex items-center gap-1.5 font-mono text-xs text-sky-300/90 break-all">
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <span>{tool.url}</span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={!canEdit || isBusy}
                    onClick={() => void handleToggleEnabled(tool)}
                    className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                      tool.enabled
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                        : "border-slate-600 bg-surface-800 text-slate-400 hover:text-slate-200"
                    }`}
                    title={
                      tool.enabled
                        ? "Click to turn OFF (hide from users)"
                        : "Click to turn ON (show to users)"
                    }
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        tool.enabled ? "bg-emerald-400" : "bg-slate-500"
                      }`}
                    />
                    {isBusy ? "Saving..." : tool.enabled ? "ON" : "OFF"}
                  </button>

                  {canEdit && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => openEditModal(tool)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-surface-700 bg-surface-950 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-surface-800 disabled:opacity-50"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      Edit
                    </button>
                  )}

                  {canDelete && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleDelete(tool)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-950/30 px-2.5 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-950/60 disabled:opacity-50"
                      title="Delete tool"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {!loading && tools.length === 0 && (
          <div className="rounded-xl border border-dashed border-surface-700 bg-surface-900/40 p-8 text-center text-sm text-slate-400">
            No studio tools found in {environment.toUpperCase()}. Click{" "}
            <strong>Add New Tool</strong> to create one.
          </div>
        )}
      </div>

      {modalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-surface-700 bg-surface-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="font-heading text-lg font-bold text-white">
                {modalMode === "create" ? "Add New Studio Tool" : "Edit Studio Tool"}
              </h2>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-surface-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitForm} className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    Tool Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Prompt Builder"
                    className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-orange focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    Tool ID {modalMode === "create" ? "(optional slug)" : "(locked)"}
                  </label>
                  <input
                    type="text"
                    disabled={modalMode === "edit"}
                    value={form.id}
                    onChange={(e) => setForm({ ...form, id: e.target.value })}
                    placeholder="auto from name"
                    className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-sm text-white disabled:opacity-50 focus:border-brand-orange focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300">
                  Tool URL (Google Flow / Gemini Canvas HTTPS) *
                </label>
                <input
                  type="url"
                  required
                  value={form.url}
                  onChange={(e) => {
                    const nextUrl = e.target.value;
                    setForm({
                      ...form,
                      url: nextUrl,
                      badge:
                        modalMode === "create"
                          ? inferBadgeFromUrl(nextUrl)
                          : form.badge,
                    });
                  }}
                  placeholder="https://flow.google.com/shared/tool/... or https://share.gemini.google/..."
                  className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-white focus:border-brand-orange focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  placeholder="Short description shown on the Dashboard tool card."
                  className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-orange focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    Category
                  </label>
                  <input
                    type="text"
                    value={form.category}
                    onChange={(e) =>
                      setForm({ ...form, category: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-white focus:border-brand-orange focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    Badge
                  </label>
                  <input
                    type="text"
                    maxLength={16}
                    value={form.badge}
                    onChange={(e) =>
                      setForm({ ...form, badge: e.target.value.toUpperCase() })
                    }
                    className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs uppercase text-white focus:border-brand-orange focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    Sort Order
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    value={form.sort_order}
                    onChange={(e) =>
                      setForm({ ...form, sort_order: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-white focus:border-brand-orange focus:outline-none"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2.5 text-xs font-medium text-slate-200">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-surface-600 bg-surface-950 text-brand-orange"
                />
                Enabled (ON — immediately visible to active desktop users)
              </label>

              {formError && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                  {formError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="rounded-lg border border-surface-700 bg-surface-950 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-surface-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-brand-orange px-4 py-2 text-xs font-bold text-surface-950 hover:brightness-110 disabled:opacity-50"
                >
                  {submitting
                    ? "Saving..."
                    : modalMode === "create"
                    ? "Add Tool"
                    : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
