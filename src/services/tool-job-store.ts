// =============================================================================
// StockStudio Pro — Persistent Background Tool Job Store
//
// Keeps live state & Tauri event listeners alive across view switches for:
//   - SVG -> EPS Converter
//   - AI Image Upscaler
//   - AI Background Remover
// Switching to Dashboard, Google Flow, AIO Metadata, or Settings NEVER loses
// active download/processing progress or completion results.
// =============================================================================

import { useSyncExternalStore } from "react"
import { listen } from "@tauri-apps/api/event"

export interface VectorOptimizeStats {
  width_pt: number
  height_pt: number
  shapes_before: number
  shapes_after: number
  nodes_before: number
  nodes_after: number
  stray_removed: number
  duplicates_removed: number
  open_paths_closed: number
  colors_count: number
  background_solidified?: boolean
}

export interface OptimizedFileRecord {
  file_name: string
  input_path: string
  output_path: string
  stats: VectorOptimizeStats
}

export type VectorOptimizerMode = "logo-mascot" | "pattern"

export interface ConverterJobSummary {
  total: number
  succeeded: number
  failed: number
  skipped: number
  cancelled: boolean
  output_dir: string
  total_ms: number
  shapes_before?: number
  shapes_after?: number
  nodes_before?: number
  nodes_after?: number
  stray_removed?: number
  duplicates_removed?: number
  open_paths_closed?: number
  backgrounds_solidified?: number
  mode?: VectorOptimizerMode
  last_error?: string | null
  files?: OptimizedFileRecord[]
}

export interface ConverterJobState {
  selectedFiles: string[]
  sourceLabel: string
  inputDir: string | null
  outputDir: string
  mode: VectorOptimizerMode
  running: boolean
  progress: { current: number; total: number; fileName: string }
  summary: ConverterJobSummary | null
  error: string | null
}

export interface UpscalerJobSummary {
  total: number
  succeeded: number
  failed: number
  cancelled: boolean
  output_dir: string
  total_ms: number
}

export interface UpscalerJobState {
  selectedFiles: string[]
  singleFileName: string
  inputDir: string | null
  outputDir: string
  modelId: string
  running: boolean
  stage: "downloading" | "upscaling"
  progress: { current: number; total: number; percent: number; detail: string }
  summary: UpscalerJobSummary | null
  error: string | null
}

export interface BgRemoverJobSummary {
  total: number
  succeeded: number
  failed: number
  cancelled: boolean
  output_dir: string
  total_ms: number
  last_error?: string | null
}

export interface BgRemoverJobState {
  selectedFiles: string[]
  singleFileName: string
  inputDir: string | null
  outputDir: string
  modelId: string
  running: boolean
  stage: "downloading" | "loading" | "processing"
  progress: { current: number; total: number; percent: number; detail: string }
  summary: BgRemoverJobSummary | null
  error: string | null
}

export interface ToolJobsSnapshot {
  converter: ConverterJobState
  upscaler: UpscalerJobState
  bgRemover: BgRemoverJobState
}

let state: ToolJobsSnapshot = {
  converter: {
    selectedFiles: [],
    sourceLabel: "",
    inputDir: null,
    outputDir: "",
    mode: "logo-mascot",
    running: false,
    progress: { current: 0, total: 0, fileName: "" },
    summary: null,
    error: null,
  },
  upscaler: {
    selectedFiles: [],
    singleFileName: "",
    inputDir: null,
    outputDir: "",
    modelId: "auto",
    running: false,
    stage: "upscaling",
    progress: { current: 0, total: 0, percent: 0, detail: "" },
    summary: null,
    error: null,
  },
  bgRemover: {
    selectedFiles: [],
    singleFileName: "",
    inputDir: null,
    outputDir: "",
    modelId: "auto",
    running: false,
    stage: "processing",
    progress: { current: 0, total: 0, percent: 0, detail: "" },
    summary: null,
    error: null,
  },
}

const listeners = new Set<() => void>()
let initialized = false

function emitChange() {
  listeners.forEach((fn) => fn())
}

export function updateConverterJob(
  updater: (prev: ConverterJobState) => ConverterJobState
) {
  state = { ...state, converter: updater(state.converter) }
  emitChange()
}

export function updateUpscalerJob(
  updater: (prev: UpscalerJobState) => UpscalerJobState
) {
  state = { ...state, upscaler: updater(state.upscaler) }
  emitChange()
}

export function updateBgRemoverJob(
  updater: (prev: BgRemoverJobState) => BgRemoverJobState
) {
  state = { ...state, bgRemover: updater(state.bgRemover) }
  emitChange()
}

export function initToolJobListeners() {
  if (initialized) return
  initialized = true

  void listen<{
    current: number
    total: number
    file_name: string
    status: "ok" | "skipped" | "error"
    message: string
  }>("stockstudio-converter-progress", (event) => {
    const p = event.payload
    updateConverterJob((prev) => ({
      ...prev,
      running: true,
      progress: { current: p.current, total: p.total, fileName: p.file_name },
      error: p.status === "error" ? p.message : prev.error,
    }))
  })

  void listen<ConverterJobSummary>("stockstudio-converter-done", (event) => {
    const p = event.payload
    updateConverterJob((prev) => ({
      ...prev,
      running: false,
      summary: p,
      error: p.last_error ?? prev.error,
      outputDir: p.output_dir || prev.outputDir,
    }))
  })

  void listen<{
    stage: "downloading" | "upscaling"
    current: number
    total: number
    percent: number
    file_name: string
    status: "ok" | "error" | "info"
    message: string
  }>("stockstudio-upscaler-progress", (event) => {
    const p = event.payload
    updateUpscalerJob((prev) => ({
      ...prev,
      running: true,
      stage: p.stage,
      error: p.status === "error" ? p.message : prev.error,
      progress: {
        current: p.current,
        total: p.total,
        percent: p.percent,
        detail: p.stage === "downloading" ? p.message : p.file_name,
      },
    }))
  })

  void listen<UpscalerJobSummary>("stockstudio-upscaler-done", (event) => {
    const p = event.payload
    updateUpscalerJob((prev) => ({
      ...prev,
      running: false,
      summary: p,
      outputDir: p.output_dir || prev.outputDir,
    }))
  })

  void listen<{
    stage: "downloading" | "loading" | "processing"
    current: number
    total: number
    percent: number
    file_name: string
    status: "ok" | "error" | "info"
    message: string
  }>("stockstudio-bgremover-progress", (event) => {
    const p = event.payload
    updateBgRemoverJob((prev) => ({
      ...prev,
      running: true,
      stage: p.stage,
      error: p.status === "error" ? p.message : prev.error,
      progress: {
        current: p.current,
        total: p.total,
        percent: p.percent,
        detail: p.stage === "processing" ? p.file_name : p.message,
      },
    }))
  })

  void listen<BgRemoverJobSummary>("stockstudio-bgremover-done", (event) => {
    const p = event.payload
    updateBgRemoverJob((prev) => ({
      ...prev,
      running: false,
      summary: p,
      error: p.last_error ?? prev.error,
      outputDir: p.output_dir || prev.outputDir,
    }))
  })
}

export function useToolJobs(): ToolJobsSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
    () => state
  )
}
