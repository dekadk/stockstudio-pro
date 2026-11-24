// =============================================================================
// StockStudio Pro License API — Dynamic Studio Tool Registry Handlers
// Endpoints:
//   - GET    /v1/tools                (Active client license Bearer ssact_...)
//   - GET    /v1/admin/tools          (Admin Bearer ssadm_..., all roles)
//   - POST   /v1/admin/tools          (Admin Bearer ssadm_..., super_admin/support_admin)
//   - PATCH  /v1/admin/tools/:tool_id (Admin Bearer ssadm_..., super_admin/support_admin)
//   - DELETE /v1/admin/tools/:tool_id (Admin Bearer ssadm_..., super_admin)
// =============================================================================

import { authenticateAdmin } from "./admin-handlers";
import { constantTimeEqual, hashActivationToken } from "./crypto";
import { ApiError, jsonResponse } from "./errors";
import { ActivationRow, Env, LicenseRow, RequestContext, StudioToolRow } from "./types";
import { parseJsonBody } from "./utils";

const ALLOWED_TOOL_HOSTS: readonly string[] = [
  "flow.google",
  "flow.google.com",
  "labs.google",
  "share.gemini.google",
  "gemini.google.com",
  "gemini.google",
  "aistudio.google.com",
  "bard.google.com",
  "g.co",
];

const ALLOWED_TOOL_ICONS = new Set([
  "background",
  "mascot",
  "pattern",
  "tag",
  "sparkles",
  "wand",
  "palette",
  "layers",
  "camera",
  "video",
  "type",
  "grid",
  "bot",
  "rocket",
  "folder",
  "wrench",
]);

export interface StudioToolDto {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  badge: string;
  icon: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function normalizeToolIcon(raw: unknown, fallback = "sparkles"): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (!ALLOWED_TOOL_ICONS.has(normalized)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: `Unsupported tool icon '${normalized}'.`,
    });
  }
  return normalized;
}

function formatStudioTool(row: StudioToolRow): StudioToolDto {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    url: row.url,
    badge: row.badge,
    icon: row.icon && ALLOWED_TOOL_ICONS.has(row.icon) ? row.icon : "sparkles",
    enabled: row.enabled === 1,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isAllowedToolHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  return ALLOWED_TOOL_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

export function validateStudioToolUrl(raw: unknown): { url: string; host: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Tool URL is required.",
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length > 2048) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Tool URL must be at most 2048 characters.",
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Tool URL must be a valid HTTPS URL.",
    });
  }

  if (parsed.protocol !== "https:") {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Tool URL must use HTTPS.",
    });
  }

  if (parsed.username || parsed.password) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Tool URL must not contain embedded credentials.",
    });
  }

  const host = parsed.hostname.toLowerCase();
  if (!isAllowedToolHost(host)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message:
        "Tool URL host is not allowed. Only Google Flow (flow.google.com, labs.google) and Gemini (share.gemini.google, gemini.google.com) links are supported.",
    });
  }

  return { url: parsed.toString(), host };
}

function deriveDefaultBadge(host: string): string {
  if (
    host === "share.gemini.google" ||
    host === "gemini.google.com" ||
    host === "gemini.google" ||
    host === "aistudio.google.com" ||
    host === "bard.google.com"
  ) {
    return "GEMINI";
  }
  return "FLOW";
}

function normalizeToolId(rawId: unknown, fallbackName: string): string {
  const source =
    typeof rawId === "string" && rawId.trim().length > 0
      ? rawId.trim().toLowerCase()
      : fallbackName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");

  if (!source || source.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/.test(source)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message:
        "Tool ID must be 1–64 lowercase letters, digits, hyphens, or underscores.",
    });
  }

  const reserved = new Set([
    "accounts",
    "downloads",
    "tools",
    "favorites",
    "license",
    "updates",
    "info",
    "settings",
    "flow",
    "tool",
    "default",
  ]);
  if (reserved.has(source)) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: `Tool ID '${source}' is reserved. Please choose another ID.`,
    });
  }

  return source;
}

