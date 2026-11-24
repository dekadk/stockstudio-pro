// =============================================================================
// StockStudio Pro — Centralized Studio Tool Registry (Dynamic + Offline Defaults)
//
// Built-in defaults are used as fallback before first sync or when offline.
// Live tool definitions (URL, name, badge, ON/OFF, newly added tools) are synced
// from the StockStudio Pro License API (`GET /v1/tools`) managed via License Manager.
// =============================================================================

export type ToolLaunchMode = "google-flow-webview" | "external-browser"

export type StudioToolId = string

export type StudioToolIconId =
  | "background"
  | "mascot"
  | "pattern"
  | "tag"
  | "sparkles"
  | "wand"
  | "palette"
  | "layers"
  | "camera"
  | "video"
  | "type"
  | "grid"
  | "bot"
  | "rocket"
  | "folder"
  | "wrench"

export interface StudioToolDefinition {
  id: StudioToolId
  name: string
  category: string
  description: string
  url: string
  launchMode: ToolLaunchMode
  badge: string
  icon?: StudioToolIconId
  enabled?: boolean
  sortOrder?: number
}

export interface RemoteStudioToolPayload {
  id: string
  name: string
  category: string
  description: string
  url: string
  badge: string
  icon?: string
  enabled?: boolean
  sort_order?: number
}

export const STUDIO_TOOLS: readonly StudioToolDefinition[] = [
  {
    id: "background",
    name: "Background",
    category: "Google Flow Tool",
    description: "Generate clean microstock-ready backgrounds directly inside Google Flow.",
    url: "https://flow.google.com/shared/tool/91cce113-c49e-4021-81f3-0e2f3d2035c0",
    launchMode: "google-flow-webview",
    badge: "FLOW",
    enabled: true,
    sortOrder: 10,
  },
  {
    id: "mascot",
    name: "Mascot",
    category: "Google Flow Tool",
    description: "Design consistent character and mascot illustrations with Google Flow.",
    url: "https://flow.google.com/shared/tool/26646271-d332-4385-b06d-a6f2758e9c54",
    launchMode: "google-flow-webview",
    badge: "FLOW",
    enabled: true,
    sortOrder: 20,
  },
  {
    id: "pattern",
    name: "Pattern",
    category: "Google Flow Tool",
    description: "Create seamless repeating patterns and surface designs in Google Flow.",
    url: "https://flow.google.com/shared/tool/a3c286ba-7b8a-4b03-ac29-02bcc12d2281",
    launchMode: "google-flow-webview",
    badge: "FLOW",
    enabled: true,
    sortOrder: 30,
  },
  {
    id: "aio-metadata",
    name: "AIO Metadata",
    category: "Metadata Tool",
    description: "Prepare microstock titles, descriptions, and keywords directly inside StockStudio Pro.",
    url: "https://share.gemini.google/CwUs3ZQJlnrk",
    launchMode: "google-flow-webview",
    badge: "GEMINI",
    enabled: true,
    sortOrder: 40,
  },
] as const

export const BACKGROUND_TOOL: StudioToolDefinition = STUDIO_TOOLS[0]
export const MASCOT_TOOL: StudioToolDefinition = STUDIO_TOOLS[1]
export const PATTERN_TOOL: StudioToolDefinition = STUDIO_TOOLS[2]
export const AIO_METADATA_TOOL: StudioToolDefinition = STUDIO_TOOLS[3]

const VALID_TOOL_ICONS = new Set<StudioToolIconId>([
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
])

function resolveToolIcon(id: string, badge: string, rawIcon?: string): StudioToolIconId {
  const normalized = (rawIcon || "").trim().toLowerCase() as StudioToolIconId
  if (VALID_TOOL_ICONS.has(normalized)) return normalized
  if (id === "background") return "background"
  if (id === "mascot") return "mascot"
  if (id === "pattern") return "pattern"
  if (id === "aio-metadata") return "tag"
  if (badge === "GEMINI") return "sparkles"
  return "wand"
}

export function normalizeRemoteStudioTools(
  remote: RemoteStudioToolPayload[]
): StudioToolDefinition[] {
  return remote
    .filter((item) => item && item.enabled !== false && Boolean(item.id?.trim()) && Boolean(item.url?.trim()))
    .map((item) => {
      const id = item.id.trim().toLowerCase()
      const badge = (item.badge?.trim() || "FLOW").toUpperCase()
      return {
        id,
        name: item.name.trim(),
        category: item.category?.trim() || "Studio Tool",
        description: item.description?.trim() || "",
        url: item.url.trim(),
        launchMode: "google-flow-webview" as const,
        badge,
        icon: resolveToolIcon(id, badge, item.icon),
        enabled: true,
        sortOrder: typeof item.sort_order === "number" ? item.sort_order : 100,
      }
    })
    .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100))
}

export function getStudioToolById(
  id: StudioToolId,
  tools: readonly StudioToolDefinition[] = STUDIO_TOOLS
): StudioToolDefinition | undefined {
  return tools.find((tool) => tool.id === id)
}
