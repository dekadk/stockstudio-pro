// =============================================================================
// StockStudio Pro v0.3.0 — Centralized Studio Tool Registry
//
// All external & Google Flow shared tool URLs are defined here once rather than
// duplicated across UI components.
// =============================================================================

export type ToolLaunchMode = "google-flow-webview" | "external-browser"

export type StudioToolId = "background" | "mascot" | "pattern" | "aio-metadata"

export interface StudioToolDefinition {
  id: StudioToolId
  name: string
  category: "Google Flow Tool" | "Metadata Tool"
  description: string
  url: string
  launchMode: ToolLaunchMode
  badge: string
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
  },
  {
    id: "mascot",
    name: "Mascot",
    category: "Google Flow Tool",
    description: "Design consistent character and mascot illustrations with Google Flow.",
    url: "https://flow.google.com/shared/tool/26646271-d332-4385-b06d-a6f2758e9c54",
    launchMode: "google-flow-webview",
    badge: "FLOW",
  },
  {
    id: "pattern",
    name: "Pattern",
    category: "Google Flow Tool",
    description: "Create seamless repeating patterns and surface designs in Google Flow.",
    url: "https://flow.google.com/shared/tool/a3c286ba-7b8a-4b03-ac29-02bcc12d2281",
    launchMode: "google-flow-webview",
    badge: "FLOW",
  },
  {
    id: "aio-metadata",
    name: "AIO Metadata",
    category: "Metadata Tool",
    description: "Prepare microstock titles, descriptions, and keywords in your browser.",
    url: "https://share.gemini.google/CwUs3ZQJlnrk",
    launchMode: "external-browser",
    badge: "EXTERNAL",
  },
] as const

export const BACKGROUND_TOOL: StudioToolDefinition = STUDIO_TOOLS[0]
export const MASCOT_TOOL: StudioToolDefinition = STUDIO_TOOLS[1]
export const PATTERN_TOOL: StudioToolDefinition = STUDIO_TOOLS[2]

export function getStudioToolById(id: StudioToolId): StudioToolDefinition | undefined {
  return STUDIO_TOOLS.find((tool) => tool.id === id)
}
