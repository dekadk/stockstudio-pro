# Blockstream-style design system, Orange identity (#FE9300)

> Adapted from the Blockstream design system extracted by [Inspo](https://github.com/Nutlope/inspo) (MIT, powered by Together AI). Source: https://blockstream.com, captured 2026-05-04.
> **Adapt, don't copy.** This file keeps the structure, dark mood and type ratios of the source, and replaces its teal/green identity with **#FE9300 orange**.
> Save as `DESIGN.md` in the project root and re-reference it while building.

- **Mode:** dark only
- **Brand color:** `#FE9300` (orange)
- **Macrostructure:** Feature Stack (hero with CTA, logo cloud, feature trio)

## Tone

Clean, dark, technical. The product interface is the hero; chrome stays quiet. Bold square-ish headlines and a single hot orange create precision and energy. Think dark fintech, crypto wallet, technical SaaS.

Keywords: dark fintech, minimal dark, neon accent, monochrome base, technical precision.

## What changed from the source

| Item | Source | This file |
|---|---|---|
| Identity / accent | `#00B093` teal | `#FE9300` orange |
| Accent hover | `#FFFFFF` | `#FFAA33` (lighter orange) |
| Warning | `#F59E0B` (too close to orange) | `#FACC15` yellow, so warnings never read as brand |
| Success | `#00D395` also used as accent | `#00D395`, used **only** for success states |
| Support cyan `#04c3fb` | main support color | secondary, used only for info and links in body copy |
| Body text | 10px / 300 | 16px / 400, since 10px on dark is not legible |
| Text on orange | n/a | `#111316` (dark), never white |

## Colors

### Brand

| Token | Hex | Use |
|---|---|---|
| `--brand` | `#FE9300` | Primary CTA fill, active states, key numbers, caret, focus ring |
| `--brand-hover` | `#FFAA33` | Hover on filled brand surfaces |
| `--brand-pressed` | `#D97F00` | Active/pressed state |
| `--brand-muted` | `rgba(254,147,0,0.10)` | Tinted backgrounds (selected row, badge) |
| `--brand-border` | `rgba(254,147,0,0.30)` | Hover border on cards and inputs |
| `--on-brand` | `#111316` | Text/icons placed on brand fill |

### Neutrals (from source)

| Token | Hex | Use |
|---|---|---|
| `--bg-primary` | `#111316` | Page background |
| `--bg-secondary` | `#1E2024` | Sections, panels |
| `--bg-card` | `#1E2024` | Cards |
| `--text-primary` | `#FFFFFF` | Headings, main text |
| `--text-secondary` | `#A5A6A7` | Body secondary |
| `--text-muted` | `#A5A6A7` | Captions, helper text |
| `--border-color` | `rgba(255,255,255,0.10)` | Default hairline borders |

### Support and semantic

| Token | Hex | Use |
|---|---|---|
| `--info` | `#04C3FB` | Links in body text, info badges. Max one per screen section |
| `--info-deep` | `#0A5973` | Info backgrounds |
| `--support-soft` | `#BCD0DC` / `#77ACBC` | Illustration strokes, disabled icons |
| `--success` | `#00D395` | Success only |
| `--warning` | `#FACC15` | Warning only |
| `--danger` | `#EF4444` | Errors, destructive actions |

### Contrast (approximate, WCAG)

| Pair | Ratio | Verdict |
|---|---|---|
| `#FE9300` on `#111316` | 8.3:1 | AA and AAA for text of any size |
| `#FE9300` on `#1E2024` | 7.2:1 | AA and AAA |
| `#111316` on `#FE9300` | 8.3:1 | Use for button labels |
| `#FFFFFF` on `#FE9300` | 2.2:1 | **Fails. Never use white on orange** |
| `#A5A6A7` on `#111316` | 7.6:1 | OK for secondary text |

### Color rules

1. Orange is the only brand color. One orange focal point per viewport (the primary CTA or one key figure), not five.
2. Backgrounds stay neutral. Do not flood sections with orange; use `--brand-muted` for tints.
3. Orange text is allowed on dark surfaces for headings accents, stats and links. Keep it off long paragraphs.
4. Do not use gradients from orange to another hue. A soft glow is fine: `0 0 24px rgba(254,147,0,0.25)`.

## Typography

Source typefaces: **rigid-square** (proprietary), **Inter**, **Arial**.
`rigid-square` is not freely available. Use a squarish geometric substitute for headings.

| Role | Family | Size | Weight | Line-height | Letter-spacing |
|---|---|---|---|---|---|
| h1 | Heading font | `clamp(36px, 5vw, 54px)` | 800 | 1.11 | 0 |
| h2 | Heading font | 28px | 700 | 1.4 | 0 |
| h3 | Heading font | 20px | 700 | 1.4 | 0 |
| body | Inter | 16px | 400 | 1.5 | 0 |
| small / caption | Inter | 13px | 400 | 1.4 | 0 |
| button | Inter | 14px | 600 | 1.4 | 0.01em |

Note: the source maps h2 to 20px and h3 to 28px, which is inverted. Here h2 is the larger of the two.

```css
--font-heading: 'Space Grotesk', 'Chakra Petch', 'Inter', -apple-system, sans-serif; /* substitute for rigid-square */
--font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

## Spacing

Base step **10px**. Scale: `10` · `15` · `20` · `30` · `60` · `90` · `100` · `150`.
If the project uses a 4/8 grid, round to `8, 16, 24, 32, 64, 96, 104, 152`.

- Between related items: 10 to 20
- Card padding: 20 to 30
- Between page sections: 90 to 150 (hero/feature stack needs generous air)

## Radius, container, motion

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 2px | Tags, small inputs |
| `--radius-md` | 8px | Buttons, inputs |
| `--radius-lg` | 12px | Cards, panels |
| `--radius-pill` | 27px | Pills, badges |

- Max content width: **1090px** (`--container-width`). The 473px in the capture is the phone mockup width, not the page.
- Transition: `0.3s ease` on color, border-color, background, transform.
- Blinking caret: `--blinking-width: 4px`, color `--brand`, used on hero headline or terminal-like inputs.
- Respect `prefers-reduced-motion`: disable the blink and glow transitions.

## CSS variables

```css
:root {
  /* brand */
  --brand: #FE9300;
  --brand-hover: #FFAA33;
  --brand-pressed: #D97F00;
  --brand-muted: rgba(254, 147, 0, 0.10);
  --brand-border: rgba(254, 147, 0, 0.30);
  --on-brand: #111316;

  /* surfaces and text */
  --bg-primary: #111316;
  --bg-secondary: #1E2024;
  --bg-card: #1E2024;
  --text-primary: #FFFFFF;
  --text-secondary: #A5A6A7;
  --text-muted: #A5A6A7;
  --border-color: rgba(255, 255, 255, 0.10);
  --border-hover: var(--brand-border);

  /* support and semantic */
  --info: #04C3FB;
  --info-deep: #0A5973;
  --success: #00D395;
  --warning: #FACC15;
  --danger: #EF4444;

  /* shape, depth, motion */
  --radius-sm: 2px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-pill: 27px;
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.5);
  --glow-brand: 0 0 24px rgba(254, 147, 0, 0.25);
  --transition-base: 0.3s ease;
  --blinking-width: 4px;
  --container-width: 1090px;

  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-heading: 'Space Grotesk', 'Chakra Petch', 'Inter', sans-serif;
}
```

## Components

### Buttons

| Variant | Background | Text | Border | Radius |
|---|---|---|---|---|
| Primary | `--brand` | `--on-brand` | none | 8px |
| Primary hover | `--brand-hover` | `--on-brand` | none | 8px |
| Primary pressed | `--brand-pressed` | `--on-brand` | none | 8px |
| Secondary | transparent | `--text-primary` | 1px `--border-color`, hover `--brand-border` | 8px |
| Ghost / link | transparent | `--brand` | none | 8px |

Padding 12px 24px, height 44px minimum for touch. Focus ring: `2px solid --brand` with 2px offset. One primary button per hero.

### Cards

Background `--bg-card`, border 1px `--border-color`, radius 12px, padding 20 to 30px. Hover: border becomes `--brand-border`, no movement. Feature icons use `--brand` stroke on a `--brand-muted` circle.

### Hero with CTA

Left or centered: h1 in `--text-primary`, one key word in `--brand`, 2 lines of `--text-secondary`, primary and secondary button side by side. Product screenshot (phone or dashboard) on `--bg-secondary` with `--shadow-lg`. Vertical padding 90 to 150px.

### Logo cloud

Logos in grayscale `--support-soft` at ~60% opacity, hover to full white. No orange here, so the CTA stays the only hot spot.

### Feature trio

Three cards in a row (stack on mobile): icon, h3, 2 lines of body. Equal heights, 30px gap.

### Inputs

Background `--bg-secondary`, border 1px `--border-color`, radius 8px, text `--text-primary`, placeholder `--text-muted`. Focus: border `--brand`, no shadow. Error: border `--danger` with message below.

### Badges and status

Brand badge: `--brand-muted` background, `--brand` text, pill radius. Success, warning and danger use their own semantic colors, never orange.

## Do and don't

- Do keep one orange focal point per screen and let neutrals carry the rest.
- Do use dark text on every orange fill.
- Do keep headlines bold and short; let the product UI be the visual.
- Don't use white text on orange.
- Don't use orange for warnings; use `--warning` yellow.
- Don't mix the old teal `#00B093` back in.
- Don't set body text below 14px on dark backgrounds.

## Quick Tailwind mapping

```js
// tailwind.config.js (extend.colors)
brand: { DEFAULT: '#FE9300', hover: '#FFAA33', pressed: '#D97F00' },
ink:   { DEFAULT: '#111316', card: '#1E2024' },
```