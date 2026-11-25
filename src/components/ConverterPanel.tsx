import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import {
  updateConverterJob,
  useToolJobs,
  type VectorOptimizeStats,
  type VectorOptimizerMode,
} from "../services/tool-job-store"

interface ScanResult {
  files: string[]
  total: number
  default_output_dir: string | null
}

interface VectorAuditPreview {
  file_name: string
  before_svg: string
  after_svg: string
  stats: VectorOptimizeStats
}

function formatNodeDrop(before: number, after: number): string {
  if (before <= 0) return ""
  const diff = Math.round(((before - after) / before) * 100)
  if (diff > 0) return ` (-${diff}%)`
  return ""
}

export default function ConverterPanel() {
  const { converter: job } = useToolJobs()
  const { selectedFiles, sourceLabel, inputDir, outputDir, mode, running, progress, summary, error } = job
  const [isDragOver, setIsDragOver] = useState(false)
  const runningRef = useRef(running)
  runningRef.current = running

  // On-demand Visual Audit modal state (local UI only)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditIndex, setAuditIndex] = useState(0)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [auditPreview, setAuditPreview] = useState<VectorAuditPreview | null>(null)
  const [auditView, setAuditView] = useState<"split" | "after">("split")
  const [wireframe, setWireframe] = useState(false)

  useEffect(() => {
    let mounted = true
    let unlistenDrop: (() => void) | null = null

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!mounted || runningRef.current) return
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDragOver(true)
        } else if (event.payload.type === "leave") {
          setIsDragOver(false)
        } else if (event.payload.type === "drop") {
          setIsDragOver(false)
          const droppedPaths = event.payload.paths ?? []
          if (droppedPaths.length === 0) return
          updateConverterJob((prev) => ({ ...prev, error: null, summary: null }))
          void invoke<ScanResult>("resolve_dropped_converter_paths", {
            paths: droppedPaths,
            recursive: true,
          })
            .then((res) => {
              if (!mounted) return
              if (res.total === 0) {
                updateConverterJob((prev) => ({
                  ...prev,
                  error: "No SVG files found in the dropped item.",
                }))
                return
              }
              updateConverterJob((prev) => ({
                ...prev,
                selectedFiles: res.files,
                inputDir: null,
                sourceLabel:
                  res.total === 1
                    ? res.files[0].split(/[\\/]/).pop() || "1 SVG file"
                    : `${res.total} SVG files`,
                outputDir: res.default_output_dir || prev.outputDir,
                error: null,
                summary: null,
              }))
            })
            .catch((err) => {
              if (!mounted) return
              updateConverterJob((prev) => ({
                ...prev,
                error: typeof err === "string" ? err : "Unable to read dropped files.",
              }))
            })
        }
      })
      .then((fn) => {
        if (mounted) unlistenDrop = fn
        else fn()
      })
      .catch(() => {})

    return () => {
      mounted = false
      if (unlistenDrop) unlistenDrop()
    }
  }, [])

  const auditFiles = summary?.files ?? []

  useEffect(() => {
    if (!auditOpen || auditFiles.length === 0) return
    const safeIdx = Math.max(0, Math.min(auditIndex, auditFiles.length - 1))
    const target = auditFiles[safeIdx]
    if (!target) return

    let active = true
    const auditMode: VectorOptimizerMode = summary?.mode ?? mode
    setAuditLoading(true)
    setAuditError(null)
    void invoke<VectorAuditPreview>("preview_vector_audit", {
      inputPath: target.input_path,
      mode: auditMode,
    })
      .then((res) => {
        if (!active) return
        setAuditPreview(res)
      })
      .catch((err) => {
        if (!active) return
        setAuditPreview(null)
        setAuditError(typeof err === "string" ? err : "Unable to generate visual audit.")
      })
      .finally(() => {
        if (active) setAuditLoading(false)
      })

    return () => {
      active = false
    }
  }, [auditOpen, auditIndex, auditFiles, summary?.mode, mode])

  useEffect(() => {
    if (!auditOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAuditOpen(false)
      } else if (e.key === "ArrowLeft" && auditFiles.length > 1) {
        setAuditIndex((i) => (i > 0 ? i - 1 : auditFiles.length - 1))
      } else if (e.key === "ArrowRight" && auditFiles.length > 1) {
        setAuditIndex((i) => (i + 1) % auditFiles.length)
      } else if (e.key.toLowerCase() === "y" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setWireframe((w) => !w)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [auditOpen, auditFiles.length])

  const handleSelectFiles = async () => {
    updateConverterJob((prev) => ({ ...prev, error: null, summary: null }))
    try {
      const res = await invoke<ScanResult>("pick_converter_files")
      if (res.total === 0) return
      updateConverterJob((prev) => ({
        ...prev,
        selectedFiles: res.files,
        inputDir: null,
        sourceLabel:
          res.total === 1
            ? res.files[0].split(/[\\/]/).pop() || "1 SVG file"
            : `${res.total} SVG files`,
        outputDir: res.default_output_dir || prev.outputDir,
      }))
    } catch (err) {
      updateConverterJob((prev) => ({
        ...prev,
        error: typeof err === "string" ? err : "Unable to select files.",
      }))
    }
  }

  const handleSelectFolder = async () => {
    updateConverterJob((prev) => ({ ...prev, error: null, summary: null }))
    try {
      const folder = await invoke<string | null>("pick_converter_folder", {
        title: "Select Folder with SVG Files",
      })
      if (!folder) return
      const res = await invoke<ScanResult>("scan_converter_svgs", {
        inputDir: folder,
        recursive: true,
      })
      if (res.total === 0) {
        updateConverterJob((prev) => ({
          ...prev,
          error: "No SVG files found in that folder.",
        }))
        return
      }
      updateConverterJob((prev) => ({
        ...prev,
        selectedFiles: res.files,
        inputDir: folder,
        sourceLabel: `${res.total} SVG file${res.total === 1 ? "" : "s"}`,
        outputDir: res.default_output_dir || prev.outputDir,
      }))
    } catch (err) {
      updateConverterJob((prev) => ({
        ...prev,
        error: typeof err === "string" ? err : "Unable to scan folder.",
      }))
    }
  }

  const handleChangeOutput = async () => {
    try {
      const folder = await invoke<string | null>("pick_converter_folder", {
        title: "Select Output Folder",
      })
      if (folder) {
        updateConverterJob((prev) => ({ ...prev, outputDir: folder }))
      }
    } catch {}
  }

  const handleStart = async () => {
    if (selectedFiles.length === 0) return
    setAuditOpen(false)
    updateConverterJob((prev) => ({
      ...prev,
      error: null,
      summary: null,
      progress: { current: 0, total: selectedFiles.length, fileName: "" },
    }))
    try {
      const res = await invoke<{ total_files: number; output_dir: string }>(
        "start_svg_to_eps_batch",
        {
          request: {
            files: inputDir ? [] : selectedFiles,
            input_dir: inputDir,
            output_dir: outputDir,
            mode,
            recursive: true,
            up_size: true,
            min_size_pt: 2100,
            remove_outlines: true,
            combine_by_color: true,
            overwrite_existing: true,
          },
        }
      )
      updateConverterJob((prev) => ({
        ...prev,
        outputDir: res.output_dir,
        running: true,
        progress: { current: 0, total: res.total_files, fileName: "" },
      }))
    } catch (err) {
      updateConverterJob((prev) => ({
        ...prev,
        running: false,
        error: typeof err === "string" ? err : "Optimization failed to start.",
      }))
    }
  }

  const handleCancel = async () => {
    try {
      await invoke("cancel_svg_to_eps_batch")
    } catch {}
  }

  const handleReset = () => {
    setAuditOpen(false)
    setAuditPreview(null)
    setAuditIndex(0)
    updateConverterJob((prev) => ({
      ...prev,
      selectedFiles: [],
      inputDir: null,
      sourceLabel: "",
      summary: null,
      error: null,
      progress: { current: 0, total: 0, fileName: "" },
    }))
  }

  const handleOpenOutput = async () => {
    if (!outputDir.trim()) return
    try {
      await invoke("open_converter_folder", { path: outputDir.trim() })
    } catch (err) {
      updateConverterJob((prev) => ({
        ...prev,
        error: typeof err === "string" ? err : "Unable to open output folder.",
      }))
    }
  }

  const handleOpenAudit = () => {
    if (auditFiles.length === 0) return
    setAuditIndex(0)
    setAuditView("split")
    setWireframe(false)
    setAuditOpen(true)
  }

  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0
  const isTotalFailure = Boolean(
    summary && !summary.cancelled && summary.succeeded === 0 && summary.failed > 0
  )
  const isWarning = Boolean(
    summary && (summary.cancelled || (summary.succeeded > 0 && summary.failed > 0))
  )
  const displayError = error || summary?.last_error || null

  const handleSelectMode = (nextMode: VectorOptimizerMode) => {
    if (running || nextMode === mode) return
    setAuditOpen(false)
    setAuditPreview(null)
    updateConverterJob((prev) => ({
      ...prev,
      mode: nextMode,
      summary: null,
      error: null,
    }))
  }

  const isPattern = mode === "pattern"
  const activeModeLabel = isPattern ? "Pattern" : "Logo / Mascot"
  const summaryModeLabel = (summary?.mode ?? mode) === "pattern" ? "Pattern" : "Logo / Mascot"

  return (
    <div className="converter-clean-wrap optimizer-page-wrap">
      <div className="optimizer-mode-tabs" role="tablist" aria-label="Vector Optimizer Mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "logo-mascot"}
          disabled={running}
          className={`optimizer-mode-tab ${mode === "logo-mascot" ? "is-active" : ""}`}
          onClick={() => handleSelectMode("logo-mascot")}
        >
          Logo / Mascot
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "pattern"}
          disabled={running}
          className={`optimizer-mode-tab ${mode === "pattern" ? "is-active" : ""}`}
          onClick={() => handleSelectMode("pattern")}
        >
          Pattern
        </button>
      </div>

      <div className={`converter-drop-card ${isDragOver ? "is-drag-over" : ""}`}>
        {!running && !summary && selectedFiles.length === 0 && (
          <>
            <div className="converter-cloud-icon" aria-hidden="true">
              {isPattern ? (
                <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                </svg>
              ) : (
                <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                  <path d="M12 12v9" />
                  <path d="m16 16-4-4-4 4" />
                </svg>
              )}
            </div>
            <h2 className="converter-drop-title">
              {isPattern
                ? "Select your Pattern SVG to optimize"
                : "Select your Logo / Mascot SVG to optimize"}
            </h2>
            <p className="converter-drop-sub">or drop your files or folder here.</p>
            <div className="converter-drop-actions">
              <button type="button" className="primary" onClick={() => void handleSelectFiles()}>
                Select File
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void handleSelectFolder()}
              >
                Select Folder
              </button>
            </div>
          </>
        )}

        {!running && !summary && selectedFiles.length > 0 && (
          <>
            <div className="converter-cloud-icon" aria-hidden="true">
              <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 2 9 5-9 5-9-5 9-5Z" />
                <path d="m3 12 9 5 9-5" />
                <path d="m3 17 9 5 9-5" />
              </svg>
            </div>
            <h2 className="converter-drop-title">
              {selectedFiles.length === 1
                ? "1 SVG file ready"
                : `${selectedFiles.length} SVG files ready`}
            </h2>
            {selectedFiles.length === 1 && sourceLabel && (
              <p className="converter-file-name" title={sourceLabel}>
                {sourceLabel}
              </p>
            )}
            <div className="converter-output-pill">
              <span title={outputDir}>Save to: {outputDir}</span>
              <button type="button" onClick={() => void handleChangeOutput()}>
                Change
              </button>
            </div>
            <div className="converter-drop-actions">
              <button type="button" className="primary" onClick={() => void handleStart()}>
                Optimize {activeModeLabel} →
              </button>
              <button type="button" className="secondary" onClick={handleReset}>
                Clear
              </button>
            </div>
          </>
        )}

        {running && (
          <>
            <h2 className="converter-drop-title">
              Optimizing {activeModeLabel}… {percent}%
            </h2>
            <p
              className="converter-drop-sub converter-file-name"
              title={progress.fileName || undefined}
            >
              {progress.current} of {progress.total}
              {progress.fileName ? ` · ${progress.fileName}` : ""}
            </p>
            <div className="converter-bar-track converter-clean-bar">
              <div className="converter-bar-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="converter-drop-actions">
              <button type="button" className="danger" onClick={() => void handleCancel()}>
                Cancel
              </button>
            </div>
          </>
        )}

        {!running && summary && (
          <>
            {isTotalFailure ? (
              <div className="converter-fail-icon" aria-hidden="true">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="m15 9-6 6" />
                  <path d="m9 9 6 6" />
                </svg>
              </div>
            ) : isWarning ? (
              <div className="converter-warn-icon" aria-hidden="true">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
              </div>
            ) : (
              <div className="converter-done-icon" aria-hidden="true">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </div>
            )}
            <h2 className="converter-drop-title">
              {isTotalFailure
                ? "Optimization failed"
                : summary.cancelled
                ? "Optimization cancelled"
                : `${summary.succeeded} file${summary.succeeded === 1 ? "" : "s"} optimized (${summaryModeLabel})`}
            </h2>
            {summary.failed > 0 && (
              <p className="converter-drop-sub">{summary.failed} file(s) failed to optimize.</p>
            )}
            {summary.succeeded > 0 && (
              <div className="optimizer-stats-row">
                {typeof summary.nodes_before === "number" &&
                  typeof summary.nodes_after === "number" && (
                    <span className="optimizer-stat-chip">
                      Nodes: {summary.nodes_before.toLocaleString()} →{" "}
                      {summary.nodes_after.toLocaleString()}
                      {formatNodeDrop(summary.nodes_before, summary.nodes_after)}
                    </span>
                  )}
                {typeof summary.shapes_before === "number" &&
                  typeof summary.shapes_after === "number" && (
                    <span className="optimizer-stat-chip">
                      Objects: {summary.shapes_before.toLocaleString()} →{" "}
                      {summary.shapes_after.toLocaleString()}
                    </span>
                  )}
                {(summary.stray_removed ?? 0) > 0 && (
                  <span className="optimizer-stat-chip">
                    Stray: -{summary.stray_removed}
                  </span>
                )}
                {(summary.duplicates_removed ?? 0) > 0 && (
                  <span className="optimizer-stat-chip">
                    Dupes: -{summary.duplicates_removed}
                  </span>
                )}
                {(summary.open_paths_closed ?? 0) > 0 && (
                  <span className="optimizer-stat-chip">
                    Closed: {summary.open_paths_closed}
                  </span>
                )}
                {(summary.backgrounds_solidified ?? 0) > 0 && (
                  <span className="optimizer-stat-chip">
                    ✓ Solid BG
                  </span>
                )}
              </div>
            )}
            <div className="converter-drop-actions">
              {isTotalFailure ? (
                <>
                  <button type="button" className="primary" onClick={() => void handleStart()}>
                    Try Again
                  </button>
                  <button type="button" className="secondary" onClick={handleReset}>
                    Clear
                  </button>
                </>
              ) : (
                <>
                  {summary.succeeded > 0 && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void handleOpenOutput()}
                    >
                      Open Output Folder ↗
                    </button>
                  )}
                  {auditFiles.length > 0 && (
                    <button type="button" className="secondary" onClick={handleOpenAudit}>
                      Visual Audit
                    </button>
                  )}
                  <button type="button" className="secondary" onClick={handleReset}>
                    Optimize More
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {displayError && (
          <div className="converter-error converter-clean-error">{displayError}</div>
        )}
      </div>

      {auditOpen && auditFiles.length > 0 && (
        <div
          className="vector-audit-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Vector Visual Audit"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAuditOpen(false)
          }}
        >
          <div className="vector-audit-modal">
            <div className="vector-audit-header">
              <div className="vector-audit-title-group">
                <h3>Visual Audit</h3>
                <span className="optimizer-mode-badge">
                  {(summary?.mode ?? mode) === "pattern" ? "Pattern" : "Logo / Mascot"}
                </span>
                {auditFiles.length > 1 ? (
                  <div className="vector-audit-nav">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setAuditIndex((i) => (i > 0 ? i - 1 : auditFiles.length - 1))
                      }
                      aria-label="Previous file"
                    >
                      ‹
                    </button>
                    <select
                      value={auditIndex}
                      onChange={(e) => setAuditIndex(Number(e.target.value))}
                      aria-label="Select file to audit"
                    >
                      {auditFiles.map((f, idx) => (
                        <option key={f.input_path} value={idx}>
                          {idx + 1}/{auditFiles.length} · {f.file_name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setAuditIndex((i) => (i + 1) % auditFiles.length)}
                      aria-label="Next file"
                    >
                      ›
                    </button>
                  </div>
                ) : (
                  <span className="vector-audit-filename" title={auditFiles[0]?.file_name}>
                    {auditFiles[0]?.file_name}
                  </span>
                )}
              </div>

              <div className="vector-audit-controls">
                <div className="vector-audit-segmented">
                  <button
                    type="button"
                    className={auditView === "split" ? "is-active" : ""}
                    onClick={() => setAuditView("split")}
                  >
                    Before / After
                  </button>
                  <button
                    type="button"
                    className={auditView === "after" ? "is-active" : ""}
                    onClick={() => setAuditView("after")}
                  >
                    Optimized
                  </button>
                </div>
                <button
                  type="button"
                  className={`vector-audit-wire-btn ${wireframe ? "is-active" : ""}`}
                  onClick={() => setWireframe((w) => !w)}
                  title="Toggle Wireframe / Outline Mode (Ctrl+Y)"
                >
                  Wireframe
                </button>
                <button
                  type="button"
                  className="vector-audit-close"
                  onClick={() => setAuditOpen(false)}
                  aria-label="Close visual audit"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="vector-audit-body">
              {auditLoading && (
                <div className="vector-audit-loading">Rendering vector preview…</div>
              )}
              {!auditLoading && auditError && (
                <div className="converter-error">{auditError}</div>
              )}
              {!auditLoading && auditPreview && (
                <div
                  className={`vector-audit-stage ${
                    auditView === "split" ? "is-split" : "is-single"
                  }`}
                >
                  {auditView === "split" && (
                    <div className="vector-audit-pane">
                      <div className="vector-audit-pane-label">
                        <span>Before (Original SVG)</span>
                        <span>
                          {auditPreview.stats.nodes_before.toLocaleString()} nodes ·{" "}
                          {auditPreview.stats.shapes_before.toLocaleString()} objects
                        </span>
                      </div>
                      <div
                        className={`vector-audit-canvas ${wireframe ? "is-wireframe" : ""}`}
                        dangerouslySetInnerHTML={{ __html: auditPreview.before_svg }}
                      />
                    </div>
                  )}
                  <div className="vector-audit-pane">
                    <div className="vector-audit-pane-label">
                      <span>After (Optimized EPS)</span>
                      <span>
                        {auditPreview.stats.nodes_after.toLocaleString()} nodes
                        {formatNodeDrop(
                          auditPreview.stats.nodes_before,
                          auditPreview.stats.nodes_after
                        )}{" "}
                        · {auditPreview.stats.shapes_after.toLocaleString()} objects
                      </span>
                    </div>
                    <div
                      className={`vector-audit-canvas ${wireframe ? "is-wireframe" : ""}`}
                      dangerouslySetInnerHTML={{ __html: auditPreview.after_svg }}
                    />
                  </div>
                </div>
              )}
            </div>

            {auditPreview && (
              <div className="vector-audit-footer">
                <div className="vector-audit-badges">
                  <span className="vector-audit-badge is-ok">
                    ✓ {Math.round(auditPreview.stats.width_pt)}×
                    {Math.round(auditPreview.stats.height_pt)} pt
                  </span>
                  <span className="vector-audit-badge is-ok">✓ No Outlines</span>
                  <span className="vector-audit-badge is-ok">✓ Closed Paths</span>
                  <span className="vector-audit-badge is-ok">
                    ✓ {auditPreview.stats.colors_count} Colors
                  </span>
                  {auditPreview.stats.background_solidified && (
                    <span className="vector-audit-badge is-ok">✓ Solid BG</span>
                  )}
                  {auditPreview.stats.stray_removed > 0 && (
                    <span className="vector-audit-badge">
                      Stray: -{auditPreview.stats.stray_removed}
                    </span>
                  )}
                  {auditPreview.stats.duplicates_removed > 0 && (
                    <span className="vector-audit-badge">
                      Dupes: -{auditPreview.stats.duplicates_removed}
                    </span>
                  )}
                  {auditPreview.stats.open_paths_closed > 0 && (
                    <span className="vector-audit-badge">
                      Closed: {auditPreview.stats.open_paths_closed}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handleOpenOutput()}
                >
                  Open Output Folder ↗
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
