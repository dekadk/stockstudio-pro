/**
 * Vectorize.ai Download - Injected Script
 * Runs in the MAIN page execution context to intercept and extract vector data
 * directly from Vectorize.ai / Vectorizer.ai client-side memory.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__vectorizeAiInjected) {
    return;
  }
  window.__vectorizeAiInjected = true;

  console.log('[Vectorize.ai Download] Interceptor script initialized in MAIN world.');

  // State
  let activeVectorImage = null;
  const imageHistory = [];
  let isCapturing = true;

  // Tracks the filename of the image most recently fed to Vectorizer.ai
  let pendingUploadName = null;

  /**
   * Notify content script that an image upload has started
   */
  function notifyFileUploaded(filename) {
    pendingUploadName = filename;
    console.log(`[Vectorize.ai Download] Captured upload filename: "${filename}"`);
    try {
      window.postMessage({
        type: 'VECTORIZE_AI_FILE_UPLOADED',
        filename: filename,
        timestamp: Date.now()
      }, '*');
    } catch (_) {}
  }

  /**
   * FILENAME CAPTURE
   *
   * Strategy A – Hook Object.prototype.setFileReceiver
   * Vectorizer.ai registers its file receiver via `obj.setFileReceiver = function(fn) { ... }`.
   * We intercept that setter to wrap the registered callback so we can read
   * the filename from every File object before Vectorizer.ai processes it.
   */
  try {
    const existingSetFileReceiver = Object.getOwnPropertyDescriptor(Object.prototype, 'setFileReceiver');
    Object.defineProperty(Object.prototype, 'setFileReceiver', {
      get() {
        if (existingSetFileReceiver && existingSetFileReceiver.get) {
          return existingSetFileReceiver.get.call(this);
        }
        return this.__vectorize_setFileReceiver;
      },
      set(setReceiverMethod) {
        // `setFileReceiver` is a method that accepts the actual file-receiver callback `d(file)`
        const wrappedMethod = typeof setReceiverMethod === 'function' ? function (receiverCb, ...rest) {
          const wrappedCb = typeof receiverCb === 'function' ? function (file, ...cbArgs) {
            if (file && typeof file.name === 'string' && file.size !== undefined) {
              notifyFileUploaded(file.name);
            }
            return receiverCb.call(this, file, ...cbArgs);
          } : receiverCb;

          window.__vectorizeAiFileReceiver = wrappedCb;
          return setReceiverMethod.call(this, wrappedCb, ...rest);
        } : setReceiverMethod;

        this.__vectorize_setFileReceiver = wrappedMethod;
        if (existingSetFileReceiver && existingSetFileReceiver.set) {
          existingSetFileReceiver.set.call(this, wrappedMethod);
        }
      },
      configurable: true,
      enumerable: false
    });
    console.log('[Vectorize.ai Download] Hooked Object.prototype.setFileReceiver for filename capture.');
  } catch (e) {
    console.warn('[Vectorize.ai Download] setFileReceiver hook failed:', e);
  }

  /**
   * Strategy B – Observe the native file input element for change events.
   * This captures drag-and-drop via <input type="file"> and the standard file picker.
   */
  function hookNativeFileInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    inputs.forEach((input) => {
      // Ignore our extension's own batch inputs
      if (input.id && input.id.startsWith('vai-')) return;

      if (!input.__vectorize_nameCaptureHooked) {
        input.__vectorize_nameCaptureHooked = true;
        input.addEventListener('change', () => {
          if (input.files && input.files.length > 0 && input.files[0].name) {
            notifyFileUploaded(input.files[0].name);
          }
        }, true); // capture phase so we run before site handlers
      }
    });
  }

  // Try immediately, then keep watching for the input to appear
  hookNativeFileInput();
  const _fiObserver = new MutationObserver(() => hookNativeFileInput());
  _fiObserver.observe(document.documentElement, { childList: true, subtree: true });

  /**
   * Strategy C – Intercept DataTransfer / drop events at the document level
   * to capture filenames when images are dragged onto the page.
   */
  document.addEventListener('drop', (e) => {
    try {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0 && files[0].name) {
        notifyFileUploaded(files[0].name);
      }
    } catch (_) {}
  }, true);

  /**
   * Safe numeric formatter with configurable decimal precision
   */
  function formatCoord(val, precision = 3) {
    if (typeof val !== 'number' || !isFinite(val)) {
      return '0';
    }
    return +val.toFixed(precision);
  }

  /**
   * Convert a captured Vectorizer.ai model to a clean, standard SVG document
   */
  function convertModelToSvg(vectorImage, options = {}) {
    if (!vectorImage) {
      console.warn('[Vectorize.ai Download] No vector image model available.');
      return null;
    }

    const {
      imageWidth,
      imageHeight,
      vectorShapes,
      vectorLoops,
      userPalette,
      vectorInterfaces
    } = vectorImage;

    const precision = typeof options.precision === 'number' ? options.precision : 3;
    const includeBackground = !!options.includeBackground;
    const backgroundColor = options.backgroundColor || '#ffffff';
    const includeGapFillers = !!options.includeGapFillers;
    const gapFillerWidth = options.gapFillerWidth || 0.5;

    const width = imageWidth || 800;
    const height = imageHeight || 600;

    const svgParts = [];
    svgParts.push('<?xml version="1.0" encoding="UTF-8"?>');
    svgParts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`
    );

    // Optional background rect (for users who prefer white/solid background over transparency)
    if (includeBackground) {
      svgParts.push(`  <rect width="100%" height="100%" fill="${backgroundColor}" id="background-plate"/>`);
    }

    // Main vector paths container
    svgParts.push('  <g id="vector-shapes">');

    // Index loops by shape index for fast and accurate lookup
    const loopsByShape = new Map();
    if (Array.isArray(vectorLoops)) {
      for (const loop of vectorLoops) {
        if (!loop) continue;
        const sIdx = loop.vectorShapeIndex;
        if (!loopsByShape.has(sIdx)) {
          loopsByShape.set(sIdx, []);
        }
        loopsByShape.get(sIdx).push(loop);
      }
    }

    let exportedShapesCount = 0;

    if (Array.isArray(vectorShapes)) {
      for (const shape of vectorShapes) {
        if (!shape) continue;

        // Extract color
        let colorObj = null;
        if (userPalette && typeof userPalette.getMutRgba === 'function') {
          colorObj = userPalette.getMutRgba(shape.paletteIndex);
        } else if (typeof shape.paletteEntry === 'function') {
          colorObj = shape.paletteEntry();
        } else if (userPalette && userPalette.colors && userPalette.colors[shape.paletteIndex]) {
          colorObj = userPalette.colors[shape.paletteIndex];
        }

        // If shape is completely transparent, skip it
        if (!colorObj || colorObj.a === 0) {
          continue;
        }

        // Format CSS color
        let colorCss;
        if (typeof colorObj.toCssAuto === 'function') {
          colorCss = colorObj.toCssAuto();
        } else if (colorObj.a === 1) {
          colorCss = `rgb(${Math.round(colorObj.r || 0)}, ${Math.round(colorObj.g || 0)}, ${Math.round(colorObj.b || 0)})`;
        } else {
          colorCss = `rgba(${Math.round(colorObj.r || 0)}, ${Math.round(colorObj.g || 0)}, ${Math.round(colorObj.b || 0)}, ${(colorObj.a || 1).toFixed(2)})`;
        }

        // Retrieve loops for this shape
        let loops = Array.isArray(shape.vectorLoops) && shape.vectorLoops.length > 0
          ? shape.vectorLoops
          : (loopsByShape.get(shape.index) || []);

        if (!loops || loops.length === 0) {
          continue;
        }

        const pathDataForShape = [];

        for (const loop of loops) {
          const curveLoop = loop.curveLoop;
          if (!curveLoop) continue;

          let curves = null;
          if (Array.isArray(curveLoop.curves)) {
            curves = curveLoop.curves;
          } else if (curveLoop.encoded && typeof curveLoop.encoded.toArray === 'function') {
            curves = curveLoop.encoded.toArray();
          }

          if (!curves || curves.length === 0) continue;

          const segments = [];
          const first = curves[0];
          segments.push(`M ${formatCoord(first.startX, precision)} ${formatCoord(first.startY, precision)}`);

          for (const curve of curves) {
            // Check curve type by property introspection (resilient against JS minification)
            if (curve.controlStartX !== undefined) {
              // Cubic Bézier Curve
              segments.push(
                `C ${formatCoord(curve.controlStartX, precision)} ${formatCoord(curve.controlStartY, precision)} ` +
                `${formatCoord(curve.controlEndX, precision)} ${formatCoord(curve.controlEndY, precision)} ` +
                `${formatCoord(curve.endX, precision)} ${formatCoord(curve.endY, precision)}`
              );
            } else if (curve.controlX !== undefined) {
              // Quadratic Bézier Curve
              segments.push(
                `Q ${formatCoord(curve.controlX, precision)} ${formatCoord(curve.controlY, precision)} ` +
                `${formatCoord(curve.endX, precision)} ${formatCoord(curve.endY, precision)}`
              );
            } else if (curve.radiusX !== undefined) {
              // Elliptical Arc
              const largeArc = curve.isLargeArc ? '1' : '0';
              const sweep = curve.isClockwise ? '1' : '0';
              const rot = curve.rotationRad !== undefined
                ? formatCoord((curve.rotationRad * 180) / Math.PI, precision)
                : (typeof curve.rotationDeg === 'function' ? formatCoord(curve.rotationDeg(), precision) : '0');

              segments.push(
                `A ${formatCoord(curve.radiusX, precision)} ${formatCoord(curve.radiusY, precision)} ` +
                `${rot} ${largeArc} ${sweep} ` +
                `${formatCoord(curve.endX, precision)} ${formatCoord(curve.endY, precision)}`
              );
            } else if (curve.radius !== undefined) {
              // Circular Arc
              const largeArc = curve.isLargeArc ? '1' : '0';
              const sweep = curve.isClockwise ? '1' : '0';

              segments.push(
                `A ${formatCoord(curve.radius, precision)} ${formatCoord(curve.radius, precision)} ` +
                `0 ${largeArc} ${sweep} ` +
                `${formatCoord(curve.endX, precision)} ${formatCoord(curve.endY, precision)}`
              );
            } else {
              // Straight Line
              segments.push(`L ${formatCoord(curve.endX, precision)} ${formatCoord(curve.endY, precision)}`);
            }
          }

          segments.push('Z');
          pathDataForShape.push(segments.join(' '));
        }

        const combinedD = pathDataForShape.join(' ');
        if (combinedD) {
          svgParts.push(`    <path fill="${colorCss}" fill-rule="evenodd" d="${combinedD}" />`);
          exportedShapesCount++;
        }
      }
    }
    svgParts.push('  </g>');

    // Optional gap fillers (stroke lines) to eliminate hairline artifacts in some vector renderers
    if (includeGapFillers && Array.isArray(vectorInterfaces) && vectorInterfaces.length > 0) {
      svgParts.push(`  <g id="gap-fillers" stroke-linecap="round" stroke-linejoin="bevel">`);
      for (const iface of vectorInterfaces) {
        if (iface && iface.css && iface.path) {
          if (iface.d) {
            svgParts.push(`    <path d="${iface.d}" stroke="${iface.css}" stroke-width="${gapFillerWidth}" fill="none" />`);
          }
        }
      }
      svgParts.push('  </g>');
    }

    svgParts.push('</svg>');

    return {
      svgString: svgParts.join('\n'),
      width,
      height,
      shapesCount: exportedShapesCount,
      loopsCount: vectorLoops ? vectorLoops.length : 0,
      paletteCount: userPalette && typeof userPalette.numColors === 'function' ? userPalette.numColors() : (userPalette && userPalette.colors ? userPalette.colors.length : 0)
    };
  }

  /**
   * Handle captured VectorImage
   */
  function onVectorImageCommitted(vectorImage) {
    if (!vectorImage || !vectorImage.vectorShapes || !vectorImage.vectorLoops) {
      return;
    }

    // Prevent duplicate firing when both `isReady` setter and `commit()` wrapper trigger
    if (vectorImage.__vectorizeAiCommitted) {
      return;
    }
    vectorImage.__vectorizeAiCommitted = true;

    activeVectorImage = vectorImage;
    window.__vectorizeAiImage = vectorImage;

    // Prefer the filename we captured at upload time; fall back to what the site model provides
    const capturedName = pendingUploadName || vectorImage.name || 'vectorized-art';
    const imageName = capturedName;

    const result = convertModelToSvg(vectorImage, { precision: 3, includeBackground: false });

    if (!result) return;

    const payload = {
      name: imageName,
      width: result.width,
      height: result.height,
      shapesCount: result.shapesCount,
      loopsCount: result.loopsCount,
      paletteCount: result.paletteCount,
      svgString: result.svgString,
      timestamp: Date.now()
    };

    imageHistory.unshift(payload);
    if (imageHistory.length > 10) imageHistory.pop();

    console.log(`[Vectorize.ai Download] Vector image ready: "${imageName}" (${result.width}x${result.height}, ${result.shapesCount} shapes)`);

    // Notify isolated world (content.js) via postMessage
    window.postMessage({
      type: 'VECTORIZE_AI_RESULT_READY',
      detail: payload
    }, '*');

    // Notify custom DOM event
    window.dispatchEvent(new CustomEvent('vectorize-ai-ready', { detail: payload }));
  }

  /**
   * Set up prototype property interception on Object.prototype
   * This catches when VectorImage sets `this.isReady = !0` at the end of its `commit()` method.
   */
  try {
    const existingDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'isReady');

    Object.defineProperty(Object.prototype, 'isReady', {
      get() {
        if (existingDescriptor && existingDescriptor.get) {
          return existingDescriptor.get.call(this);
        }
        return this.__vectorize_isReady;
      },
      set(val) {
        this.__vectorize_isReady = val;

        if (existingDescriptor && existingDescriptor.set) {
          existingDescriptor.set.call(this, val);
        }

        // Check if this object is a VectorImage finishing its commit
        if (
          isCapturing &&
          val === true &&
          this.vectorShapes &&
          this.vectorLoops &&
          this.userPalette
        ) {
          try {
            onVectorImageCommitted(this);
          } catch (err) {
            console.error('[Vectorize.ai Download] Error processing committed vector image:', err);
          }
        }
      },
      configurable: true,
      enumerable: false
    });

    console.log('[Vectorize.ai Download] Hooked Object.prototype.isReady');
  } catch (e) {
    console.warn('[Vectorize.ai Download] Failed to hook Object.prototype.isReady:', e);
  }

  /**
   * Secondary hook on `nextResult` property (job tracker)
   */
  try {
    const existingNextResult = Object.getOwnPropertyDescriptor(Object.prototype, 'nextResult');
    Object.defineProperty(Object.prototype, 'nextResult', {
      get() {
        if (existingNextResult && existingNextResult.get) {
          return existingNextResult.get.call(this);
        }
        return this.__vectorize_nextResult;
      },
      set(val) {
        this.__vectorize_nextResult = val;
        if (existingNextResult && existingNextResult.set) {
          existingNextResult.set.call(this, val);
        }

        // If val is a VectorImage, we can also hook its commit directly as a safety fallback
        if (val && typeof val.commit === 'function' && !val.__vectorize_commitHooked) {
          val.__vectorize_commitHooked = true;
          const origCommit = val.commit;
          val.commit = function (...args) {
            const ret = origCommit.apply(this, args);
            try {
              onVectorImageCommitted(this);
            } catch (err) {
              console.error('[Vectorize.ai Download] Fallback commit hook error:', err);
            }
            return ret;
          };
        }
      },
      configurable: true,
      enumerable: false
    });
  } catch (e) {
    // Silently continue if secondary hook fails
  }

  /**
   * Helper: Trigger download of a Blob
   */
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /**
   * Helper: Render SVG string to Canvas and download as PNG
   */
  function downloadAsPng(svgString, filename, scale = 2) {
    const img = new Image();
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(function (pngBlob) {
        URL.revokeObjectURL(url);
        if (pngBlob) {
          const pngName = filename.replace(/\.svg$/i, '') + `@${scale}x.png`;
          triggerBlobDownload(pngBlob, pngName);
        }
      }, 'image/png');
    };

    img.onerror = function (e) {
      URL.revokeObjectURL(url);
      console.error('[Vectorize.ai Download] Failed to render SVG to PNG canvas:', e);
    };

    img.src = url;
  }

  let lastSvgDownloadTime = 0;

  /**
   * Global Exporter API available on window for console & extensions
   */
  window.__vectorizeAiExporter = {
    getActiveImage: () => activeVectorImage,
    getHistory: () => imageHistory,
    generateSvg: (options = {}) => {
      if (!activeVectorImage) return null;
      return convertModelToSvg(activeVectorImage, options);
    },
    downloadSvg: (options = {}) => {
      if (!activeVectorImage) {
        alert('No vectorized image available to download yet. Please upload an image first!');
        return;
      }
      // Prevent duplicate downloads triggered within 1 second
      const now = Date.now();
      if (now - lastSvgDownloadTime < 1000) {
        return;
      }
      lastSvgDownloadTime = now;

      const res = convertModelToSvg(activeVectorImage, options);
      if (!res) return;
      // Prefer the filename captured at upload time
      const rawName = pendingUploadName || activeVectorImage.name || 'vectorized-art';
      const cleanName = rawName.replace(/\.[^/.]+$/, '');
      const blob = new Blob([res.svgString], { type: 'image/svg+xml;charset=utf-8' });
      triggerBlobDownload(blob, `${cleanName}.svg`);
    },
    downloadPng: (scale = 2, options = {}) => {
      if (!activeVectorImage) {
        alert('No vectorized image available to download yet. Please upload an image first!');
        return;
      }
      const res = convertModelToSvg(activeVectorImage, options);
      if (!res) return;
      // Prefer the filename captured at upload time
      const rawName = pendingUploadName || activeVectorImage.name || 'vectorized-art';
      const cleanName = rawName.replace(/\.[^/.]+$/, '');
      downloadAsPng(res.svgString, cleanName, scale);
    },
    copySvgCode: (options = {}) => {
      if (!activeVectorImage) return Promise.reject(new Error('No image ready'));
      const res = convertModelToSvg(activeVectorImage, options);
      if (!res) return Promise.reject(new Error('Failed to generate SVG'));
      return navigator.clipboard.writeText(res.svgString);
    }
  };

  /**
   * Listen for messages from content.js (ISOLATED world)
   */
  window.addEventListener('message', (event) => {
    if (!event.data || typeof event.data.type !== 'string') return;

    if (event.data.type === 'VECTORIZE_AI_REQUEST_CURRENT_DATA') {
      if (activeVectorImage) {
        const res = convertModelToSvg(activeVectorImage, event.data.options || {});
        if (res) {
          window.postMessage({
            type: 'VECTORIZE_AI_RESULT_READY',
            detail: {
              name: activeVectorImage.name || 'vectorized-art',
              width: res.width,
              height: res.height,
              shapesCount: res.shapesCount,
              loopsCount: res.loopsCount,
              paletteCount: res.paletteCount,
              svgString: res.svgString,
              timestamp: Date.now()
            }
          }, '*');
        }
      }
    } else if (event.data.type === 'VECTORIZE_AI_TRIGGER_DOWNLOAD') {
      const format = event.data.format || 'svg';
      const options = event.data.options || {};
      if (format === 'svg') {
        window.__vectorizeAiExporter.downloadSvg(options);
      } else if (format === 'png') {
        const scale = event.data.scale || 2;
        window.__vectorizeAiExporter.downloadPng(scale, options);
      }
    } else if (event.data.type === 'VECTORIZE_AI_SET_FILENAME') {
      if (event.data.filename) {
        pendingUploadName = event.data.filename;
      }
    }
  });

})();
