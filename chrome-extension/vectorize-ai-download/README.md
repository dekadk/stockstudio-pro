# Vectorize.ai Download (v1)

A high-performance Google Chrome extension (Manifest V3) designed to extract and export vector graphics directly from the free preview version of **Vectorizer.ai** / **Vectorize.ai**.

---

## 🚀 Overview

Vectorizer.ai uses neural networks and computational geometry to trace raster images (PNG, JPG, WebP) into smooth vector geometry. When an image is processed, the platform compiles full vector paths (lines, quadratic Bézier curves, cubic Bézier curves, circular arcs, elliptical arcs, and color palettes) inside the browser's client memory to render the interactive comparison preview.

**Vectorize.ai Download** intercepts this client-side vector model directly from memory upon completion and compiles it into an industry-standard, scalable **SVG** or high-resolution **PNG** file ready for download.

---

## ✨ Features

- **True Vector Export (SVG)**: Exports clean mathematical paths preserving Bézier curves, arcs, and lines.
- **Microstock Ready**: Retains native transparency (no unwanted solid background rectangles), making files ready for stock vector submissions (Shutterstock, Freepik, Adobe Stock, Vecteezy).
- **Composite Path & Hole Detection**: Supports compound shapes and interior cutouts using the standard SVG `fill-rule="evenodd"`.
- **Multiple Export Formats**:
  - **SVG**: Scalable, fully editable in Adobe Illustrator, Inkscape, CorelDRAW, or Figma.
  - **PNG 1x / 2x / 4x**: High-resolution raster renders generated directly from the vector data.
  - **Copy SVG Code**: One-click copy of the raw SVG markup for instant pasting into design software or code.
- **Dual Access Interface**:
  - **On-Page Floating Widget**: Sleek, glassmorphism toolbar directly on the Vectorizer.ai page with one-click download buttons.
  - **Extension Popup Dashboard**: Full preview inspector with live SVG rendering, dimensions, shape count, path statistics, and configuration settings.
- **Configurable Precision**: Choose between 2 decimals (compact file size), 3 decimals (standard), or 4 decimals (ultra-high fidelity).

---

## 📁 Extension Structure

```
Vectorize.ai Download v1/
├── manifest.json                  # Manifest V3 configuration
├── background/
│   └── service-worker.js          # Background service worker (badge, context menus)
├── content/
│   ├── content.js                 # Isolated content script (widget & messaging)
│   └── content.css                # Styles for the on-page floating toolbar
├── injected/
│   └── inject.js                  # MAIN world interceptor script (memory hooks & SVG generator)
├── popup/
│   ├── popup.html                 # Extension popup interface
│   ├── popup.css                  # Modern UI styles with transparency checkerboard
│   └── popup.js                   # Popup logic, preview renderer & export triggers
├── icons/
│   ├── icon16.png                 # Toolbar icon (16x16)
│   ├── icon32.png                 # Display icon (32x32)
│   ├── icon48.png                 # Management icon (48x48)
│   └── icon128.png                # Chrome Web Store & detail icon (128x128)
└── README.md                      # Documentation
```

---

## 🛠️ Installation Instructions

1. Open Google Chrome (or Edge, Brave, or any Chromium-based browser).
2. Navigate to the extensions page by entering `chrome://extensions` in the address bar.
3. In the top-right corner, turn on **Developer mode**.
4. In the top-left corner, click the **Load unpacked** button.
5. In the file picker, select the folder:
   ```
   Vectorize.ai Download v1
   ```
6. The extension **Vectorize.ai Download** will appear in your extensions list.
7. Click the puzzle icon in Chrome's toolbar and pin **Vectorize.ai Download** for quick access.

---

## 💡 How to Use

1. Navigate to [Vectorizer.ai](https://vectorizer.ai) (or [Vectorize.ai](https://vectorize.ai)).
2. Drag and drop your image (PNG, JPG, WebP) onto the page to start the vectorization process.
3. Wait for the processing to finish and the preview comparison to appear on the screen.
4. You will immediately notice the **Vectorize.ai Download** floating toolbar at the top-right showing:
   - **Vector Ready!** with resolution and shape count.
   - **Download SVG (Free)** button.
   - **PNG 2x**, **PNG 4x**, and **Copy** buttons.
5. Alternatively, click the extension icon in your Chrome toolbar to open the full popup dashboard with live preview, shape statistics, and precision settings.

---

## 🎨 Microstock Best Practices

- **Background Transparency**: By default, the extension exports SVGs with a transparent background. This avoids the extra step of deleting white background rectangles in Illustrator or Inkscape.
- **Converting to EPS 10**: If your stock agency requires EPS 10 (e.g., Shutterstock), simply open the exported SVG in Adobe Illustrator or Inkscape and select **Save As... > EPS (EPS 10 compatibility)**.
- **Expanding Strokes & Cleaning**: All vector shapes are exported as solid filled closed loops with `fill-rule="evenodd"`.

---

## 🔒 Privacy & Permissions

- This extension operates **100% locally in your browser**.
- No image data, vector geometry, or personal information is transmitted to external servers.
- Permissions used:
  - `storage`: Saves your export preferences (decimal precision, background mode).
  - `activeTab`: Interacts with the active Vectorizer.ai tab.
