import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  formatBytes,
  formatToolLabel,
  getFileExtensionBadge,
  isSafeToOpen,
  type DownloadRecord,
} from "./DownloadsPanel"

const AUTO_DISMISS_MS = 5000

export default function DownloadToastPopover() {
  const [downloads, setDownloads] = useState<DownloadRecord[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [isInteracting, setIsInteracting] = useState(false)
  const [eventSeq, setEventSeq] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add("is-download-toast-window")
    document.body.classList.add("is-download-toast-window")
    let mounted = true
    let unlisten: (() => void) | null = null

    void invoke<DownloadRecord[]>("list_downloads")
      .then((items) => {
        if (mounted && Array.isArray(items)) {
          setDownloads(items)
          setEventSeq((seq) => seq + 1)
        }
      })
      .catch(() => {})

    void listen<DownloadRecord[]>("stockstudio-downloads-updated", (event) => {
      if (mounted && Array.isArray(event.payload)) {
        setDownloads(event.payload)
        setEventSeq((seq) => seq + 1)
      }
    }).then((fn) => {
      if (mounted) unlisten = fn
      else fn()
    })

    return () => {
      mounted = false
      if (unlisten) unlisten()
      document.documentElement.classList.remove("is-download-toast-window")
      document.body.classList.remove("is-download-toast-window")
    }
  }, [])

  const pendingToasts = downloads.filter((item) => !item.dismissed_toast)
  const activeDownloads = pendingToasts.filter(
    (item) => item.status === "downloading" || item.status === "preparing"
  )
  // Keep notification compact (single card): prioritize active download, else latest completed/failed.
  const primaryItem = activeDownloads[0] ?? pendingToasts[0] ?? null
  const extraCount = Math.max(0, pendingToasts.length - 1)
  const hasActiveDownload = activeDownloads.length > 0

  // Chrome-style 5-second auto-dismiss for terminal states only:
  // - Never dismisses while any download is active.
  // - Pauses while hovering/interacting and restarts when interaction ends.
  // - Resets whenever a new download update arrives (eventSeq).
  useEffect(() => {
    if (!primaryItem || hasActiveDownload || isInteracting) return
    const timer = window.setTimeout(() => {
      void invoke<DownloadRecord[]>("dismiss_terminal_download_toasts")
        .then((updated) => setDownloads(updated))
        .catch(() => {})
    }, AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [primaryItem?.id, primaryItem?.status, hasActiveDownload, isInteracting, eventSeq])

  const handleShowInFolder = async (id: string) => {
    setActionError(null)
    try {
      await invoke("reveal_download_in_folder", { downloadId: id })
    } catch (error) {
      setActionError(typeof error === "string" ? error : "Unable to open folder.")
    }
  }

  const handleOpenFile = async (id: string) => {
    setActionError(null)
    try {
      await invoke("open_downloaded_file", { downloadId: id })
    } catch (error) {
      setActionError(typeof error === "string" ? error : "Unable to open file.")
    }
  }

  const handleDismiss = async () => {
    setActionError(null)
    try {
      if (hasActiveDownload && primaryItem) {
        const updated = await invoke<DownloadRecord[]>("dismiss_download_toast", {
          downloadId: primaryItem.id,
        })
        setDownloads(updated)
      } else {
        const updated = await invoke<DownloadRecord[]>("dismiss_terminal_download_toasts")
        setDownloads(updated)
      }
    } catch {
      // ignore
    }
  }

  const handleOpenHistory = async () => {
    try {
      await invoke("open_downloads_history")
    } catch {
      // ignore
    }
  }

  if (!primaryItem) return null

  const isDownloading = primaryItem.status === "downloading" || primaryItem.status === "preparing"
  const isCompleted = primaryItem.status === "completed"
  const isFailed = primaryItem.status === "failed" || primaryItem.status === "cancelled"
  const extBadge = getFileExtensionBadge(primaryItem.extension)

  return (
    <div
      className="download-toast-stack"
      role="region"
      aria-label="Download notification"
      onMouseEnter={() => setIsInteracting(true)}
      onMouseLeave={() => setIsInteracting(false)}
      onFocusCapture={() => setIsInteracting(true)}
      onBlurCapture={() => setIsInteracting(false)}
    >
      {actionError && <div className="download-toast-error">{actionError}</div>}
      <div
        key={primaryItem.id}
        className={`download-toast-card ${isCompleted ? "is-completed" : ""} ${
          isFailed ? "is-failed" : ""
        }`}
      >
        <div className="download-toast-top">
          <span className={`download-ext-badge is-${extBadge.tone}`}>{extBadge.label}</span>
          <div className="download-toast-info">
            <div className="download-toast-name" title={primaryItem.file_name}>
              {primaryItem.file_name}
            </div>
            <div className="download-toast-sub">
              <span>{formatToolLabel(primaryItem.tool_id)}</span>
              <span aria-hidden="true">•</span>
              {isDownloading ? (
                <span className="dl-status-active">
                  Downloading…{extraCount > 0 ? ` (+${extraCount})` : ""}
                </span>
              ) : isCompleted ? (
                <span className="dl-status-done">
                  Completed{primaryItem.total_bytes ? ` · ${formatBytes(primaryItem.total_bytes)}` : ""}
                  {extraCount > 0 ? ` (+${extraCount})` : ""}
                </span>
              ) : (
                <span className="dl-status-fail">
                  {primaryItem.error_message || "Download failed"}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="download-toast-close"
            aria-label="Dismiss notification"
            title="Dismiss"
            onClick={() => void handleDismiss()}
          >
            ×
          </button>
        </div>
        {isDownloading && (
          <div className="download-progress-track" aria-label="Download in progress">
            <div className="download-progress-bar is-indeterminate" />
          </div>
        )}
        {!isDownloading && (
          <div className="download-toast-actions">
            {isCompleted && (
              <button
                type="button"
                className="download-btn-primary"
                disabled={!primaryItem.file_exists}
                onClick={() => void handleShowInFolder(primaryItem.id)}
              >
                Show in Folder
              </button>
            )}
            {isCompleted && primaryItem.file_exists && isSafeToOpen(primaryItem.extension) && (
              <button
                type="button"
                className="download-btn-secondary"
                onClick={() => void handleOpenFile(primaryItem.id)}
              >
                Open
              </button>
            )}
            <button
              type="button"
              className="download-btn-ghost"
              onClick={() => void handleOpenHistory()}
            >
              History
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
