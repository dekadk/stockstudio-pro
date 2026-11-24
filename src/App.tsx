import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"
import packageJson from "../package.json"
import { loadAccounts, saveAccounts } from "./services/account-store"
import {
  normalizeRemoteStudioTools,
  STUDIO_TOOLS,
  type RemoteStudioToolPayload,
  type StudioToolDefinition,
} from "./config/tools"
import DownloadsPanel, { type DownloadRecord } from "./components/DownloadsPanel"
import brandLogoOrange from "./assets/branding/iconssoren.svg"
import brandLogoWhite from "./assets/branding/iconssputih.svg"

type Account = {
  id: string
  name: string
  email: string | null
  avatarUrl: string | null
  avatar: string
  favorite: boolean
  order: number
}
const LICENSE_PURCHASE_URL = ""
const TELEGRAM_CHANNEL_URL = ""
const APP_VERSION = packageJson.version
type LicenseEntitlements = {
  features: string[]
  max_accounts: number | null
  updates_until: string | null
  max_app_version: string | null
}
type LicenseState = {
  plan: string
  status: string
  expires_at: string | null
  lifetime: boolean
  last_validated_at: string
  device_id: string
  license_id?: string
  activation_id?: string
  key_prefix?: string
  license_type?: string
  billing_interval?: string
  current_period_start?: string | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean
  device_limit?: number
  devices_used?: number
  offline_grace_until?: string
  is_offline_grace?: boolean
  entitlements?: LicenseEntitlements
  lease_token?: string
}
type LicenseDeviceInfo = {
  activation_id: string
  device_id: string
  device_name: string
  platform: string
  os_version?: string | null
  app_version?: string
  status: string
  is_current_device: boolean
  activated_at: string
  last_validated_at: string
}
type LicenseDevicesResponse = {
  license_id: string
  key_prefix: string
  license_type: string
  billing_interval: string
  status: string
  device_limit: number
  devices_used: number
  devices: LicenseDeviceInfo[]
}
const licensePlanLabel = (plan: string) => ({ five_minutes: "5 Minutes", one_day: "1 Day", seven_days: "7 Days", thirty_days: "30 Days", pro_monthly: "30 Days", one_year: "1 Year", pro_yearly: "1 Year", lifetime: "Lifetime" }[plan] || plan)
const licenseTypeLabel = (state: LicenseState | null) => {
  if (!state) return "—"
  if (state.license_type === "perpetual" || state.lifetime) return "Perpetual (Lifetime)"
  if (state.license_type === "subscription") {
    const interval = state.billing_interval === "yearly" ? "Yearly" : state.billing_interval === "monthly" ? "Monthly" : "Recurring"
    return `Subscription (${interval})`
  }
  return "—"
}
const licenseStatusLabel = (status: string, isOfflineGrace?: boolean) => {
  const base = status ? status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable"
  return isOfflineGrace ? `${base} (Offline Grace)` : base
}
const licenseExpiryLabel = (state: LicenseState | null) =>
  state?.lifetime || state?.license_type === "perpetual"
    ? "Never (Lifetime)"
    : state?.expires_at
    ? new Date(state.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—"
const licenseDevicesLabel = (state: LicenseState | null) =>
  state && typeof state.device_limit === "number" && state.device_limit > 0
    ? `${state.devices_used ?? 1} / ${state.device_limit} Devices`
    : "—"
const plans = [
  {
    name: "30 Days",
    originalPrice: "Rp50,000",
    price: "Rp25,000",
    description: "StockStudio Pro access for 30 days",
  },
  {
    name: "1 Year",
    originalPrice: "Rp149.000",
    price: "Rp99.000",
    description: "StockStudio Pro access for 1 year",
  },
  {
    name: "Lifetime",
    originalPrice: "Rp249.000",
    price: "Rp149.000",
    description: "StockStudio Pro access with no expiration",
  },
]

export default function App() {
  const [licensed, setLicensed] = useState(false)
  const [licenseChecking, setLicenseChecking] = useState(true)
  const [licenseError, setLicenseError] = useState("")
  const [licenseRecoveryKind, setLicenseRecoveryKind] = useState<"connection" | "config" | null>(
    null
  )
  const [licenseState, setLicenseState] = useState<LicenseState | null>(null)
  const [deviceId, setDeviceId] = useState("")
  const [key, setKey] = useState("")
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [profile, setProfile] = useState<{
    name: string
    avatar: string | null
  }>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("stockstudio-profile") ||
          '{"name":"StockStudio Pro","avatar":null}'
      )
    } catch {
      return { name: "StockStudio Pro", avatar: null }
    }
  })
  const [query, setQuery] = useState("")
  const [studioTools, setStudioTools] = useState<StudioToolDefinition[]>(() => {
    try {
      const cached = localStorage.getItem("stockstudio-remote-tools")
      if (cached) {
        const parsed = JSON.parse(cached)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return normalizeRemoteStudioTools(parsed)
        }
      }
    } catch {}
    return [...STUDIO_TOOLS]
  })
  const [toolsSyncing, setToolsSyncing] = useState(false)
  const [view, setView] = useState<string>("accounts")
  const [downloads, setDownloads] = useState<DownloadRecord[]>([])
  const [active, setActive] = useState<Account | null>(null)
  const [activeToolId, setActiveToolId] = useState<string | null>(null)
  const [activeToolUrl, setActiveToolUrl] = useState<string | null>(null)
  const [activeToolName, setActiveToolName] = useState<string | null>(null)
  const [toolNotice, setToolNotice] = useState<{ text: string; isError?: boolean } | null>(null)
  const [toolAccountMap, setToolAccountMap] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("stockstudio-tool-accounts") || "{}")
    } catch {
      return {}
    }
  })
  const [liveSessionIds, setLiveSessionIds] = useState<string[]>([])
  const [liveSessionsByAccount, setLiveSessionsByAccount] = useState<
    Record<string, { account_id: string; tool_id: string; current_url: string; is_visible: boolean }>
  >({})
  const [fullView, setFullView] = useState(false)
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const [dialog, setDialog] = useState<Account | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [newAccountName, setNewAccountName] = useState("")
  const [addAccountError, setAddAccountError] = useState("")
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragPoint, setDragPoint] = useState({ x: 0, y: 0 })
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [dragTargetId, setDragTargetId] = useState<string | null>(null)
  const [dragPreviewIds, setDragPreviewIds] = useState<string[] | null>(null)
  const classifyLicenseRecovery = (message: string): "connection" | "config" | null => {
    const lower = message.toLowerCase()
    if (
      lower.includes("not configured") ||
      lower.includes("invalid license api url") ||
      lower.includes("unsupported license api url") ||
      lower.includes("requires https")
    ) {
      return "config"
    }
    if (
      lower.includes("revoked") ||
      lower.includes("suspended") ||
      lower.includes("license expired") ||
      lower.includes("device mismatch") ||
      lower.includes("invalid license") ||
      lower.includes("session expired") ||
      lower.includes("malformed license") ||
      lower.includes("system clock")
    ) {
      return null
    }
    return "connection"
  }
  const restoreLicenseSession = async () => {
    setLicenseChecking(true)
    setLicenseError("")
    try {
      const id = await invoke<string>("get_device_id")
      setDeviceId(id)
      const saved = await invoke<LicenseState | null>("get_license_state")
      if (!saved?.status) {
        setLicenseState(null)
        setLicenseRecoveryKind(null)
        return
      }
      setLicenseState(saved)
      const validated = await invoke<LicenseState>("validate_license")
      setLicenseState(validated)
      setLicenseRecoveryKind(null)
      setLicensed(true)
      await invoke("expand_main_window")
    } catch (error) {
      const message = typeof error === "string" ? error : "Server Unavailable"
      setLicenseError(message)
      const stillSaved = await invoke<LicenseState | null>("get_license_state").catch(() => null)
      if (stillSaved?.status) {
        setLicenseState(stillSaved)
        setLicenseRecoveryKind(classifyLicenseRecovery(message))
      } else {
        setLicenseState(null)
        setLicenseRecoveryKind(null)
      }
    } finally {
      setLicenseChecking(false)
    }
  }
  useEffect(() => {
    void restoreLicenseSession()
  }, [])
  const dragSourceRef = useRef<HTMLElement | null>(null)
  const dragPointerIdRef = useRef<number | null>(null)
  const dragSourceIdRef = useRef<string | null>(null)
  const dragTargetIdRef = useRef<string | null>(null)
  const dragInsertAfterRef = useRef(false)
  const handleRename = (a: Account) => {
    const n = prompt("Rename account", a.name)
    if (n)
      setAccounts(accounts.map((x) => (x.id === a.id ? { ...x, name: n } : x)))
    setMenu(null)
  }
  const handleDelete = (a: Account) => {
    setDialog(a)
    setMenu(null)
  }
  const confirmDelete = async () => {
    if (!dialog) return
    const removing = dialog
    try {
      const profileCleaned = await invoke<boolean>("remove_google_flow_account", {
        accountId: removing.id,
      })
      setAccounts((current) => current.filter((account) => account.id !== removing.id))
      if (active?.id === removing.id) {
        setActive(null)
        setFullView(false)
        setNavigatorOpen(false)
        setView("accounts")
      }
      if (!profileCleaned) console.warn("Account removed; profile cleanup is pending")
      setDialog(null)
    } catch (error) {
      console.error("Unable to remove account", error)
    }
  }
  const handleToggleFavorite = (a: Account) => {
    setAccounts(
      accounts.map((x) => (x.id === a.id ? { ...x, favorite: !x.favorite } : x))
    )
    setMenu(null)
  }
  const handleAddAccount = () => {
    setNewAccountName("")
    setAddAccountError("")
    setAddAccountOpen(true)
  }
  const createAccount = () => {
    const name = newAccountName.trim()
    if (!name) {
      setAddAccountError("Please enter an account name.")
      return
    }
    if (name.length > 80) {
      setAddAccountError("Account name must be 80 characters or fewer.")
      return
    }
    const a: Account = {
      id: crypto.randomUUID(),
      name,
      email: null,
      avatarUrl: "/google-flow.png",
      avatar: "NF",
      favorite: false,
      order: accounts.length,
    }
    setAccounts([...accounts, a])
    setAddAccountOpen(false)
  }
  const updateProfileAvatar = (avatar: string) => {
    const next = { ...profile, avatar }
    setProfile(next)
    localStorage.setItem("stockstudio-profile", JSON.stringify(next))
  }
  useEffect(() => {
    if (!licensed) return
    let mounted = true
    let unlistenUpdates: (() => void) | null = null
    let unlistenOpen: (() => void) | null = null
    void invoke<DownloadRecord[]>("list_downloads")
      .then((items) => {
        if (mounted && Array.isArray(items)) setDownloads(items)
      })
      .catch(() => {})
    void listen<DownloadRecord[]>("stockstudio-downloads-updated", (event) => {
      if (mounted && Array.isArray(event.payload)) setDownloads(event.payload)
    }).then((fn) => {
      if (mounted) unlistenUpdates = fn
      else fn()
    })
    void listen("stockstudio-open-downloads", () => {
      if (!mounted) return
      void invoke("close_google_flow")
      setFullView(false)
      setNavigatorOpen(false)
      setView("downloads")
    }).then((fn) => {
      if (mounted) unlistenOpen = fn
      else fn()
    })
    return () => {
      mounted = false
      if (unlistenUpdates) unlistenUpdates()
      if (unlistenOpen) unlistenOpen()
    }
  }, [licensed])
  const activeDownloadsCount = useMemo(
    () =>
      downloads.filter((d) => d.status === "preparing" || d.status === "downloading").length,
    [downloads]
  )
  const accountNameById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a.name])),
    [accounts]
  )
  useEffect(() => {
    if (!licensed || accountsLoaded) return
    void loadAccounts().then((saved) => setAccounts(saved as Account[])).finally(() => setAccountsLoaded(true))
  }, [licensed, accountsLoaded])
  useEffect(() => {
    if (licensed && accountsLoaded) void saveAccounts(accounts)
  }, [accounts, licensed, accountsLoaded])
  useEffect(() => {
    const activeStillExists = active !== null && accounts.some((account) => account.id === active.id)
    const isFlowWorkspace =
      view === "flow" || view === "background" || view === "mascot" || view === "pattern"
    if (view === "flow" && !activeStillExists) {
      setActive(null)
      setFullView(false)
      setNavigatorOpen(false)
      setView("accounts")
    } else if (!isFlowWorkspace && (fullView || navigatorOpen)) {
      setFullView(false)
      setNavigatorOpen(false)
    }
  }, [active, accounts, view, fullView, navigatorOpen])
  const favoriteCount = accounts.filter((a) => a.favorite).length
  const visible = useMemo(
    () =>
      accounts.filter(
        (a) =>
          (view !== "favorites" || a.favorite) &&
          `${a.name} ${a.email}`.toLowerCase().includes(query.toLowerCase())
      ),
    [accounts, query, view]
  )
  const displayed = useMemo(() => {
    if (!dragPreviewIds || view !== "accounts") return visible
    const byId = new Map(accounts.map((account) => [account.id, account]))
    return dragPreviewIds.map((id) => byId.get(id)).filter(Boolean) as Account[]
  }, [accounts, dragPreviewIds, view, visible])
  const finishPointerDrag = (commit: boolean) => {
    const sourceId = dragSourceIdRef.current
    const targetId = dragTargetIdRef.current
    if (commit && sourceId && targetId && sourceId !== targetId) {
      setAccounts((current) => {
        const sourceIndex = current.findIndex((a) => a.id === sourceId)
        const targetIndex = current.findIndex((a) => a.id === targetId)
        if (sourceIndex < 0 || targetIndex < 0) return current
        const next = [...current]
        const [source] = next.splice(sourceIndex, 1)
        const insertionIndex = next.findIndex((a) => a.id === targetId)
        next.splice(insertionIndex + (dragInsertAfterRef.current ? 1 : 0), 0, source)
        return next.map((a, index) => ({ ...a, order: index }))
      })
    }
    if (dragSourceRef.current && dragPointerIdRef.current !== null) {
      try { dragSourceRef.current.releasePointerCapture(dragPointerIdRef.current) } catch { /* already released */ }
    }
    dragSourceRef.current = null
    dragPointerIdRef.current = null
    dragSourceIdRef.current = null
    dragTargetIdRef.current = null
    setDraggingId(null)
    setDragTargetId(null)
    setDragPreviewIds(null)
  }
  useEffect(() => {
    const accountAtPoint = (x: number, y: number) => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-account-id]"))
        .filter((element) => element.dataset.accountId !== dragSourceIdRef.current)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      const hit = candidates.find(({ rect }) =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      )
      if (hit) return { id: hit.element.dataset.accountId || null, after: x > (hit.rect.left + hit.rect.right) / 2 }
      // Use the nearest card center when the pointer crosses a grid gap or a new row.
      const nearest = candidates
        .map(({ element, rect }) => ({
          element,
          rect,
          distance: Math.hypot((rect.left + rect.right) / 2 - x, (rect.top + rect.bottom) / 2 - y),
        }))
        .sort((a, b) => a.distance - b.distance)[0]
      if (!nearest) return null
      return { id: nearest.element.dataset.accountId || null, after: x > (nearest.rect.left + nearest.rect.right) / 2 }
    }
    const onMove = (event: PointerEvent) => {
      if (dragPointerIdRef.current !== event.pointerId) return
      event.preventDefault()
      setDragPoint({ x: event.clientX, y: event.clientY })
      const hit = accountAtPoint(event.clientX, event.clientY)
      const targetId = hit?.id || null
      dragInsertAfterRef.current = hit?.after || false
      dragTargetIdRef.current = targetId
      setDragTargetId(targetId)
      if (targetId) setDragPreviewIds((current) => {
        const ids = current || accounts.map((a) => a.id)
        const from = ids.indexOf(dragSourceIdRef.current || "")
        const to = ids.indexOf(targetId)
        if (from < 0 || to < 0 || from === to) return ids
        const next = [...ids]
        const [moved] = next.splice(from, 1)
        const targetIndex = next.indexOf(targetId)
        next.splice(targetIndex + (dragInsertAfterRef.current ? 1 : 0), 0, moved)
        return next
      })
    }
    const onUp = (event: PointerEvent) => {
      if (dragPointerIdRef.current === event.pointerId) finishPointerDrag(true)
    }
    const onCancel = (event: PointerEvent) => {
      if (dragPointerIdRef.current === event.pointerId) finishPointerDrag(false)
    }
    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
    }
  }, [accounts])
  const beginPointerDrag = (id: string, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || view !== "accounts" || query.trim()) return
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return
    const rect = event.currentTarget.getBoundingClientRect()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragSourceRef.current = event.currentTarget
    dragPointerIdRef.current = event.pointerId
    dragSourceIdRef.current = id
    dragTargetIdRef.current = null
    dragInsertAfterRef.current = false
    setDraggingId(id)
    setDragTargetId(null)
    setDragPreviewIds(accounts.map((a) => a.id))
    setDragOffset({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    setDragPoint({ x: event.clientX, y: event.clientY })
  }
  const activateLicense = async () => {
    if (!key.trim() || !deviceId) { setLicenseError("Invalid License"); return }
    setLicenseChecking(true); setLicenseError("")
    try { const activated=await invoke<LicenseState>("activate_license", { licenseKey: key }); setLicenseState(activated); setKey(""); setLicensed(true)
      await invoke("expand_main_window"); return
    } catch (error) { setLicenseError(typeof error === "string" && error.trim() ? error : "Server Unavailable") } finally { setLicenseChecking(false) }
  }
  const deactivateCurrentDevice = async () => {
    setLicenseError("")
    try {
      await invoke("deactivate_license", { reason: "user_deactivated_from_app" })
      setLicensed(false)
      setLicenseState(null)
      setView("accounts")
    } catch (error) {
      setLicenseError(typeof error === "string" && error.trim() ? error : "Unable to deactivate device")
    }
  }
  const assignToolAccount = (toolId: string, accountId: string) => {
    setToolAccountMap((prev) => {
      const next = { ...prev, [toolId]: accountId }
      try {
        localStorage.setItem("stockstudio-tool-accounts", JSON.stringify(next))
      } catch {
        // ignore storage quota errors
      }
      return next
    })
  }
  const refreshLiveSessions = async () => {
    try {
      const sessions = await invoke<
        Array<{ account_id: string; tool_id: string; current_url: string; is_visible: boolean }>
      >("list_google_flow_sessions")
      setLiveSessionIds(sessions.map((s) => s.account_id))
      const byAcc: Record<
        string,
        { account_id: string; tool_id: string; current_url: string; is_visible: boolean }
      > = {}
      for (const s of sessions) {
        byAcc[s.account_id] = s
      }
      setLiveSessionsByAccount(byAcc)
    } catch {
      // ignore when not in Tauri runtime
    }
  }
  const openLicensePurchase = () => {
    if (!LICENSE_PURCHASE_URL) return
    return invoke("open_external_url", { url: LICENSE_PURCHASE_URL })
  }
  const handleLaunchTool = async (tool: StudioToolDefinition, explicitAccountId?: string) => {
    setToolNotice(null)
    if (tool.launchMode === "external-browser") {
      try {
        await invoke("open_external_url", { url: tool.url })
        setToolNotice({ text: `${tool.name} opened in your default browser.` })
      } catch (error) {
        setToolNotice({
          text: typeof error === "string" ? error : `Unable to open ${tool.name}.`,
          isError: true,
        })
      }
      return
    }
    const preferredId = explicitAccountId ?? toolAccountMap[tool.id]
    const targetAccount =
      accounts.find((a) => a.id === preferredId) ??
      active ??
      accounts.find((a) => a.favorite) ??
      accounts[0] ??
      null
    if (!targetAccount) {
      setToolNotice({
        text: `Add a Google Flow account first to open ${tool.name}.`,
        isError: true,
      })
      setView("accounts")
      return
    }
    assignToolAccount(tool.id, targetAccount.id)
    setActive(targetAccount)
    setActiveToolId(tool.id)
    setActiveToolUrl(tool.url)
    setActiveToolName(tool.name)
    setView(`tool:${tool.id}`)
  }
  const syncStudioTools = async (showNotice = false) => {
    setToolsSyncing(true)
    try {
      const remote = await invoke<RemoteStudioToolPayload[]>("fetch_studio_tools")
      const normalized = normalizeRemoteStudioTools(remote)
      setStudioTools(normalized)
      try {
        localStorage.setItem("stockstudio-remote-tools", JSON.stringify(remote))
      } catch {}
      if (showNotice) {
        setToolNotice({
          text: `Synced ${normalized.length} studio tool${normalized.length === 1 ? "" : "s"} from server.`,
        })
      }
    } catch {
      if (showNotice) {
        setToolNotice({
          text: "Could not refresh tools from server; using cached tool list.",
          isError: true,
        })
      }
    } finally {
      setToolsSyncing(false)
    }
  }
  useEffect(() => {
    if (licensed) {
      void syncStudioTools(false)
    }
  }, [licensed])
  const openToolWorkspace = (tool: StudioToolDefinition, explicitAccountId?: string) => {
    const preferredId = explicitAccountId ?? toolAccountMap[tool.id]
    const targetAccount =
      accounts.find((a) => a.id === preferredId) ??
      active ??
      accounts.find((a) => a.favorite) ??
      accounts[0] ??
      null
    if (targetAccount) {
      assignToolAccount(tool.id, targetAccount.id)
      setActive(targetAccount)
    }
    setActiveToolId(tool.id)
    setActiveToolUrl(tool.url)
    setActiveToolName(tool.name)
    setView(`tool:${tool.id}`)
  }
  const handleSidebarNavigate = (nextView: string, closeActiveWebview = false) => {
    if (closeActiveWebview) {
      void invoke("close_google_flow")
    }
    setFullView(false)
    setNavigatorOpen(false)
    if (nextView.startsWith("tool:")) {
      const toolId = nextView.slice(5)
      const matched = studioTools.find((t) => t.id === toolId)
      if (matched) {
        openToolWorkspace(matched)
        return
      }
    }
    setView(nextView)
  }
  if (licenseChecking && !licensed)
    return <div className="gate"><div className="gate-card"><Brand /><h1>Checking your license</h1><p>Connecting securely to StockStudio Pro License Server…</p></div></div>
  if (!licensed && licenseRecoveryKind && licenseState)
    return (
      <div className="gate">
        <div className="gate-card">
          <Brand />
          <h1>
            {licenseRecoveryKind === "config"
              ? "License configuration required"
              : "Unable to verify license"}
          </h1>
          <p>
            {licenseRecoveryKind === "config"
              ? "Your license is already activated on this device, but StockStudio Pro is missing its license verification configuration."
              : "Your license is activated on this device, but StockStudio Pro could not reach the license server to refresh your session."}
          </p>
          {licenseError && <p className="dialog-error">{licenseError}</p>}
          <button
            className="primary wide"
            disabled={licenseChecking}
            onClick={() => void restoreLicenseSession()}
          >
            {licenseChecking ? "Retrying…" : "Retry Validation"}
          </button>
          <div className="link">
            <button
              type="button"
              className="secondary wide"
              onClick={() => setLicenseRecoveryKind(null)}
            >
              Enter a different license key
            </button>
          </div>
          <small>
            🔒 Your saved license credentials remain intact on this device.
          </small>
        </div>
      </div>
    )
  if (!licensed)
    return (
      <div className="gate">
        <div className="gate-card">
          <Brand />
          <h1>Enter your license</h1>
          <p>Activate StockStudio Pro with your license key.</p>
          <input
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Enter your license key"
            onKeyDown={(e) => e.key === "Enter" && activateLicense()}
          />
          <button className="primary wide" onClick={activateLicense}>
            {licenseChecking ? "Activating…" : "Activate StockStudio Pro →"}
          </button>
          {licenseError && <p className="dialog-error">{licenseError}</p>}
          <div className="link">
            Don’t have a license?{" "}
            {LICENSE_PURCHASE_URL ? (
              <a
                href={LICENSE_PURCHASE_URL}
                onClick={(e) => {
                  e.preventDefault()
                  void openLicensePurchase()
                }}
              >
                <u>Buy a license →</u>
              </a>
            ) : (
              <span className="link-disabled" aria-disabled="true">
                Buy a license →
              </span>
            )}
          </div>
          <small>
            🔒 Your Google account login is handled directly in Google Flow.
            <br />
            We never store your login details.
          </small>
        </div>
      </div>
    )
  if (view.startsWith("tool:")) {
    const currentToolId = view.slice(5)
    const currentTool = studioTools.find((t) => t.id === currentToolId) ?? null
    if (currentTool) {
      const preferredAccountId = toolAccountMap[currentTool.id]
      const selectedToolAccount =
        accounts.find((a) => a.id === preferredAccountId) ??
        active ??
        accounts.find((a) => a.favorite) ??
        accounts[0] ??
        null
      const toolLiveSession = selectedToolAccount
        ? liveSessionsByAccount[selectedToolAccount.id] ?? null
        : null
      const displayTitle =
        currentTool.id === "background"
          ? "Background Studio"
          : currentTool.id === "mascot"
          ? "Mascot Studio"
          : currentTool.id === "pattern"
          ? "Pattern Studio"
          : currentTool.name
      return (
        <div className={`app ${fullView ? "full" : ""}`}>
          {!fullView && (
            <Sidebar
              view={view}
              setView={(nextView: string) => handleSidebarNavigate(nextView, true)}
              profile={profile}
              licenseState={licenseState}
              activeDownloadsCount={activeDownloadsCount}
              studioTools={studioTools}
            />
          )}
          <main className="content flow-content">
            {selectedToolAccount ? (
              <FlowShell
                account={selectedToolAccount}
                accounts={accounts}
                liveSessionIds={liveSessionIds}
                toolId={currentTool.id}
                targetUrl={currentTool.url}
                toolName={displayTitle}
                isBackgroundStudio={currentTool.id === "background"}
                studioBadgeLabel={displayTitle.toUpperCase()}
                hasExistingBgSession={
                  currentTool.id === "background" &&
                  Boolean(toolLiveSession) &&
                  toolLiveSession?.tool_id === currentTool.id
                }
                hasExistingToolSession={
                  Boolean(toolLiveSession) && toolLiveSession?.tool_id === currentTool.id
                }
                fullView={fullView}
                navigatorOpen={navigatorOpen}
                onToggleFullView={() => {
                  setNavigatorOpen(false)
                  setFullView((current) => !current)
                }}
                onToggleNavigator={() => setNavigatorOpen((current) => !current)}
                onSelectAccount={(account) => {
                  setNavigatorOpen(false)
                  assignToolAccount(currentTool.id, account.id)
                  setActive(account)
                }}
                onAddAccount={() => {
                  void invoke("close_google_flow")
                  setFullView(false)
                  setNavigatorOpen(false)
                  setView("accounts")
                  handleAddAccount()
                }}
                activeDownloadsCount={activeDownloadsCount}
                onOpenDownloads={() => {
                  void invoke("close_google_flow")
                  setFullView(false)
                  setNavigatorOpen(false)
                  setView("downloads")
                }}
                onSessionUpdated={() => void refreshLiveSessions()}
                onBack={() => {
                  void invoke("close_google_flow")
                  setFullView(false)
                  setNavigatorOpen(false)
                  setView("accounts")
                  void refreshLiveSessions()
                }}
              />
            ) : (
              <div className="bg-empty-workspace">
                <div className="eyebrow">STOCKSTUDIO PRO / {displayTitle.toUpperCase()}</div>
                <h1>{displayTitle}</h1>
                <p>
                  Add at least one Google account on the Dashboard to launch {displayTitle} in an
                  isolated WebView2 session inside StockStudio Pro.
                </p>
                <div className="dialog-actions">
                  <button className="secondary" onClick={() => setView("accounts")}>
                    ‹ Back to Dashboard
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setView("accounts")
                      handleAddAccount()
                    }}
                  >
                    ＋ Add Account
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>
      )
    }
  }
  if (view === "flow" && active)
    return (
      <div className={`app ${fullView ? "full" : ""}`}>
        {!fullView && (
          <Sidebar
            view="flow"
            setView={(nextView: string) => handleSidebarNavigate(nextView, true)}
            profile={profile}
            licenseState={licenseState}
            activeDownloadsCount={activeDownloadsCount}
            studioTools={studioTools}
          />
        )}
        <main className="content flow-content">
          <FlowShell
            account={active}
            accounts={accounts}
            liveSessionIds={liveSessionIds}
            toolId={activeToolId}
            targetUrl={activeToolUrl}
            toolName={activeToolName}
            fullView={fullView}
            navigatorOpen={navigatorOpen}
            onToggleFullView={() => {
              setNavigatorOpen(false)
              setFullView((current) => !current)
            }}
            onToggleNavigator={() => setNavigatorOpen((current) => !current)}
            onSelectAccount={(account) => {
              setNavigatorOpen(false)
              if (activeToolId) {
                assignToolAccount(activeToolId, account.id)
              }
              if (account.id !== active.id) setActive(account)
            }}
            onAddAccount={() => {
              void invoke("close_google_flow")
              setFullView(false)
              setNavigatorOpen(false)
              setView("accounts")
              handleAddAccount()
            }}
            activeDownloadsCount={activeDownloadsCount}
            onOpenDownloads={() => {
              void invoke("close_google_flow")
              setFullView(false)
              setNavigatorOpen(false)
              setView("downloads")
            }}
            onSessionUpdated={() => void refreshLiveSessions()}
            onBack={() => {
              void invoke("close_google_flow")
              setFullView(false)
              setNavigatorOpen(false)
              setActiveToolId(null)
              setActiveToolUrl(null)
              setActiveToolName(null)
              setView("accounts")
              void refreshLiveSessions()
            }}
          />
        </main>
      </div>
    )
  return (
    <div className="app">
      <Sidebar
        view={view}
        setView={(nextView: string) => handleSidebarNavigate(nextView, false)}
        profile={profile}
        licenseState={licenseState}
        activeDownloadsCount={activeDownloadsCount}
        studioTools={studioTools}
      />
      <main className="content">
        <header>
          <div>
            <div className="eyebrow">
              STOCKSTUDIO PRO /{" "}
              {view === "settings"
                ? "SETTINGS"
                : view === "tools"
                ? "STUDIO TOOLS"
                : view === "favorites"
                ? "FAVORITES"
                : view.toUpperCase()}
            </div>
            <h1>
              {view === "settings"
                ? "Settings"
                : view === "downloads"
                ? "Downloads"
                : view === "tools"
                ? "Studio Tools"
                : view === "favorites"
                ? "Favorite Accounts"
                : view === "license"
                ? "License"
                : view === "updates"
                ? "Updates"
                : view === "info"
                ? "How to Use StockStudio Pro"
                : "Dashboard & Accounts"}
            </h1>
            <p>
              {view === "settings"
                ? "Keep StockStudio Pro personal, private, and ready to use."
                : view === "downloads"
                ? "Track active and completed Google Flow downloads and reveal saved files in Windows Explorer."
                : view === "tools"
                ? "Launch registered Google Flow generators and metadata tools from one workspace."
                : view === "favorites"
                ? "Your favorite Google Flow accounts in one place."
                : view === "license"
                ? "Choose the StockStudio Pro license that fits your needs."
                : view === "updates"
                ? "Keep StockStudio Pro up to date with the latest version."
                : view === "info"
                ? "A quick guide to managing your Google Flow accounts."
                : "Launch Studio Tools and manage your Google Flow accounts in one dark workspace."}
            </p>
            {view === "accounts" && (
              <div className="account-count">
                {accounts.length}{" "}
                {accounts.length === 1 ? "Account" : "Accounts"}
              </div>
            )}
            {view === "favorites" && (
              <div className="account-count">{favoriteCount} Favorites</div>
            )}
          </div>
          {view === "accounts" && (
            <div className="header-actions">
              <div className="search">
                ⌕
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search accounts..."
                />
              </div>
              <button
                type="button"
                className="secondary header-downloads-btn"
                title="Download History"
                aria-label="Download History"
                onClick={() => setView("downloads")}
              >
                ↓{activeDownloadsCount > 0 ? ` ${activeDownloadsCount}` : ""}
              </button>
              <button className="primary" onClick={handleAddAccount}>
                ＋ Add Account
              </button>
            </div>
          )}
        </header>
        {toolNotice && (
          <div className={`notice-banner ${toolNotice.isError ? "is-error" : ""}`} role="status">
            <span>{toolNotice.text}</span>
            <button className="secondary" onClick={() => setToolNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {view === "settings" ? (
          <Settings profile={profile} onAvatarChange={updateProfileAvatar} />
        ) : view === "downloads" ? (
          <DownloadsPanel
            downloads={downloads}
            accountNameById={accountNameById}
            onUpdated={setDownloads}
          />
        ) : view === "tools" ? (
          <StudioToolsSection
            tools={studioTools}
            syncing={toolsSyncing}
            onSync={() => void syncStudioTools(true)}
            accounts={accounts}
            toolAccountMap={toolAccountMap}
            liveSessionIds={liveSessionIds}
            onSelectToolAccount={assignToolAccount}
            onLaunch={(tool, accountId) => void handleLaunchTool(tool, accountId)}
          />
        ) : view === "license" ? (
          <LicensePage
            licenseState={licenseState}
            onBuy={() => void openLicensePurchase()}
            onDeactivate={() => void deactivateCurrentDevice()}
          />
        ) : view === "updates" ? (
          <UpdatesPage />
        ) : view === "info" ? (
          <InfoPage />
        ) : (
          <>
            {view === "accounts" && (
              <StudioToolsSection
                tools={studioTools}
                syncing={toolsSyncing}
                onSync={() => void syncStudioTools(true)}
                accounts={accounts}
                toolAccountMap={toolAccountMap}
                liveSessionIds={liveSessionIds}
                onSelectToolAccount={assignToolAccount}
                onLaunch={(tool, accountId) => void handleLaunchTool(tool, accountId)}
              />
            )}
            {view === "accounts" && (
              <div className="section-header">
                <div>
                  <h2>Google Flow Accounts</h2>
                  <p>Open, reorder, or manage your isolated Google Flow sessions.</p>
                </div>
              </div>
            )}
            <div className="grid">
              {displayed.map((a) => (
                <Card
                  key={a.id}
                  a={a}
                  menuOpen={menu === a.id}
                  onMenu={() => setMenu(menu === a.id ? null : a.id)}
                  onOpen={() => {
                    setActive(a)
                    setActiveToolId(null)
                    setActiveToolUrl(null)
                    setActiveToolName(null)
                    setView("flow")
                  }}
                  onFavorite={() => handleToggleFavorite(a)}
                  onDelete={() => handleDelete(a)}
                  onRename={() => handleRename(a)}
                  dragEnabled={view === "accounts" && !query.trim()}
                  isDragging={draggingId === a.id}
                  isDropTarget={dragTargetId === a.id}
                  onPointerDown={(event) => beginPointerDrag(a.id, event)}
                />
              ))}
              {view === "accounts" && (
                <AddAccountCard onAdd={handleAddAccount} />
              )}
            </div>
            {draggingId && <DragPreview account={accounts.find((a) => a.id === draggingId) || null} point={dragPoint} offset={dragOffset} />}
          </>
        )}
        {dialog && (
          <div className="overlay">
            <div className="dialog">
              <h2>Delete {dialog.name}?</h2>
              <p>
                This removes the account card from StockStudio Pro. Your Google
                account is not affected.
              </p>
              <div className="dialog-actions">
                <button className="secondary" onClick={() => setDialog(null)}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => void confirmDelete()}
                >
                  Delete account
                </button>
              </div>
            </div>
          </div>
        )}
        {addAccountOpen && (
          <div className="overlay">
            <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-account-title">
              <h2 id="add-account-title">Add Account</h2>
              <p>Enter a name for this Google Flow account.</p>
              <input
                autoFocus
                value={newAccountName}
                onChange={(event) => {
                  setNewAccountName(event.target.value)
                  setAddAccountError("")
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") createAccount()
                }}
                placeholder="Enter account name"
                maxLength={80}
              />
              {addAccountError && <p className="dialog-error">{addAccountError}</p>}
              <div className="dialog-actions">
                <button className="secondary" onClick={() => setAddAccountOpen(false)}>
                  Cancel
                </button>
                <button className="primary" onClick={createAccount}>
                  Add Account
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
function Brand() {
  return (
    <div className="brand">
      <img className="brand-image" src={brandLogoOrange} alt="StockStudio Pro logo" />
      <span>STOCKSTUDIO PRO</span>
    </div>
  )
}
function Sidebar({
  view,
  setView,
  profile,
  licenseState,
  activeDownloadsCount = 0,
  studioTools = [],
}: {
  view: string
  setView: (v: any) => void
  profile: { name: string; avatar: string | null }
  licenseState: LicenseState | null
  activeDownloadsCount?: number
  studioTools?: StudioToolDefinition[]
}) {
  const getToolSidebarIcon = (tool: StudioToolDefinition): SidebarIconName => {
    if (tool.icon) return tool.icon
    if (tool.id === "background") return "background"
    if (tool.id === "mascot") return "mascot"
    if (tool.id === "pattern") return "pattern"
    if (tool.id === "aio-metadata") return "tag"
    if (tool.badge === "GEMINI") return "sparkles"
    return "wand"
  }
  const getToolSidebarLabel = (tool: StudioToolDefinition) => {
    if (tool.id === "background") return "Background Studio"
    if (tool.id === "mascot") return "Mascot Studio"
    if (tool.id === "pattern") return "Pattern Studio"
    return tool.name
  }
  return (
    <aside>
      <Brand />
      <div className="side-label">WORKSPACE</div>
      <button
        className={view === "accounts" ? "active" : ""}
        onClick={() => setView("accounts")}
      >
        <SidebarIcon name="accounts" /> <span>Dashboard</span>
      </button>
      {studioTools.map((tool) => {
        const routeKey = `tool:${tool.id}`
        return (
          <button
            key={tool.id}
            className={view === routeKey ? "active" : ""}
            onClick={() => setView(routeKey)}
          >
            <SidebarIcon name={getToolSidebarIcon(tool)} />{" "}
            <span>{getToolSidebarLabel(tool)}</span>
          </button>
        )
      })}
      <button
        className={view === "tools" ? "active" : ""}
        onClick={() => setView("tools")}
      >
        <SidebarIcon name="tools" /> <span>Studio Tools</span>
      </button>
      <button
        className={view === "favorites" ? "active" : ""}
        onClick={() => setView("favorites")}
      >
        <SidebarIcon name="favorites" /> <span>Favorites</span>
      </button>
      <div className="rule" />
      <div className="side-label">GENERAL</div>
      <button
        className={view === "license" ? "active" : ""}
        onClick={() => setView("license")}
      >
        <SidebarIcon name="license" /> <span>License</span>
      </button>
      <button
        className={view === "updates" ? "active" : ""}
        onClick={() => setView("updates")}
      >
        <SidebarIcon name="updates" /> <span>Updates</span>
      </button>
      <button
        className={view === "info" ? "active" : ""}
        onClick={() => setView("info")}
      >
        <SidebarIcon name="info" /> <span>Info</span>
      </button>
      <button
        className={view === "settings" ? "active" : ""}
        onClick={() => setView("settings")}
      >
        <SidebarIcon name="settings" /> <span>Settings</span>
      </button>
      <div className="side-bottom">
        <div className="avatar">
          {profile.avatar ? (
            <img src={profile.avatar} alt="StockStudio Pro profile" />
          ) : (
            <img className="brand-avatar-fallback" src={brandLogoWhite} alt="StockStudio Pro" />
          )}
        </div>
        <div>
          <div className="side-license-info">
            <small>
              <span>License {licenseState ? licenseStatusLabel(licenseState.status, licenseState.is_offline_grace) : "Unavailable"}: <b>{licenseState ? licensePlanLabel(licenseState.plan) : "—"}</b></span>
              <span>Valid Until: <b>{licenseExpiryLabel(licenseState)}</b></span>
            </small>
          </div>
        </div>
      </div>
    </aside>
  )
}
type SidebarIconName =
  | "accounts"
  | "background"
  | "mascot"
  | "pattern"
  | "aio-metadata"
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
  | "brush"
  | "pen"
  | "scissors"
  | "eraser"
  | "crop"
  | "maximize"
  | "box"
  | "shapes"
  | "sticker"
  | "frame"
  | "shirt"
  | "gift"
  | "leaf"
  | "flame"
  | "star"
  | "heart"
  | "crown"
  | "zap"
  | "cpu"
  | "brain"
  | "file-text"
  | "table"
  | "music"
  | "globe"
  | "downloads"
  | "tools"
  | "favorites"
  | "license"
  | "updates"
  | "info"
  | "settings"

function SidebarIcon({ name }: { name: SidebarIconName }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true }
  const paths: Record<SidebarIconName, JSX.Element> = {
    accounts: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    background: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-6 6-2-2-5 5" /></>,
    mascot: <><circle cx="12" cy="13" r="7" /><path d="M9 12h.01M15 12h.01" /><path d="M9.5 15.5a3.5 3.5 0 0 0 5 0" /><path d="M8 7 6.5 4.5M16 7l1.5-2.5" /></>,
    pattern: <><path d="M12 3 16.5 7.5 12 12 7.5 7.5 12 3Z" /><path d="M12 12 16.5 16.5 12 21 7.5 16.5 12 12Z" /><path d="M3 12 7.5 7.5 12 12 7.5 16.5 3 12Z" /><path d="M12 12 16.5 7.5 21 12 16.5 16.5 12 12Z" /></>,
    "aio-metadata": <><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" /><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none" /></>,
    tag: <><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" /><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none" /></>,
    sparkles: <><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z" /><path d="M5 3v4M3 5h4" /></>,
    wand: <><path d="m15 4 5 5L8 21l-5-5L15 4Z" /><path d="m12 7 5 5" /><path d="M5 3v3M3.5 4.5h3" /></>,
    palette: <><circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none" /><circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none" /><circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none" /><circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none" /><path d="M12 2a10 10 0 1 0 0 20 2 2 0 0 0 2-2v-.5a1.5 1.5 0 0 1 1.5-1.5H17a5 5 0 0 0 5-5c0-5.5-4.5-10-10-10Z" /></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
    camera: <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3.2" /></>,
    video: <><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3v-4Z" /></>,
    type: <><path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>,
    bot: <><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2M20 14h2M9 13v2M15 13v2" /></>,
    rocket: <><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z" /><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></>,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></>,
    wrench: <><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" /></>,
    brush: <><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02Z" /></>,
    pen: <><path d="m12 19 7-7 3 3-7 7-3-3Z" /><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5Z" /><path d="m2 2 7.586 7.586" /><circle cx="11" cy="11" r="2" /></>,
    scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" /></>,
    eraser: <><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" /><path d="M22 21H7M5 11l9 9" /></>,
    crop: <><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></>,
    maximize: <><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></>,
    box: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></>,
    shapes: <><path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" /><rect x="3" y="14" width="7" height="7" rx="1" /><circle cx="17.5" cy="17.5" r="3.5" /></>,
    sticker: <><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" /><path d="M14 3v4a2 2 0 0 0 2 2h4M8 13h.01M16 13h.01M10 16s.8 1 2 1c1.3 0 2-1 2-1" /></>,
    frame: <><path d="M22 6H2M22 18H2M6 2v20M18 2v20" /></>,
    shirt: <><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23Z" /></>,
    gift: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" /></>,
    leaf: <><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" /><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" /></>,
    flame: <><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5Z" /></>,
    star: <path d="m12 4 2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-4 5.6-.8L12 4Z" />,
    heart: <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />,
    crown: <><path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7Zm3 16h14" /></>,
    zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />,
    cpu: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></>,
    brain: <><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.54Z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.54Z" /></>,
    "file-text": <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" /></>,
    table: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></>,
    music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18" /></>,
    downloads: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
    tools: <><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" /></>,
    favorites: <path d="m12 4 2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-4 5.6-.8L12 4Z" />,
    license: <><path d="M7 4h10l2 3v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7l2-3Z" /><path d="M9 4v4h6V4M9 13h6M9 17h4" /></>,
    updates: <><path d="M20 11a8 8 0 0 0-14.7-4L4 9" /><path d="M4 4v5h5M4 13a8 8 0 0 0 14.7 4L20 15" /><path d="M20 20v-5h-5" /></>,
    info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="1.8" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.8" fill="currentColor" stroke="none" /><circle cx="10" cy="18" r="1.8" fill="currentColor" stroke="none" /></>,
  }
  return <svg className="sidebar-icon" {...common}>{paths[name] || paths.sparkles}</svg>
}
function StudioToolsSection({
  tools,
  syncing,
  onSync,
  accounts,
  toolAccountMap,
  liveSessionIds,
  onSelectToolAccount,
  onLaunch,
}: {
  tools: StudioToolDefinition[]
  syncing?: boolean
  onSync?: () => void
  accounts: Account[]
  toolAccountMap: Record<string, string>
  liveSessionIds: string[]
  onSelectToolAccount: (toolId: string, accountId: string) => void
  onLaunch: (tool: StudioToolDefinition, accountId?: string) => void
}) {
  return (
    <section className="tools-section" aria-label="Studio Tools">
      <div className="section-header">
        <div>
          <h2>Studio Tools</h2>
          <p>Assign isolated Google Flow accounts per tool and run multiple sessions concurrently.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {onSync && (
            <button
              type="button"
              className="secondary"
              disabled={syncing}
              onClick={onSync}
              title="Refresh studio tool links from server"
              style={{ padding: "5px 10px", fontSize: "12px" }}
            >
              {syncing ? "Syncing…" : "↻ Sync Tools"}
            </button>
          )}
          <span className="badge badge-accent">
            {liveSessionIds.length > 0
              ? `${liveSessionIds.length} LIVE SESSION${liveSessionIds.length === 1 ? "" : "S"}`
              : `${tools.length} TOOLS`}
          </span>
        </div>
      </div>
      <div className="tools-grid">
        {tools.map((tool) => {
          const isExternal = tool.launchMode === "external-browser"
          const needsAccount = !isExternal && accounts.length === 0
          const assignedId =
            (toolAccountMap[tool.id] &&
              accounts.some((a) => a.id === toolAccountMap[tool.id]) &&
              toolAccountMap[tool.id]) ||
            accounts[0]?.id ||
            ""
          const isAssignedLive =
            !isExternal && Boolean(assignedId) && liveSessionIds.includes(assignedId)
          return (
            <article className="tool-card" key={tool.id}>
              <div className="tool-card-top">
                <h3>{tool.name}</h3>
                <span className={`badge ${isExternal ? "badge-info" : isAssignedLive ? "" : "badge-accent"}`}>
                  {isExternal ? tool.badge : isAssignedLive ? "LIVE" : tool.badge}
                </span>
              </div>
              <p>{tool.description}</p>
              {!isExternal && accounts.length > 0 && (
                <label className="tool-account-picker">
                  <span>Account Session</span>
                  <select
                    aria-label={`Select account for ${tool.name}`}
                    value={assignedId}
                    onChange={(e) => onSelectToolAccount(tool.id, e.target.value)}
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name}
                        {liveSessionIds.includes(acc.id) ? " (Active)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="tool-card-actions">
                <span className="tool-account-hint">
                  {isExternal
                    ? "Opens in default browser"
                    : needsAccount
                    ? "Add an account to launch"
                    : isAssignedLive
                    ? "Session running in background"
                    : "Isolated WebView2 profile"}
                </span>
                <button
                  className={isExternal ? "secondary" : "primary"}
                  disabled={needsAccount}
                  onClick={() => onLaunch(tool, isExternal ? undefined : assignedId)}
                >
                  {isExternal ? "Open Browser ↗" : isAssignedLive ? "Resume →" : "Launch →"}
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
function LicensePage({
  licenseState,
  onBuy,
  onDeactivate,
}: {
  licenseState: LicenseState | null
  onBuy: () => void
  onDeactivate: () => void
}) {
  const [devicesInfo, setDevicesInfo] = useState<LicenseDevicesResponse | null>(null)
  const [devicesError, setDevicesError] = useState("")
  const [busyDeviceAction, setBusyDeviceAction] = useState(false)

  const refreshDevices = async () => {
    setDevicesError("")
    try {
      const result = await invoke<LicenseDevicesResponse>("list_license_devices")
      setDevicesInfo(result)
    } catch (error) {
      setDevicesError(typeof error === "string" ? error : "Unable to load devices")
    }
  }

  useEffect(() => {
    if (licenseState?.activation_id) {
      void refreshDevices()
    }
  }, [licenseState?.activation_id])

  const handleDeactivateThisDevice = async () => {
    setBusyDeviceAction(true)
    try {
      await onDeactivate()
    } finally {
      setBusyDeviceAction(false)
    }
  }

  return (
    <div className="feature-page">
      <div className="plan-grid">
        {plans.map((plan) => (
          <section className="plan-card" key={plan.name}>
            <div className="eyebrow">{plan.name.toUpperCase()}</div>
            <s>{plan.originalPrice}</s>
            <strong>{plan.price}</strong>
            <p>{plan.description}.</p>
            <button className="primary" disabled={!LICENSE_PURCHASE_URL} onClick={onBuy}>
              Buy License
            </button>
          </section>
        ))}
      </div>
      <section className="license-info">
        <div className="eyebrow">CURRENT LICENSE</div>
        <h2>Current License</h2>
        <div className="license-stats">
          <span>
            <b>Plan</b>
            {licenseState ? licensePlanLabel(licenseState.plan) : "—"}
          </span>
          <span>
            <b>Type</b>
            {licenseTypeLabel(licenseState)}
          </span>
          <span>
            <b>Status</b>
            {licenseState ? licenseStatusLabel(licenseState.status, licenseState.is_offline_grace) : "Unavailable"}
          </span>
          <span>
            <b>Valid Until</b>
            {licenseExpiryLabel(licenseState)}
          </span>
          <span>
            <b>Active Devices</b>
            {devicesInfo
              ? `${devicesInfo.devices_used} / ${devicesInfo.device_limit} Devices`
              : licenseDevicesLabel(licenseState)}
          </span>
        </div>
        {devicesError && <p className="dialog-error">{devicesError}</p>}
        {licenseState?.activation_id && (
          <div className="dialog-actions">
            <button className="secondary" disabled={busyDeviceAction} onClick={() => void refreshDevices()}>
              Refresh Devices
            </button>
            <button className="danger" disabled={busyDeviceAction} onClick={() => void handleDeactivateThisDevice()}>
              {busyDeviceAction ? "Deactivating…" : "Deactivate This Device"}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
function UpdatesPage() {
  type UpdatePhase = "checking" | "upToDate" | "available" | "downloading" | "installing" | "relaunching" | "error"
  const [phase, setPhase] = useState<UpdatePhase>("checking")
  const [currentVersion, setCurrentVersion] = useState("—")
  const [latestVersion, setLatestVersion] = useState("—")
  const [releaseNotes, setReleaseNotes] = useState<string[]>([])
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  const [downloaded, setDownloaded] = useState(0)
  const [contentLength, setContentLength] = useState<number | null>(null)
  const checking = useRef(false)

  const checkForUpdates = async () => {
    if (checking.current) return
    checking.current = true
    setPhase("checking")
    try {
      const installedVersion = await getVersion()
      setCurrentVersion(installedVersion)
      const update = await check()
      setAvailableUpdate(update)
      if (!update) {
        setLatestVersion(installedVersion)
        setReleaseNotes([])
        setPhase("upToDate")
        return
      }
      setLatestVersion(update.version)
      setReleaseNotes(update.body ? update.body.split(/\r?\n/).filter(Boolean) : [])
      setPhase("available")
    } catch {
      setAvailableUpdate(null)
      setPhase("error")
    } finally {
      checking.current = false
    }
  }

  useEffect(() => {
    void checkForUpdates()
  }, [])

  const installUpdate = async () => {
    if (!availableUpdate) return
    setDownloaded(0)
    setContentLength(null)
    setPhase("downloading")
    try {
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setContentLength(event.data.contentLength ?? null)
          setDownloaded(0)
        } else if (event.event === "Progress") {
          setDownloaded((value) => value + event.data.chunkLength)
        } else if (event.event === "Finished") {
          setPhase("installing")
        }
      })
      setPhase("relaunching")
      await relaunch()
    } catch {
      setPhase("error")
    }
  }

  const status: Record<UpdatePhase, string> = {
    checking: "Checking for updates",
    upToDate: "Up to date",
    available: "Update available",
    downloading: "Downloading",
    installing: "Installing",
    relaunching: "Relaunching",
    error: "Update unavailable",
  }
  const progress = contentLength ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null
  const busy = phase === "checking" || phase === "downloading" || phase === "installing" || phase === "relaunching"

  return (
    <div className="feature-page">
      <section className="info-card">
        <div>
          <div className="eyebrow">CURRENT VERSION</div>
          <h2>{currentVersion}</h2>
        </div>
        <div>
          <div className="eyebrow">LATEST VERSION</div>
          <h2>{latestVersion}</h2>
        </div>
        <span className="badge">{status[phase]}</span>
        <button className="primary" disabled={busy || phase === "upToDate" || !availableUpdate} onClick={() => void installUpdate()}>
          {phase === "downloading" ? "Downloading…" : phase === "installing" ? "Installing…" : phase === "relaunching" ? "Relaunching…" : "Update Now"}
        </button>
        {phase === "error" && <button className="secondary" onClick={() => void checkForUpdates()}>Retry</button>}
        {phase === "downloading" && <div className="update-progress" role="status">{progress === null ? `${Math.round(downloaded / 1024)} KB downloaded` : `${progress}% downloaded`}</div>}
      </section>
      <section className="info-card release-notes">
        <div className="eyebrow">WHAT'S NEW</div>
        {releaseNotes.length === 0 && <p>{phase === "upToDate" ? "You are using the latest version." : "Release notes are not available."}</p>}
        {releaseNotes.map((note) => (
          <p key={note}>• {note}</p>
        ))}
      </section>
    </div>
  )
}
function InfoPage() {
  const steps = [
    [
      "Enter Your License",
      "Enter your StockStudio Pro license on the initial screen to activate the application.",
    ],
    [
      "Add an Account",
      "Click + Add Account to add another Google Flow account.",
    ],
    [
      "Sign In to Google Flow",
      "Sign in directly through Google Flow. StockStudio Pro does not ask for or store your Google password.",
    ],
    [
      "Manage Your Accounts",
      "Use Account Cards to open, rename, favorite, remove, and reorder your Google Flow accounts.",
    ],
    [
      "Open Google Flow",
      "Click Open Google Flow to open the selected account.",
    ],
    [
      "Switch Between Accounts",
      "Use the mini navigation while Google Flow is open to quickly switch between your accounts.",
    ],
  ]
  return (
    <div className="feature-page info-page">
      <div className="info-steps">
        {steps.map((step, i) => (
          <section className="info-step" key={step[0]}>
            <div className="step-number">{String(i + 1).padStart(2, "0")}</div>
            <div>
              <h2>{step[0]}</h2>
              <p>{step[1]}</p>
            </div>
          </section>
        ))}
      </div>
      <section className="privacy-info info-card">
        <div className="privacy-heading">
          <div className="eyebrow">PRIVACY &amp; SECURITY</div>
          <h2>Your accounts stay under your control.</h2>
          <span className="badge">LOCAL ACCOUNT DATA</span>
        </div>
        <div className="privacy-row">
          <span>🔒</span>
          <div>
            <h3>Google Login Stays in Google Flow</h3>
            <p>
              Your Google account login is handled directly inside Google Flow.
              StockStudio Pro does not ask you to enter your Google password into
              StockStudio Pro.
            </p>
          </div>
        </div>
        <div className="privacy-row">
          <span>🔑</span>
          <div>
            <h3>No Password Storage</h3>
            <p>
              StockStudio Pro does not store your Google password or ask you to
              provide it to the application.
            </p>
          </div>
        </div>
        <div className="privacy-row">
          <span>💻</span>
          <div>
            <h3>Local Account Management</h3>
            <p>
              StockStudio Pro stores account-management metadata locally on your
              device so you can organize your Google Flow accounts.
            </p>
          </div>
        </div>
        <div className="privacy-row">
          <span>🛡️</span>
          <div>
            <h3>No Unnecessary Account Data Collection</h3>
            <p>
              StockStudio Pro is designed to manage account shortcuts without
              requiring unnecessary Google account information. Your Google
              account remains managed through Google Flow.
            </p>
          </div>
        </div>
      </section>
      <section className="info-card telegram-card">
        <h2>Need help or want the latest updates?</h2>
        <p>
          Follow the StockStudio Pro Telegram channel for announcements, guides, and
          product updates.
        </p>
        <button className="secondary" disabled={!TELEGRAM_CHANNEL_URL}>
          Join Telegram Channel
        </button>
      </section>
    </div>
  )
}

function AddAccountCard({ onAdd }: { onAdd: () => void }) {
  return (
    <button className="add-card" onClick={onAdd}>
      <span>＋</span>
      <b>Add Account</b>
      <small>Add another Google Flow account</small>
    </button>
  )
}

function Card({
  a,
  menuOpen,
  onMenu,
  onOpen,
  onFavorite,
  onDelete,
  onRename,
  dragEnabled,
  isDragging,
  isDropTarget,
  onPointerDown,
}: {
  a: Account
  menuOpen: boolean
  onMenu: () => void
  onOpen: () => void
  onFavorite: () => void
  onDelete: () => void
  onRename: () => void
  dragEnabled: boolean
  isDragging: boolean
  isDropTarget: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}) {
  return (
    <article data-account-id={a.id} onPointerDown={onPointerDown} className={`card ${dragEnabled ? "is-draggable" : ""} ${isDragging ? "is-dragging" : ""} ${isDropTarget ? "is-drop-target" : ""}`}>
      <div className="card-top">
        <button
          className={`star ${a.favorite ? "fav" : ""}`}
          onClick={onFavorite}
        >
          {a.favorite ? "★" : "☆"}
        </button>
        <div className="menu-wrap">
          <button className="more" onClick={onMenu}>
            •••
          </button>
          {menuOpen && (
            <div className="account-menu">
              <button onClick={onRename}>Rename</button>
              <button onClick={onFavorite}>
                {a.favorite ? "Remove from Favorites" : "Add to Favorites"}
              </button>
              <div className="menu-rule" />
              <button className="menu-danger" onClick={onDelete}>
                Delete Account
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="avatar large">
        <img
          src={a.avatarUrl || "/google-flow.png"}
          alt="Google Flow account"
          draggable={false}
        />
      </div>
      <h2>{a.name}</h2>
      <button className="primary wide" onClick={onOpen}>
        Open Google Flow <span>→</span>
      </button>
      <div className="card-links">
        <button onClick={onRename}>✎ Rename</button>
        <button onClick={onDelete}>⌫ Remove</button>
      </div>
    </article>
  )
}
function DragPreview({ account, point, offset }: { account: Account | null; point: { x: number; y: number }; offset: { x: number; y: number } }) {
  if (!account) return null
  return (
    <div className="custom-drag-layer" aria-hidden="true">
      <article className="drag-preview-card" style={{ transform: `translate3d(${point.x - offset.x}px, ${point.y - offset.y}px, 0) scale(1.04) rotate(2deg)` }}>
        <div className="card-top"><span className={`star ${account.favorite ? "fav" : ""}`}>{account.favorite ? "★" : "☆"}</span><span className="more">•••</span></div>
        <div className="avatar large"><img src={account.avatarUrl || "/google-flow.png"} alt="" /></div>
        <h2>{account.name}</h2>
        <div className="primary wide">Open Google Flow <span>→</span></div>
      </article>
    </div>
  )
}
function Settings({
  profile,
  onAvatarChange,
}: {
  profile: { name: string; avatar: string | null }
  onAvatarChange: (avatar: string) => void
}) {
  return (
    <div className="settings">
      <section>
        <label className="setting-icon profile-avatar-input">
          {profile.avatar ? (
            <img src={profile.avatar} alt="StockStudio Pro profile" />
          ) : (
            <img className="brand-avatar-fallback" src={brandLogoWhite} alt="StockStudio Pro" />
          )}
          <input
            id="profile-avatar-input"
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const reader = new FileReader()
              reader.onload = () =>
                typeof reader.result === "string" &&
                onAvatarChange(reader.result)
              reader.readAsDataURL(file)
            }}
          />
          <button
            type="button"
            className="profile-avatar-edit"
            aria-label="Change profile photo"
            title="Change profile photo"
            onClick={(e) => {
              e.preventDefault()
              document.getElementById("profile-avatar-input")?.click()
            }}
          >
            ✎
          </button>
        </label>
        <div>
          <div className="eyebrow">PROFILE</div>
          <h2>Your StockStudio Pro profile</h2>
          <p>Local desktop profile used for your account manager.</p>
        </div>
      </section>
      <section>
        <div>
          <div className="eyebrow">PRIVACY & SECURITY</div>
          <h2>Your data stays local</h2>
          <p>
            StockStudio Pro stores account metadata on this device. Google passwords
            and credentials are never captured.
          </p>
        </div>
        <span className="badge">LOCAL ONLY</span>
      </section>
      <section>
        <div>
          <div className="eyebrow">ABOUT</div>
          <h2>
            StockStudio Pro <span className="muted">{APP_VERSION}</span>
          </h2>
          <p>Google Flow desktop workspace and multi-account manager.</p>
        </div>
      </section>
    </div>
  )
}
let flowShellOpenSequence = 0

function FlowShell({
  account,
  accounts,
  liveSessionIds,
  toolId,
  targetUrl,
  toolName,
  isBackgroundStudio,
  hasExistingBgSession,
  studioBadgeLabel,
  hasExistingToolSession,
  fullView,
  navigatorOpen,
  onToggleFullView,
  onToggleNavigator,
  onSelectAccount,
  onAddAccount,
  activeDownloadsCount = 0,
  onOpenDownloads,
  onSessionUpdated,
  onBack,
}: {
  account: Account
  accounts: Account[]
  liveSessionIds: string[]
  toolId: string | null
  targetUrl: string | null
  toolName: string | null
  isBackgroundStudio?: boolean
  hasExistingBgSession?: boolean
  studioBadgeLabel?: string
  hasExistingToolSession?: boolean
  fullView: boolean
  navigatorOpen: boolean
  onToggleFullView: () => void
  onToggleNavigator: () => void
  onSelectAccount: (account: Account) => void
  onAddAccount: () => void
  activeDownloadsCount?: number
  onOpenDownloads: () => void
  onSessionUpdated: () => void
  onBack: () => void
}) {
  const [status, setStatus] = useState("Loading Google Flow...")
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "error">("loading")
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isNavigating, setIsNavigating] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuWrapRef = useRef<HTMLDivElement>(null)
  const accountsRef = useRef(accounts)
  const onSelectAccountRef = useRef(onSelectAccount)
  const onAddAccountRef = useRef(onAddAccount)
  accountsRef.current = accounts
  onSelectAccountRef.current = onSelectAccount
  onAddAccountRef.current = onAddAccount
  useEffect(() => {
    let unlistenSwitch: (() => void) | null = null
    let unlistenAdd: (() => void) | null = null
    let mounted = true
    void listen<string>("stockstudio-account-switch", (event) => {
      if (!mounted) return
      const candidate = accountsRef.current.find((item) => item.id === event.payload)
      if (candidate) {
        onSelectAccountRef.current(candidate)
      }
    }).then((fn) => {
      if (mounted) unlistenSwitch = fn
      else fn()
    })
    void listen("stockstudio-account-add", () => {
      if (!mounted) return
      onAddAccountRef.current()
    }).then((fn) => {
      if (mounted) unlistenAdd = fn
      else fn()
    })
    return () => {
      mounted = false
      if (unlistenSwitch) unlistenSwitch()
      if (unlistenAdd) unlistenAdd()
      void invoke("hide_account_switcher_popover").catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (!navigatorOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!menuWrapRef.current?.contains(event.target as Node)) {
        onToggleNavigator()
      }
    }
    window.addEventListener("mousedown", onPointerDown)
    return () => window.removeEventListener("mousedown", onPointerDown)
  }, [navigatorOpen, onToggleNavigator])
  const handleOpenAccountSwitcher = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    try {
      await invoke<boolean>("toggle_account_switcher_popover", {
        anchorRight: Math.max(0, Math.round(rect.right)),
        anchorBottom: Math.max(0, Math.round(rect.bottom + 6)),
        accounts: accounts.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          avatar_url: candidate.avatarUrl || null,
          is_active: candidate.id === account.id,
          is_live: liveSessionIds.includes(candidate.id),
        })),
      })
    } catch (error) {
      console.error("Failed to toggle account switcher popover", error)
    }
  }
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let mounted = true
    void listen<{
      account_id: string
      can_go_back: boolean
      can_go_forward: boolean
      is_loading: boolean
      current_url: string
    }>("stockstudio-webview-nav-state", (event) => {
      if (!mounted || event.payload.account_id !== account.id) return
      setCanGoBack(event.payload.can_go_back)
      setCanGoForward(event.payload.can_go_forward)
      setIsNavigating(event.payload.is_loading)
      if (!event.payload.is_loading) {
        setSessionState("ready")
      }
    }).then((fn) => {
      if (mounted) unlisten = fn
      else fn()
    })
    return () => {
      mounted = false
      if (unlisten) unlisten()
    }
  }, [account.id])
  const handleWebviewNav = async (action: "back" | "forward" | "reload") => {
    setSessionError(null)
    setIsNavigating(true)
    try {
      const next = await invoke<{
        can_go_back: boolean
        can_go_forward: boolean
        is_loading: boolean
      }>("navigate_google_flow", {
        accountId: account.id,
        action,
      })
      setCanGoBack(next.can_go_back)
      setCanGoForward(next.can_go_forward)
      setIsNavigating(next.is_loading)
    } catch (error) {
      const message = typeof error === "string" ? error : `Unable to ${action} page.`
      setIsNavigating(false)
      setSessionError(message)
      setStatus(message)
    }
  }
  useEffect(() => {
    let cancelled = false
    let rafId: number | null = null
    const openToken = ++flowShellOpenSequence
    setSessionState("loading")
    setIsNavigating(true)
    setSessionError(null)
    setStatus(toolName ? `Loading ${toolName} (${account.name})…` : `Loading Google Flow (${account.name})…`)

    const launchWebview = () => {
      if (cancelled) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        rafId = window.requestAnimationFrame(launchWebview)
        return
      }
      invoke<{
        reused: boolean
        can_go_back: boolean
        can_go_forward: boolean
        is_loading: boolean
      }>("open_google_flow", {
        accountId: account.id,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        targetUrl,
        toolId,
      })
        .then((info) => {
          if (cancelled) return
          setCanGoBack(Boolean(info?.can_go_back))
          setCanGoForward(Boolean(info?.can_go_forward))
          setIsNavigating(Boolean(info?.is_loading))
          setSessionState("ready")
          setStatus(
            toolName
              ? info?.reused
                ? `${toolName} resumed (${account.name})`
                : `${toolName} ready — sign in if prompted`
              : info?.reused
              ? `Session resumed (${account.name})`
              : "Google Flow ready — sign in if prompted"
          )
          onSessionUpdated()
          containerRef.current?.dispatchEvent(new Event("stockstudio-webview-ready"))
        })
        .catch((error) => {
          console.error("Google Flow WebView failed", error)
          if (!cancelled) {
            const message = typeof error === "string" ? error : "Unable to open Google Flow. Please try again."
            setIsNavigating(false)
            setSessionState("error")
            setSessionError(message)
            setStatus(message)
          }
        })
    }

    launchWebview()

    return () => {
      cancelled = true
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      // Defer close check by one microtask so React StrictMode double-mount or an
      // immediate account switch (which increments flowShellOpenSequence synchronously)
      // does not fire a racing close_google_flow that hides the newly opened WebView2.
      queueMicrotask(() => {
        if (flowShellOpenSequence === openToken) {
          void invoke("close_google_flow", { accountId: account.id })
        }
      })
    }
  }, [account.id, account.name, targetUrl, toolId, toolName])
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const syncBounds = () => {
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      void invoke("resize_google_flow", { accountId: account.id, x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    }
    const onReady = () => syncBounds()
    container.addEventListener("stockstudio-webview-ready", onReady)
    const observer = new ResizeObserver(syncBounds)
    observer.observe(container)
    syncBounds()
    return () => {
      observer.disconnect()
      container.removeEventListener("stockstudio-webview-ready", onReady)
    }
  }, [account.id, fullView])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (navigatorOpen) {
          onToggleNavigator()
        } else if (fullView) {
          onToggleFullView()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [fullView, navigatorOpen, onToggleFullView, onToggleNavigator])
  return (
    <div className="flow-shell">
      <div className="flow-bar">
        <div className="flow-nav-toolbar" role="toolbar" aria-label="Workspace navigation">
          <button
            className="flow-nav-btn"
            type="button"
            title="Back"
            aria-label="Back"
            disabled={!canGoBack}
            onClick={() => void handleWebviewNav("back")}
          >
            ←
          </button>
          <button
            className="flow-nav-btn"
            type="button"
            title="Forward"
            aria-label="Forward"
            disabled={!canGoForward}
            onClick={() => void handleWebviewNav("forward")}
          >
            →
          </button>
          <button
            className="flow-nav-btn"
            type="button"
            title="Reload"
            aria-label="Reload"
            onClick={() => void handleWebviewNav("reload")}
          >
            ↻
          </button>
          <button className="flow-nav-btn flow-nav-dashboard" type="button" onClick={onBack}>
            ‹ Dashboard
          </button>
        </div>
        <div className="flow-status-group">
          {(studioBadgeLabel || isBackgroundStudio) && (
            <span className="badge badge-accent">
              {studioBadgeLabel ?? "BACKGROUND STUDIO"}
            </span>
          )}
          {(hasExistingToolSession || hasExistingBgSession) && sessionState === "ready" && (
            <span className="badge">RESUMED</span>
          )}
          <span
            className={`session-dot is-${isNavigating ? "loading" : sessionState}`}
            aria-hidden="true"
          />
          <span>{isNavigating ? "Loading page…" : status}</span>
          {sessionError && <span className="badge badge-warning">SESSION ERROR</span>}
        </div>
        <div className="flow-controls">
          <div className="mini-navigator" ref={menuWrapRef}>
            <button
              ref={triggerRef}
              type="button"
              className="navigator-trigger"
              onClick={(event) => void handleOpenAccountSwitcher(event)}
              aria-haspopup="menu"
              aria-expanded={navigatorOpen}
            >
              <span className="account-popover-avatar is-trigger">
                {account.avatarUrl ? (
                  <img src={account.avatarUrl} alt="" />
                ) : (
                  <span>{account.name.trim().slice(0, 2).toUpperCase() || "G"}</span>
                )}
              </span>
              <span>{account.name}</span>
              <span className="badge badge-accent">ACCOUNT</span>
              <span aria-hidden="true">▾</span>
            </button>
            {navigatorOpen && (
              <div
                className="navigator-menu account-popover-surface"
                role="menu"
                aria-label="Switch Google Flow account"
              >
                <div className="account-popover-list">
                  {accounts.map((candidate) => {
                    const isLive = liveSessionIds.includes(candidate.id)
                    const isSelected = candidate.id === account.id
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        className={`account-popover-row ${isSelected ? "is-active" : ""}`}
                        onClick={() => onSelectAccount(candidate)}
                      >
                        <span className={`account-popover-avatar ${isSelected ? "is-active" : ""}`}>
                          {candidate.avatarUrl ? (
                            <img src={candidate.avatarUrl} alt="" />
                          ) : (
                            <span>{candidate.name.trim().slice(0, 2).toUpperCase() || "G"}</span>
                          )}
                        </span>
                        <span className="account-popover-name">{candidate.name}</span>
                        <span className="account-popover-meta">
                          {isLive && (
                            <span className="account-popover-live">
                              <span className="account-popover-live-dot" aria-hidden="true" />
                              LIVE
                            </span>
                          )}
                          {isSelected && (
                            <svg
                              className="account-popover-check"
                              viewBox="0 0 16 16"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M3.5 8.5L6.5 11.5L12.5 4.5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="account-popover-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="account-popover-add"
                  onClick={onAddAccount}
                >
                  <span className="account-popover-add-icon" aria-hidden="true">
                    ＋
                  </span>
                  <span>Add Google Account</span>
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="flow-nav-btn flow-downloads-btn"
            onClick={onOpenDownloads}
            title="Downloads"
            aria-label="Downloads"
          >
            <svg
              className="flow-icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
            {activeDownloadsCount > 0 && (
              <span className="flow-downloads-dot" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={`flow-nav-btn flow-fullview-btn ${fullView ? "is-active" : ""}`}
            onClick={onToggleFullView}
            title={fullView ? "Exit Full View" : "Full View"}
            aria-label={fullView ? "Exit Full View" : "Full View"}
            aria-pressed={fullView}
          >
            {fullView ? (
              <svg
                className="flow-icon-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg
                className="flow-icon-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
        </div>
      </div>
      <div ref={containerRef} className="webview-host" aria-label="Google Flow WebView" />
    </div>
  )
}
