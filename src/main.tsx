import React from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import AccountSwitcherPopover from "./components/AccountSwitcherPopover"
import DownloadToastPopover from "./components/DownloadToastPopover"
import "./styles/fonts.css"
import "./styles/global.css"
import "./styles/license-restore.css"
import "./styles/account-menu.css"
import "./styles/info-privacy.css"
import "./styles/scroll-layout.css"
import "./styles/profile-license.css"
import "./styles/updater.css"
import "./styles/design-system.css"

const popoverMode =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("popover") : null

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {popoverMode === "account-switcher" ? (
      <AccountSwitcherPopover />
    ) : popoverMode === "download-toast" ? (
      <DownloadToastPopover />
    ) : (
      <App />
    )}
  </React.StrictMode>
)
