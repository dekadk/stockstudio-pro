# StockStudio Pro — Authoritative Design Specification (`DESIGN.md`)

- **Product:** StockStudio Pro (`com.stockstudiopro.desktop`)
- **Version:** `v0.3.0`
- **Theme Mode:** Dark-only interface

---

## 1. Color System

### Brand & Interactive Accent
- **Brand Orange (Primary Focal Accent):** `#FE9300`
- **Brand Orange Hover:** `#FFAA33`
- **Brand Orange Pressed:** `#D97F00`
- **Text on Orange Backgrounds:** `#111316` (high-contrast dark ink — **NEVER use white text on orange backgrounds**)
- **Usage Rule:** Orange must remain a restrained focal accent (primary CTAs, active indicators, key highlights) and must never overwhelm neutral dark surfaces.

### Surfaces & Backgrounds
- **Primary Background (App Canvas):** `#111316`
- **Secondary / Card Background:** `#1E2024`
- **Elevated Surface / Hover Surface:** `#25282E`
- **Subtle Border / Divider:** `#2C2F36`
- **Strong Border / Hover Border:** `#3D414B`

### Typography Ink
- **Primary Text:** `#FFFFFF`
- **Secondary Text:** `#A5A6A7`
- **Muted / Eyebrow Text:** `#73767D`

### Semantic Status Colors
- **Info:** `#04C3FB`
- **Success:** `#00D395`
- **Warning:** `#FACC15`
- **Danger:** `#EF4444`

---

## 2. Typography

- **Heading Font Stack:** `'Space Grotesk', 'Chakra Petch', 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif`
- **Body Font Stack:** `'Inter', 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif`
- **Font Policy:** Use local self-hosted fonts bundled in `src/assets/fonts/`. Do **not** introduce external font CDN requests (`fonts.googleapis.com` / `fonts.gstatic.com`), preserving strict CSP (`font-src 'self'`).

---

## 3. Shape, Spacing, & Motion

- **Card Border Radius:** `12px`
- **Button & Input Border Radius:** `8px`
- **Focus Ring:** Visible accessible focus outline (`2px solid #04C3FB` or `0 0 0 3px rgba(254, 147, 0, 0.28)`).
- **Disabled States:** Reduced opacity (`0.45`), `cursor: not-allowed`, no hover elevation.
- **Reduced Motion:** Strictly respect `@media (prefers-reduced-motion: reduce)` by disabling transitions and transforms.

---

## 4. Layout & Component Architecture

- **Sidebar:** Fixed desktop width (`248px`), `#16181C` / `#1E2024` subtle surface separation, restrained orange active indicator, workspace + studio tools + general sections, persistent profile & license status footer.
- **Dashboard & Tool Launcher:** Unified dark canvas (`#111316`) presenting Studio Tool launcher cards (*Background*, *Mascot*, *Pattern*, *AIO Metadata*) alongside Google Flow multi-account management cards (`12px` radius, `#1E2024` background).
- **License Gate (`540×620`):** Dark-only activation surface with `#FE9300` primary CTA and `#111316` text on orange, zero layout overflow.
- **Child WebView (`FlowShell`):** Preserve exact `.webview-host` coordinate measurement via `ResizeObserver` and `.navigator-open` offset behavior.
