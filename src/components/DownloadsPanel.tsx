import { useState } from "react"
import { invoke } from "@tauri-apps/api/core"

export type DownloadStatus = "preparing" | "downloading" | "completed" | "failed" | "cancelled"

export type DownloadRecord = {
  id: string
  file_name: string
  destination_path: string
  extension: string
  account_id: string
  tool_id: string
  status: DownloadStatus
  total_bytes: number | null
  downloaded_bytes: number | null
  progress_percent: number | null
  started_at: string
  completed_at: string | null
  error_message: string | null
  dismissed_toast: boolean
  file_exists: boolean
}

const BLOCKED_OPEN_EXTS = new Set([
  "exe",
  "msi",
  "msp",
  "bat",
  "cmd",
  "ps1",
  "psm1",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "scr",
  "com",
  "pif",
  "reg",
  "hta",
  "lnk",
  "dll",
  "sys",
  "jar",
])

export function isSafeToOpen(extension: string): boolean {
  const ext = extension.trim().toLowerCase()
  return ext.length > 0 && !BLOCKED_OPEN_EXTS.has(ext)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatToolLabel(toolId: string): string {
  switch (toolId) {
    case "background":
      return "Background Studio"
    case "mascot":
      return "Mascot Studio"
    case "pattern":
      return "Pattern Studio"
    default:
      return "Google Flow"
  }
}

export function getFileExtensionBadge(extension: string): {
  label: string
  tone: "image" | "archive" | "vector" | "default"
} {
  const ext = extension.trim().toLowerCase()
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(ext)) {
    return { label: ext.toUpperCase().slice(0, 4), tone: "image" }
  }
  if (["svg", "eps", "ai"].includes(ext)) {
    return { label: ext.toUpperCase().slice(0, 4), tone: "vector" }
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
    return { label: ext.toUpperCase().slice(0, 4), tone: "archive" }
  }
  return { label: ext ? ext.toUpperCase().slice(0, 4) : "FILE", tone: "default" }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

export default function DownloadsPanel({
  downloads,
  accountNameById,
  onUpdated,
}: {
  downloads: DownloadRecord[]
  accountNameById: Record<string, string>
  onUpdated: (next: DownloadRecord[]) => void
}) {
  const [actionError, setActionError] = useState<string | null>(null)

  const activeCount = downloads.filter(
    (d) => d.status === "preparing" || d.status === "downloading"
  ).length
  const completedCount = downloads.filter((d) => d.status === "completed").length

  const handleShowInFolder = async (id: string) => {
    setActionError(null)
    try {
      await invoke("reveal_download_in_folder", { downloadId: id })
    } catch (error) {
      setActionError(typeof error === "string" ? error : "Unable to reveal file in Explorer.")
    }
  }

  const handleOpenFile = async (id: string) => {
    setActionError(null)
    try {
      await invoke("open_downloaded_file", { downloadId: id })
    } catch (error) {
      setActionError(typeof error === "string" ? error : "Unable to open downloaded file.")
    }
  }

  const handleRemove = async (id: string) => {
    setActionError(null)
    try {
      const next = await invoke<DownloadRecord[]>("remove_download_record", { downloadId: id })
      onUpdated(next)
    } catch (error) {
      setActionError(typeof error === "string" ? error : "Unable to remove record.")
    }
  }

  const handleClearCompleted = async () => {
    setActionError(null)
    try {
      const next = await invoke<DownloadRecord[]>("clear_completed_downloads")
      onUpdated(next)
    } catch (error) {
      setActionError(typeof error === "string" ? error : "Unable to clear download history.")
    }
  }

  return (
    <section className="downloads-panel" aria-label="Downloads">
      <div className="section-header">
        <div>
          <h2>Recent Downloads</h2>
          <p>
            Files saved from Google Flow workspaces remain in your Windows Downloads folder.
          </p>
        </div>
        <div className="downloads-header-actions">
          {activeCount > 0 && <span className="badge badge-info">{activeCount} ACTIVE</span>}
          {completedCount > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={() => void handleClearCompleted()}
            >
              Clear Completed
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="notice-banner is-error" role="alert">
          <span>{actionError}</span>
          <button type="button" className="secondary" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {downloads.length === 0 ? (
        <div className="downloads-empty">
          <h3>No downloads yet</h3>
          <p>
            Images and assets downloaded from Background Studio, Mascot Studio, Pattern Studio, or
            Google Flow will appear here with quick Show in Folder access.
          </p>
        </div>
      ) : (
        <div className="downloads-list">
          {downloads.map((item) => {
            const isDownloading = item.status === "downloading" || item.status === "preparing"
            const isCompleted = item.status === "completed"
            const isFailed = item.status === "failed" || item.status === "cancelled"
            const extBadge = getFileExtensionBadge(item.extension)
            const accountLabel = accountNameById[item.account_id]
            return (
              <article
                key={item.id}
                className={`download-row-card ${isFailed ? "is-failed" : ""}`}
              >
                <span className={`download-ext-badge is-${extBadge.tone}`}>{extBadge.label}</span>
                <div className="download-row-main">
                  <div className="download-row-title-line">
                    <h3 title={item.file_name}>{item.file_name}</h3>
                    <span
                      className={`badge ${
                        isCompleted
                          ? ""
                          : isDownloading
                          ? "badge-info"
                          : "badge-warning"
                      }`}
                    >
                      {item.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="download-row-meta">
                    <span>{formatToolLabel(item.tool_id)}</span>
                    {accountLabel && (
                      <>
                        <span aria-hidden="true">•</span>
                        <span>{accountLabel}</span>
                      </>
                    )}
                    {item.total_bytes !== null && (
                      <>
                        <span aria-hidden="true">•</span>
                        <span>{formatBytes(item.total_bytes)}</span>
                      </>
                    )}
                    <span aria-hidden="true">•</span>
                    <span>{formatTimestamp(item.completed_at || item.started_at)}</span>
                  </div>
                  {isDownloading && (
                    <div className="download-progress-track">
                      <div className="download-progress-bar is-indeterminate" />
                    </div>
                  )}
                  {isFailed && item.error_message && (
                    <div className="download-row-error">{item.error_message}</div>
                  )}
                  {isCompleted && !item.file_exists && (
                    <div className="download-missing-label">
                      File no longer exists at its saved location
                    </div>
                  )}
                </div>
                <div className="download-row-actions">
                  {isCompleted && (
                    <button
                      type="button"
                      className="primary"
                      disabled={!item.file_exists}
                      onClick={() => void handleShowInFolder(item.id)}
                    >
                      Show in Folder
                    </button>
                  )}
                  {isCompleted && item.file_exists && isSafeToOpen(item.extension) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void handleOpenFile(item.id)}
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    className="download-toast-close"
                    title="Remove from list"
                    aria-label="Remove from list"
                    onClick={() => void handleRemove(item.id)}
                  >
                    ×
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