function validateStringField(
  raw: unknown,
  field: string,
  maxLen: number,
  required: boolean
): string {
  if (typeof raw !== "string") {
    if (required) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: `${field} is required.`,
      });
    }
    return "";
  }
  const trimmed = raw.trim();
  if (required && !trimmed) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: `${field} cannot be empty.`,
    });
  }
  if (trimmed.length > maxLen) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 400,
      message: `${field} must be at most ${maxLen} characters.`,
    });
  }
  return trimmed;
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization")?.trim();
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * GET /v1/tools
 * Returns all enabled Studio Tools for authenticated active desktop clients.
 */
export async function handleClientListTools(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  const bearerToken = extractBearerToken(request);
  if (!bearerToken || !bearerToken.startsWith("ssact_")) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Missing or invalid Bearer activation token.",
    });
  }

  const tokenHash = await hashActivationToken(bearerToken);
  const activation = await env.DB.prepare(
    "SELECT * FROM activations WHERE token_hash = ?1"
  )
    .bind(tokenHash)
    .first<ActivationRow>();

  if (
    !activation ||
    !constantTimeEqual(activation.token_hash, tokenHash) ||
    activation.status !== "active"
  ) {
    throw new ApiError({
      code: "UNAUTHORIZED_TOKEN",
      status: 401,
      message: "Activation session is not active.",
    });
  }

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?1")
    .bind(activation.license_id)
    .first<LicenseRow>();

  if (!license || license.status !== "active") {
    throw new ApiError({
      code: "INVALID_LICENSE_KEY",
      status: 403,
      message: "License is not active.",
    });
  }

  if (
    license.license_type === "subscription" &&
    license.expires_at &&
    new Date(license.expires_at).getTime() <= ctx.now.getTime()
  ) {
    throw new ApiError({
      code: "LICENSE_EXPIRED",
      status: 403,
      message: "License has expired.",
    });
  }

  const result = await env.DB.prepare(
    "SELECT * FROM studio_tools WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC"
  ).all<StudioToolRow>();

  return jsonResponse(
    {
      ok: true,
      tools: (result.results ?? []).map(formatStudioTool),
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * GET /v1/admin/tools
 * Returns all Studio Tools (both enabled and disabled) for License Manager.
 */
export async function handleAdminListTools(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  await authenticateAdmin(request, env, ctx, [
    "super_admin",
    "support_admin",
    "read_only",
  ]);

  const result = await env.DB.prepare(
    "SELECT * FROM studio_tools ORDER BY sort_order ASC, created_at ASC"
  ).all<StudioToolRow>();

  return jsonResponse(
    {
      ok: true,
      tools: (result.results ?? []).map(formatStudioTool),
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * POST /v1/admin/tools
 * Creates a new Studio Tool entry.
 */
export async function handleAdminCreateTool(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  await authenticateAdmin(request, env, ctx, ["super_admin", "support_admin"]);

  const body = await parseJsonBody<{
    id?: unknown;
    name?: unknown;
    category?: unknown;
    description?: unknown;
    url?: unknown;
    badge?: unknown;
    icon?: unknown;
    enabled?: unknown;
    sort_order?: unknown;
  }>(request);

  const name = validateStringField(body.name, "Tool name", 64, true);
  const id = normalizeToolId(body.id, name);
  const { url, host } = validateStudioToolUrl(body.url);
  const category =
    validateStringField(body.category, "Category", 48, false) ||
    (deriveDefaultBadge(host) === "GEMINI" ? "Metadata Tool" : "Google Flow Tool");
  const description = validateStringField(body.description, "Description", 240, false);
  const badge = (
    validateStringField(body.badge, "Badge", 16, false) || deriveDefaultBadge(host)
  ).toUpperCase();
  const icon = normalizeToolIcon(
    body.icon,
    deriveDefaultBadge(host) === "GEMINI" ? "sparkles" : "wand"
  );
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  let sortOrder: number;
  if (typeof body.sort_order === "number" && Number.isFinite(body.sort_order)) {
    sortOrder = Math.max(0, Math.min(10000, Math.trunc(body.sort_order)));
  } else {
    const maxRow = await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM studio_tools"
    ).first<{ max_order: number }>();
    sortOrder = (maxRow?.max_order ?? 0) + 10;
  }

  const existing = await env.DB.prepare("SELECT id FROM studio_tools WHERE id = ?1")
    .bind(id)
    .first<{ id: string }>();
  if (existing) {
    throw new ApiError({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
      message: `A studio tool with ID '${id}' already exists.`,
    });
  }

  await env.DB.prepare(
    `INSERT INTO studio_tools (
       id, name, category, description, url, badge, icon, enabled, sort_order, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`
  )
    .bind(
      id,
      name,
      category,
      description,
      url,
      badge,
      icon,
      enabled ? 1 : 0,
      sortOrder,
      ctx.nowIso
    )
    .run();

  const created = await env.DB.prepare("SELECT * FROM studio_tools WHERE id = ?1")
    .bind(id)
    .first<StudioToolRow>();

  return jsonResponse(
    {
      ok: true,
      tool: created ? formatStudioTool(created) : null,
      server_time: ctx.nowIso,
    },
    201,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * PATCH /v1/admin/tools/:tool_id
 * Updates URL, metadata, sort order, or ON/OFF enabled status of an existing tool.
 */
export async function handleAdminUpdateTool(
  request: Request,
  env: Env,
  ctx: RequestContext,
  toolId: string
): Promise<Response> {
  await authenticateAdmin(request, env, ctx, ["super_admin", "support_admin"]);

  const existing = await env.DB.prepare("SELECT * FROM studio_tools WHERE id = ?1")
    .bind(toolId)
    .first<StudioToolRow>();

  if (!existing) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 404,
      message: `Studio tool '${toolId}' not found.`,
    });
  }

  const body = await parseJsonBody<{
    name?: unknown;
    category?: unknown;
    description?: unknown;
    url?: unknown;
    badge?: unknown;
    icon?: unknown;
    enabled?: unknown;
    sort_order?: unknown;
  }>(request);

  const name =
    body.name !== undefined
      ? validateStringField(body.name, "Tool name", 64, true)
      : existing.name;
  const category =
    body.category !== undefined
      ? validateStringField(body.category, "Category", 48, true)
      : existing.category;
  const description =
    body.description !== undefined
      ? validateStringField(body.description, "Description", 240, false)
      : existing.description;
  const url =
    body.url !== undefined ? validateStudioToolUrl(body.url).url : existing.url;
  const badge =
    body.badge !== undefined
      ? validateStringField(body.badge, "Badge", 16, true).toUpperCase()
      : existing.badge;
  const icon =
    body.icon !== undefined
      ? normalizeToolIcon(body.icon, existing.icon || "sparkles")
      : existing.icon || "sparkles";
  const enabled =
    body.enabled !== undefined ? (Boolean(body.enabled) ? 1 : 0) : existing.enabled;
  const sortOrder =
    body.sort_order !== undefined
      ? typeof body.sort_order === "number" && Number.isFinite(body.sort_order)
        ? Math.max(0, Math.min(10000, Math.trunc(body.sort_order)))
        : existing.sort_order
      : existing.sort_order;

  await env.DB.prepare(
    `UPDATE studio_tools
       SET name = ?2,
           category = ?3,
           description = ?4,
           url = ?5,
           badge = ?6,
           icon = ?7,
           enabled = ?8,
           sort_order = ?9,
           updated_at = ?10
     WHERE id = ?1`
  )
    .bind(
      toolId,
      name,
      category,
      description,
      url,
      badge,
      icon,
      enabled,
      sortOrder,
      ctx.nowIso
    )
    .run();

  const updated = await env.DB.prepare("SELECT * FROM studio_tools WHERE id = ?1")
    .bind(toolId)
    .first<StudioToolRow>();

  return jsonResponse(
    {
      ok: true,
      tool: updated ? formatStudioTool(updated) : null,
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}

/**
 * DELETE /v1/admin/tools/:tool_id
 * Deletes a Studio Tool entry (super_admin only).
 */
export async function handleAdminDeleteTool(
  request: Request,
  env: Env,
  ctx: RequestContext,
  toolId: string
): Promise<Response> {
  await authenticateAdmin(request, env, ctx, ["super_admin"]);

  const existing = await env.DB.prepare("SELECT id FROM studio_tools WHERE id = ?1")
    .bind(toolId)
    .first<{ id: string }>();

  if (!existing) {
    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 404,
      message: `Studio tool '${toolId}' not found.`,
    });
  }

  await env.DB.prepare("DELETE FROM studio_tools WHERE id = ?1")
    .bind(toolId)
    .run();

  return jsonResponse(
    {
      ok: true,
      deleted_id: toolId,
      server_time: ctx.nowIso,
    },
    200,
    { "X-Request-Id": ctx.requestId }
  );
}
