import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export type AccountPopoverEntry = {
  id: string
  name: string
  avatar_url?: string | null
  is_active: boolean
  is_live: boolean
}

export function getAccountInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return "G"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase()
}

export default function AccountSwitcherPopover() {
  const [accounts, setAccounts] = useState<AccountPopoverEntry[]>([])
  const [animKey, setAnimKey] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add("is-popover-window")
    document.body.classList.add("is-popover-window")
    let mounted = true
    let unlisten: (() => void) | null = null

    void invoke<AccountPopoverEntry[]>("get_account_popover_state")
      .then((initial) => {
        if (mounted && Array.isArray(initial)) {
          setAccounts(initial)
          setAnimKey((k) => k + 1)
        }
      })
      .catch((error) => {
        console.error("Failed to load account popover state", error)
      })

    void listen<AccountPopoverEntry[]>("stockstudio-account-popover-data", (event) => {
      if (!mounted) return
      if (Array.isArray(event.payload)) {
        setAccounts(event.payload)
        setAnimKey((k) => k + 1)
      }
    }).then((fn) => {
      if (mounted) unlisten = fn
      else fn()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        void invoke("hide_account_switcher_popover")
      }
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      mounted = false
      window.removeEventListener("keydown", onKeyDown)
      if (unlisten) unlisten()
      document.documentElement.classList.remove("is-popover-window")
      document.body.classList.remove("is-popover-window")
    }
  }, [])

  return (
    <div
      key={animKey}
      className="account-popover-surface is-window-popover"
      role="menu"
      aria-label="Switch Google Flow account"
    >
      <div className="account-popover-list">
        {accounts.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="menuitemradio"
            aria-checked={entry.is_active}
            className={`account-popover-row ${entry.is_active ? "is-active" : ""}`}
            onClick={() => void invoke("select_account_from_popover", { accountId: entry.id })}
          >
            <span className={`account-popover-avatar ${entry.is_active ? "is-active" : ""}`}>
              {entry.avatar_url ? (
                <img src={entry.avatar_url} alt="" />
              ) : (
                <span>{getAccountInitials(entry.name)}</span>
              )}
            </span>
            <span className="account-popover-name">{entry.name}</span>
            <span className="account-popover-meta">
              {entry.is_live && (
                <span className="account-popover-live">
                  <span className="account-popover-live-dot" aria-hidden="true" />
                  LIVE
                </span>
              )}
              {entry.is_active && (
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
        ))}
      </div>
      <div className="account-popover-divider" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="account-popover-add"
        onClick={() => void invoke("add_account_from_popover")}
      >
        <span className="account-popover-add-icon" aria-hidden="true">
          ＋
        </span>
        <span>Add Google Account</span>
      </button>
    </div>
  )
}
