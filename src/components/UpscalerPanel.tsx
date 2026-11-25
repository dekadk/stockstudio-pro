import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { updateUpscalerJob, useToolJobs } from "../services/tool-job-store"

interface UpscaleScanResult {
  files: string[]
  total: number
  default_output_dir: string | null
}

const MODEL_OPTIONS = [
  { id: "auto", label: "Auto (Recommended)" },
  { id: "realesrgan-x4plus", label: "Standard (Real-ESRGAN x4)" },
  { id: "4x_NMKD-Siax_200k", label: "4x NMKD Siax 200k" },
  { id: "4x_NMKD-Superscale-SP_178000_G", label: "4x NMKD Superscale SP" },
] as const

export default function UpscalerPanel() {
  const { upscaler: job } = useToolJobs()
  const {
    selectedFiles,
    singleFileName,
    inputDir,
    outputDir,
    modelId,
    running,
    stage,
    progress,
    summary,
    error,
  } = job
  const [isDragOver, setIsDragOver] = useState(false)
  const runningRef = useRef(running)
  runningRef.current = running

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
          updateUpscalerJob((prev) => ({ ...prev, error: null, summary: null }))
          void invoke<UpscaleScanResult>("resolve_dropped_upscaler_paths", {
            paths: droppedPaths,
            recursive: true,
          })
            .then((res) => {
              if (!mounted) return
              if (res.total === 0) {
                updateUpscalerJob((prev) => ({
                  ...prev,
                  error: "No supported images (.png, .jpg, .webp) found.",
                }))
                return
              }
              updateUpscalerJob((prev) => ({
                ...prev,
                selectedFiles: res.files,
                inputDir: null,
                singleFileName: res.total === 1 ? res.files[0].split(/[\\/]/).pop() || "" : "",
                outputDir: res.default_output_dir || prev.outputDir,
                error: null,
                summary: null,
              }))
            })
            .catch((err) => {
              if (!mounted) return
              updateUpscalerJob((prev) => ({
                ...prev,
                error: typeof err === "string" ? err : "Unable to read dropped images.",
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

  const handleSelectFiles = async () => {
    updateUpscalerJob((prev) => ({ ...prev, error: null, summary: null }))
    try {
      const res = await invoke<UpscaleScanResult>("pick_upscaler_files")
      if (res.total === 0) return
      updateUpscalerJob((prev) => ({
        ...prev,
        selectedFiles: res.files,
        inputDir: null,
        singleFileName: res.total === 1 ? res.files[0].split(/[\\/]/).pop() || "" : "",
        outputDir: res.default_output_dir || prev.outputDir,
      }))
    } catch (err) {
      updateUpscalerJob((prev) => ({
        ...prev,
        error: typeof err === "string" ? err : "Unable to select images.",
      }))
    }
  }

  const handleSelectFolder = async () => {
    updateUpscalerJob((prev) => ({ ...prev, error: null, summary: null }))
    try {
      const folder = await invoke<string | null>("pick_converter_folder", {
        title: "Select Folder with Images",
      })
      if (!folder) return
      const res = await invoke<UpscaleScanResult>("scan_upscaler_images", {
        inputDir: folder,
        recursive: true,
      })
      if (res.total === 0) {
        updateUpscalerJob((prev) => ({
          ...prev,
          error: "No supported images (.png, .jpg, .webp) found in that folder.",
        }))
        return
      }
      updateUpscalerJob((prev) => ({
        ...prev,
        selectedFiles: res.files,
        inputDir: folder,
        singleFileName: res.total === 1 ? res.files[0].split(/[\\/]/).pop() || "" : "",
        outputDir: res.default_output_dir || prev.outputDir,
      }))
    } catch (err) {
      updateUpscalerJob((prev) => ({
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
        updateUpscalerJob((prev) => ({ ...prev, outputDir: folder }))
      }
    } catch {}
  }

  const handleStart = async () => {
    if (selectedFiles.length === 0) return
    updateUpscalerJob((prev) => ({
      ...prev,
      error: null,
      summary: null,
      stage: "upscaling",
      progress: { current: 0, total: selectedFiles.length, percent: 0, detail: "" },
    }))
    try {
      const res = await invoke<{ total_files: number; output_dir: string }>(
        "start_upscale_batch",
        {
          request: {
            files: inputDir ? [] : selectedFiles,
            input_dir: inputDir,
            output_dir: outputDir,
            model_id: modelId,
            recursive: true,
            min_shortest_px: 3000,
          },
        }
      )
      updateUpscalerJob((prev) => ({
        ...prev,
        outputDir: res.output_dir,
        running: true,
      }))
    } catch (err) {
      updateUpscalerJob((prev) => ({
        ...prev,
        running: false,
        error: typeof err === "string" ? err : "Upscale failed to start.",
      }))
    }
  }

  const handleCancel = async () => {
    try {
      await invoke("cancel_upscale_batch")
    } catch {}
  }

  const handleReset = () => {
    updateUpscalerJob((prev) => ({
      ...prev,
      selectedFiles: [],
      singleFileName: "",
      inputDir: null,
      summary: null,
      error: null,
      progress: { current: 0, total: 0, percent: 0, detail: "" },
    }))
  }

  const handleOpenOutput = async () => {
    if (!outputDir.trim()) return
    try {
      await invoke("open_converter_folder", { path: outputDir.trim() })
    } catch (err) {
      updateUpscalerJob((prev) => ({
        ...prev,
        error: typeof err === "string" ? err : "Unable to open output folder.",
      }))
    }
  }

  const isTotalFailure = Boolean(
    summary && !summary.cancelled && summary.succeeded === 0 && summary.failed > 0
  )
  const isWarning = Boolean(
    summary && (summary.cancelled || (summary.succeeded > 0 && summary.failed > 0))
  )

  return (
    <div className="converter-clean-wrap">
      <div className={`converter-drop-card ${isDragOver ? "is-drag-over" : ""}`}>
        {!running && !summary && selectedFiles.length === 0 && (
          <>
            <div className="converter-cloud-icon" aria-hidden="true">
              <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </div>
            <h2 className="converter-drop-title">Select your image to upscale</h2>
            <p className="converter-drop-sub">or drop your images or folder here.</p>
            <div className="upscaler-model-row">
              <label htmlFor="upscaler-model-select">Model</label>
              <select
                id="upscaler-model-select"
                value={modelId}
                onChange={(e) =>
                  updateUpscalerJob((prev) => ({ ...prev, modelId: e.target.value }))
                }
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
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
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </div>
            <h2 className="converter-drop-title">
              {selectedFiles.length === 1
                ? "1 image ready"
                : `${selectedFiles.length} images ready`}
            </h2>
            {selectedFiles.length === 1 && singleFileName && (
              <p className="converter-file-name" title={singleFileName}>
                {singleFileName}
              </p>
            )}
            <div className="upscaler-model-row">
              <label htmlFor="upscaler-model-ready">Model</label>
              <select
                id="upscaler-model-ready"
                value={modelId}
                onChange={(e) =>
                  updateUpscalerJob((prev) => ({ ...prev, modelId: e.target.value }))
                }
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="converter-output-pill">
              <span title={outputDir}>Save to: {outputDir}</span>
              <button type="button" onClick={() => void handleChangeOutput()}>
                Change
              </button>
            </div>
            <div className="converter-drop-actions">
              <button type="button" className="primary" onClick={() => void handleStart()}>
                Upscale Images →
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
              {stage === "downloading"
                ? `Downloading AI Model… ${progress.percent}%`
                : `Upscaling… ${progress.percent}%`}
            </h2>
            <p className="converter-drop-sub converter-file-name" title={progress.detail || undefined}>
              {stage === "downloading"
                ? progress.detail || "Preparing AI engine (first time only)…"
                : `${progress.current} of ${progress.total}${
                    progress.detail ? ` · ${progress.detail}` : ""
                  }`}
            </p>
            <div className="converter-bar-track converter-clean-bar">
              <div className="converter-bar-fill" style={{ width: `${progress.percent}%` }} />
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
                ? "Upscaling failed"
                : summary.cancelled
                ? "Upscaling cancelled"
                : `${summary.succeeded} image${summary.succeeded === 1 ? "" : "s"} upscaled`}
            </h2>
            {summary.failed > 0 && (
              <p className="converter-drop-sub">{summary.failed} image(s) failed.</p>
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
                  <button type="button" className="secondary" onClick={handleReset}>
                    Upscale More
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {error && <div className="converter-error converter-clean-error">{error}</div>}
      </div>
    </div>
  )
}
