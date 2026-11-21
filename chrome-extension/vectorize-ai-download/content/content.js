/**
 * Vectorize.ai Download - Content Script
 * Runs in the ISOLATED world. Manages UI overlay, communicates with inject.js (MAIN world)
 * and background / popup scripts.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__vectorizeAiContentInjected) return;
  window.__vectorizeAiContentInjected = true;

  // ─────────────────────────────────────────────────────────────────────────────
  // ERROR LOGGER
  // Keeps an in-memory ring buffer (max 200 entries) and persists to
  // chrome.storage.local under the key "vaiErrorLog".
  // ─────────────────────────────────────────────────────────────────────────────
  const LOG_MAX = 200;
  const errorLog = [];

  /**
   * Log levels: 'info' | 'warn' | 'error'
   */
  function log(level, message, data) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      data: data !== undefined ? String(data) : undefined
    };
    errorLog.push(entry);
    if (errorLog.length > LOG_MAX) errorLog.shift();

    // Mirror to browser console with the standard prefix
    const prefix = '[Vectorize.ai Download]';
    if (level === 'error') {
      console.error(prefix, message, data !== undefined ? data : '');
    } else if (level === 'warn') {
      console.warn(prefix, message, data !== undefined ? data : '');
    } else {
      console.log(prefix, message, data !== undefined ? data : '');
    }

    // Persist the last 50 entries to storage so popup / background can read them
    try {
      chrome.storage.local.set({ vaiErrorLog: errorLog.slice(-50) });
    } catch (_) {}

    // Update the on-page log panel if it exists
    renderLogEntry(entry);
  }

  function renderLogEntry(entry) {
    const panel = document.getElementById('vai-log-panel');
    if (!panel) return;
    const row = document.createElement('div');
    row.className = `vai-log-row vai-log-${entry.level}`;
    row.textContent = `[${entry.ts.slice(11, 19)}] [${entry.level.toUpperCase()}] ${entry.msg}${entry.data ? ' — ' + entry.data : ''}`;
    panel.appendChild(row);
    panel.scrollTop = panel.scrollHeight;
    // Keep DOM lean
    while (panel.childElementCount > 80) panel.removeChild(panel.firstChild);
  }

  log('info', 'Content script initialized in ISOLATED world.');

  // ─────────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────────
  let currentVectorData = null;
  let isWidgetCollapsed = false;
  let autoDownloadEnabled = true; // auto-download after vectorization
  let isAutoMode = false;         // true while the full auto-cycle is running
  let isLicenseAuthorized = false;
  let lastLicenseErrorCode = 'CHECKING';

  function verifyLicenseWithBackground(forceRefresh = false) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'GET_LICENSE_STATUS', forceRefresh },
          (response) => {
            if (chrome.runtime.lastError || !response || !response.verdict) {
              isLicenseAuthorized = false;
              lastLicenseErrorCode = 'NATIVE_HOST_UNAVAILABLE';
              applyLicenseGateToWidget();
              resolve(false);
              return;
            }
            isLicenseAuthorized = response.verdict.authorized === true;
            lastLicenseErrorCode = response.verdict.error_code || null;
            applyLicenseGateToWidget();
            resolve(isLicenseAuthorized);
          }
        );
      } catch (_) {
        isLicenseAuthorized = false;
        lastLicenseErrorCode = 'NATIVE_HOST_UNAVAILABLE';
        applyLicenseGateToWidget();
        resolve(false);
      }
    });
  }

  function applyLicenseGateToWidget() {
    const protectedIds = [
      'vai-btn-download-svg',
      'vai-btn-download-png2',
      'vai-btn-download-png4',
      'vai-btn-copy-svg',
      'vai-btn-trigger-auto',
      'vai-btn-pick-folder',
      'vai-btn-pick-files'
    ];
    if (!isLicenseAuthorized) {
      protectedIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
      });
      setAutoStatus('🔒 Activate in StockStudio Pro Desktop');
    } else {
      ['vai-btn-trigger-auto', 'vai-btn-pick-folder', 'vai-btn-pick-files'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });
      if (currentVectorData) {
        ['vai-btn-download-svg', 'vai-btn-download-png2', 'vai-btn-download-png4', 'vai-btn-copy-svg'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.disabled = false;
        });
      }
    }
  }
  let exportOptions = {
    precision: 3,
    includeBackground: false,
    backgroundColor: '#ffffff',
    includeGapFillers: false
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // INJECT FALLBACK
  // ─────────────────────────────────────────────────────────────────────────────
  function ensureInjectedScript() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('injected/inject.js');
      script.onload = function () { this.remove(); };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      log('warn', 'Script injection fallback notice', e.message);
    }
  }
  ensureInjectedScript();

  // ─────────────────────────────────────────────────────────────────────────────
  // TOAST NOTIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  function showToast(message, icon = '✓') {
    let toast = document.getElementById('vai-toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'vai-toast-notification';
      toast.className = 'vai-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span style="color:var(--success, #00D395);font-weight:bold">${icon}</span> <span>${message}</span>`;
    toast.classList.add('vai-show');
    clearTimeout(toast.__hideTimer);
    toast.__hideTimer = setTimeout(() => toast.classList.remove('vai-show'), 3200);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTOMATION: STEP 1 — Auto-click the "Vectorize image" upload button
  // ─────────────────────────────────────────────────────────────────────────────
  const VECTORIZE_BTN_SELECTOR = 'button.btn.btn-primary.btn-lg.vk-dropzone-button';
  const AUTO_CLICK_DELAY_MS = 1200; // wait after page ready before clicking
  const POST_DOWNLOAD_DELAY_MS = 1800; // wait after download before navigating back

  function tryAutoClickVectorizeButton() {
    if (!isLicenseAuthorized) return false;
    const btn = document.querySelector(VECTORIZE_BTN_SELECTOR);
    if (btn && !btn.disabled && btn.offsetParent !== null) {
      log('info', 'Auto-clicking "Vectorize image" button.');
      isAutoMode = true;
      setAutoStatus('⏳ Waiting for image selection…');
      try {
        btn.click();
      } catch (e) {
        log('error', 'Failed to click "Vectorize image" button', e.message);
        isAutoMode = false;
      }
      return true;
    }
    return false;
  }

  /**
   * Watch for the button to appear (SPA may render it after load)
   * and click it once found, with a small delay.
   */
  function scheduleAutoClickWhenReady() {
    // Try immediately first
    if (tryAutoClickVectorizeButton()) return;

    // Otherwise, watch for it to appear in the DOM
    let attempts = 0;
    const maxAttempts = 40; // 40 × 250ms = 10s
    const observer = new MutationObserver(() => {
      if (tryAutoClickVectorizeButton()) {
        observer.disconnect();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          observer.disconnect();
          log('warn', '"Vectorize image" button not found after 10s — auto-click skipped.');
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTOMATION: PRE-CROP DIALOG DETECTION & AUTO-CLICK "OK" AFTER UPLOAD
  //
  // After an image is uploaded, Vectorizer.ai may display the Pre-Crop pop-up
  // (.PreCrop-Sidebar-body / #PreCrop-Inner) if the image exceeds the 3 MP limit.
  //
  // Workflow:
  //   - If the Pre-Crop pop-up appears -> automatically click "Ok" to continue.
  //   - If it does NOT appear          -> do nothing and continue as normal.
  // ─────────────────────────────────────────────────────────────────────────────
  const PRECROP_POPUP_SELECTORS = [
    '.PreCrop-Sidebar-body',
    '#PreCrop-Sidebar-Container',
    '#PreCrop-Inner'
  ];

  const PRECROP_OK_SELECTORS = [
    '#PreCrop-Sidebar-ButtonBar .PreCrop-Sidebar-crop_button',
    '.PreCrop-Sidebar-crop_button.App-Refinement-primary_action',
    '.PreCrop-Sidebar-crop_button',
    '#PreCrop-Sidebar-ButtonBar button.App-Refinement-primary_action'
  ];

  let preCropClickInProgress = false;
  let lastPreCropClickTime = 0;
  let postUploadCheckTimer = null;

  /**
   * Accurately check whether a DOM element is visible on screen
   * (handles parent containers with display:none or visibility:hidden).
   */
  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    let cur = el;
    while (cur && cur.nodeType === 1) {
      const style = window.getComputedStyle(cur);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        parseFloat(style.opacity) === 0
      ) {
        return false;
      }
      cur = cur.parentElement;
    }
    return true;
  }

  /**
   * Check if the Pre-Crop pop-up (.PreCrop-Sidebar-body) is currently visible.
   */
  function isPreCropPopupVisible() {
    for (const sel of PRECROP_POPUP_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isElementVisible(el)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find the visible & enabled "Ok" button inside the Pre-Crop pop-up.
   */
  function findPreCropOkButton() {
    for (const sel of PRECROP_OK_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && isElementVisible(btn)) {
        return btn;
      }
    }

    // Fallback: look for any button inside Pre-Crop containers with text "Ok"
    const container =
      document.querySelector('#PreCrop-Sidebar-ButtonBar') ||
      document.querySelector('#PreCrop-Sidebar-Container') ||
      document.querySelector('#PreCrop-Inner');

    if (container) {
      const buttons = container.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if ((text === 'ok' || text === 'okay') && !btn.disabled && isElementVisible(btn)) {
          return btn;
        }
      }
    }
    return null;
  }

  /**
   * Check if the Pre-Crop pop-up is open and click "Ok" if found.
   * Returns true if "Ok" was clicked, false otherwise.
   */
  function tryClickPreCropOk(source = 'watcher') {
    if (preCropClickInProgress) return false;

    // Cooldown of 1.5s to prevent double-clicking the same pop-up
    if (Date.now() - lastPreCropClickTime < 1500) return false;

    if (!isPreCropPopupVisible()) return false;

    const okBtn = findPreCropOkButton();
    if (!okBtn) return false;

    preCropClickInProgress = true;

    // Read image stats from the pop-up if available for informative logging
    const sizeEl = document.querySelector('.PreCrop-Sidebar-input_image_size_display');
    const mpEl = document.querySelector('.PreCrop-Sidebar-input_image_megapixels_display');
    const statsInfo = sizeEl ? `${sizeEl.textContent.trim()} (${mpEl ? mpEl.textContent.trim() + ' MP' : ''})` : '';

    log('info', `Pop-up Pre-Crop terdeteksi (${source}) ${statsInfo} — otomatis klik "OK".`);
    setAutoStatus('✂️ Pre-Crop detected — clicking OK…');
    showToast('Pop-up Pre-Crop terdeteksi — otomatis klik OK ✂️', '✅');

    setTimeout(() => {
      try {
        // Dispatch full mouse events + native click for maximum framework compatibility
        okBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        okBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        okBtn.click();
        lastPreCropClickTime = Date.now();
        log('info', 'Tombol "OK" pada Pre-Crop berhasil diklik. Melanjutkan proses vektorisasi…');
        setAutoStatus('⚡ Vectorizing image…');
      } catch (e) {
        log('error', 'Gagal klik tombol OK pada Pre-Crop', e.message);
      } finally {
        preCropClickInProgress = false;
      }
    }, 350);

    return true;
  }

  /**
   * Stop the active post-upload polling timer if running.
   */
  function stopPostUploadPreCropCheck(reason) {
    if (postUploadCheckTimer) {
      clearInterval(postUploadCheckTimer);
      postUploadCheckTimer = null;
      if (reason) {
        log('info', reason);
      }
    }
  }

  /**
   * Triggered immediately after the user uploads an image.
   * Actively checks for the Pre-Crop pop-up (.PreCrop-Sidebar-body).
   * - If it appears: clicks "OK" and continues.
   * - If it doesn't appear: does nothing and lets normal vectorization proceed.
   */
  function startPostUploadPreCropCheck(filename, isRetry = false) {
    stopPostUploadPreCropCheck();
    if (!isRetry) {
      resetErrorRetryState();
      hasAutoDownloadedCurrent = false;
    }

    log('info', `Upload terdeteksi ("${filename || 'image'}") — mengecek apakah muncul pop-up Pre-Crop…`);
    setAutoStatus('🔍 Checking Pre-Crop…');

    let attempts = 0;
    const maxAttempts = 60; // 60 * 250ms = 15 seconds max window after upload

    postUploadCheckTimer = setInterval(() => {
      attempts++;

      if (tryClickPreCropOk('post-upload')) {
        stopPostUploadPreCropCheck();
        return;
      }

      if (attempts >= maxAttempts) {
        stopPostUploadPreCropCheck('Pop-up Pre-Crop tidak muncul — lanjut proses normal.');
      }
    }, 250);
  }

  /**
   * Persistent watcher (MutationObserver + fallback interval) that monitors
   * the page for the Pre-Crop pop-up at any time (including paste or drag-drop).
   */
  (function installPreCropWatcher() {
    // Check immediately in case the pop-up is already visible
    tryClickPreCropOk('initial-check');

    const preCropObserver = new MutationObserver(() => {
      if (!preCropClickInProgress && isPreCropPopupVisible()) {
        tryClickPreCropOk('mutation-observer');
      }
    });

    preCropObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden']
    });

    // Lightweight periodic check (every 500ms) as a safety net
    setInterval(() => {
      if (!preCropClickInProgress && isPreCropPopupVisible()) {
        tryClickPreCropOk('interval-check');
      }
    }, 500);

    log('info', 'Pre-Crop dialog watcher installed.');
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTOMATION: ERROR MODAL DETECTION & PROGRESSIVE AUTO-RETRY (+10s PER LOOP)
  //
  // Detects Vectorizer.ai's Error pop-up modal:
  //   <div id="App-Error-Message" class="modal-body">Too many image uploads...</div>
  //   <button id="App-Error-RetryButton" class="btn btn-warning">Retry</button>
  //
  // Progressive retry schedule:
  //   - Loop 1: wait 10 seconds -> click "Retry"
  //   - Loop 2: wait 20 seconds -> click "Retry"
  //   - Loop 3: wait 30 seconds -> click "Retry"
  //   - Loop N: wait (N * 10) seconds (+10s per loop) until modal disappears
  //             and vectorization continues.
  //   - If modal does not appear: do nothing and proceed normally.
  // ─────────────────────────────────────────────────────────────────────────────
  const ERROR_RETRY_BTN_SELECTOR = '#App-Error-RetryButton';
  const ERROR_MESSAGE_SELECTOR   = '#App-Error-Message';

  let errorRetryAttempt = 0;         // 0 -> 1 (10s) -> 2 (20s) -> 3 (30s)...
  let errorRetryCountdownTimer = null;
  let errorRetryPostClickTimer = null;
  let isErrorRetryWaiting = false;

  /**
   * Find the visible & enabled "Retry" button inside the Error modal.
   */
  function findVisibleErrorRetryButton() {
    const btn = document.querySelector(ERROR_RETRY_BTN_SELECTOR);
    if (btn && !btn.disabled && isElementVisible(btn)) {
      return btn;
    }

    // Fallback: look for a visible button with text "Retry" near #App-Error-Message
    const msgEl = document.querySelector(ERROR_MESSAGE_SELECTOR);
    if (msgEl && isElementVisible(msgEl)) {
      const modal = msgEl.closest('.modal-content, .modal-dialog') || document;
      const buttons = modal.querySelectorAll('button');
      for (const b of buttons) {
        if ((b.textContent || '').trim().toLowerCase() === 'retry' && !b.disabled && isElementVisible(b)) {
          return b;
        }
      }
    }
    return null;
  }

  /**
   * Check whether the Error modal is currently visible on screen.
   */
  function isErrorModalVisible() {
    const msgEl = document.querySelector(ERROR_MESSAGE_SELECTOR);
    if (msgEl && isElementVisible(msgEl)) return true;
    return !!findVisibleErrorRetryButton();
  }

  /**
   * Clear active Error Retry timers and reset retry counter to 0.
   * Called when vectorization succeeds or a fresh upload starts.
   */
  function resetErrorRetryState() {
    if (errorRetryCountdownTimer) {
      clearInterval(errorRetryCountdownTimer);
      errorRetryCountdownTimer = null;
    }
    if (errorRetryPostClickTimer) {
      clearTimeout(errorRetryPostClickTimer);
      errorRetryPostClickTimer = null;
    }
    isErrorRetryWaiting = false;
    errorRetryAttempt = 0;
  }

  /**
   * Refresh the 90-second batch safety timeout so a file isn't skipped while
   * waiting for progressive Error Retry countdowns.
   */
  function refreshBatchSafetyTimeout() {
    if (batchState.status !== 'running') return;
    clearTimeout(batchState.timeoutTimer);
    const currentFile = batchState.files[batchState.currentIndex];
    batchState.timeoutTimer = setTimeout(() => {
      if (batchState.status === 'running' && !isErrorRetryWaiting) {
        log('warn', `⚠️ Timeout (90d) pada "${currentFile ? currentFile.name : 'file'}" — melewati ke file berikutnya…`);
        batchState.currentIndex++;
        processCurrentBatchItem();
      }
    }, 90000);
  }

  /**
   * Detect the Error modal and schedule a progressive countdown (+10s per loop)
   * before clicking the "Retry" button.
   */
  function checkAndHandleErrorModal() {
    if (isErrorRetryWaiting) return false;
    if (!isErrorModalVisible()) return false;

    const retryBtn = findVisibleErrorRetryButton();
    if (!retryBtn) return false;

    isErrorRetryWaiting = true;
    errorRetryAttempt++;
    const waitSeconds = errorRetryAttempt * 10; // 10s, 20s, 30s, 40s, ...

    const msgEl = document.querySelector(ERROR_MESSAGE_SELECTOR);
    const errorText = msgEl && msgEl.textContent ? msgEl.textContent.trim() : 'Error pop-up';

    // Pause batch safety timeout while waiting for retry countdown
    if (batchState.timeoutTimer) {
      clearTimeout(batchState.timeoutTimer);
      batchState.timeoutTimer = null;
    }

    log(
      'warn',
      `⚠️ Pop-up Error terdeteksi: "${errorText}" — Percobaan Retry #${errorRetryAttempt}, menunggu ${waitSeconds} detik sebelum klik "Retry"…`
    );
    showToast(`⚠️ Error limit! Tunggu ${waitSeconds} dtk lalu klik Retry (#${errorRetryAttempt})`, '⏳');

    let remainingSec = waitSeconds;
    setAutoStatus(`⏳ Retry #${errorRetryAttempt} (${remainingSec}s)…`);
    if (batchState.status === 'running') {
      updateBatchUI(`⚠️ Error! Retry #${errorRetryAttempt} dalam ${remainingSec} dtk…`);
    }

    clearInterval(errorRetryCountdownTimer);
    errorRetryCountdownTimer = setInterval(() => {
      // If modal was closed manually or disappeared on its own, abort countdown
      if (!isErrorModalVisible()) {
        clearInterval(errorRetryCountdownTimer);
        errorRetryCountdownTimer = null;
        isErrorRetryWaiting = false;
        log('info', 'Pop-up Error sudah tertutup — melanjutkan proses vektorisasi.');
        refreshBatchSafetyTimeout();
        return;
      }

      remainingSec--;
      if (remainingSec > 0) {
        setAutoStatus(`⏳ Retry #${errorRetryAttempt} (${remainingSec}s)…`);
        if (batchState.status === 'running') {
          updateBatchUI(`⚠️ Error! Retry #${errorRetryAttempt} dalam ${remainingSec} dtk…`);
        }
      } else {
        // Countdown finished -> click Retry button!
        clearInterval(errorRetryCountdownTimer);
        errorRetryCountdownTimer = null;

        const btnNow = findVisibleErrorRetryButton();
        if (btnNow) {
          log('info', `🔄 Waktu tunggu ${waitSeconds} detik selesai — mengklik tombol "Retry" (Percobaan #${errorRetryAttempt})…`);
          setAutoStatus(`🔄 Clicking Retry #${errorRetryAttempt}…`);
          if (batchState.status === 'running') {
            updateBatchUI(`🔄 Mengklik tombol Retry (#${errorRetryAttempt})…`);
          }
          showToast(`🔄 Mengklik tombol Retry (#${errorRetryAttempt})…`, '🔁');

          try {
            btnNow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            btnNow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            btnNow.click();
          } catch (e) {
            log('error', 'Gagal mengklik tombol Retry pada pop-up Error', e.message);
          }
        }

        // Refresh batch timeout for the retried attempt
        refreshBatchSafetyTimeout();

        // Wait 1.5s after clicking Retry to let the page/server respond.
        // If the Error pop-up is STILL visible (or reappears), releasing
        // `isErrorRetryWaiting = false` allows the watcher to trigger the
        // next loop with waitSeconds + 10s (20s, 30s, 40s, ...).
        errorRetryPostClickTimer = setTimeout(() => {
          isErrorRetryWaiting = false;
          if (isErrorModalVisible()) {
            checkAndHandleErrorModal();
          } else {
            log('info', `✅ Retry #${errorRetryAttempt} terkirim — memantau apakah Error muncul kembali atau proses berlanjut…`);
            // Re-start Pre-Crop check with isRetry=true so errorRetryAttempt is preserved if Error reappears
            startPostUploadPreCropCheck('retry-image', true);
          }
        }, 1500);
      }
    }, 1000);

    return true;
  }

  /**
   * Persistent watcher (MutationObserver + 500ms interval) for the Error modal.
   */
  (function installErrorModalWatcher() {
    checkAndHandleErrorModal();

    const errorObserver = new MutationObserver(() => {
      if (!isErrorRetryWaiting && isErrorModalVisible()) {
        checkAndHandleErrorModal();
      }
    });

    errorObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden']
    });

    setInterval(() => {
      if (!isErrorRetryWaiting && isErrorModalVisible()) {
        checkAndHandleErrorModal();
      }
    }, 500);

    log('info', 'Error modal auto-retry watcher installed.');
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // BATCH FOLDER VECTORIZATION ENGINE
  // Processes an entire folder of images sequentially in-page (SPA) with a
  // manually configurable delay (in seconds) between each process.
  // ─────────────────────────────────────────────────────────────────────────────
  const batchState = {
    files: [],
    currentIndex: 0,
    status: 'idle', // 'idle' | 'ready' | 'running' | 'paused' | 'completed'
    delaySeconds: 3,
    countdownTimer: null,
    timeoutTimer: null
  };

  // Load saved delay preference from storage
  try {
    chrome.storage.local.get(['vaiBatchDelaySeconds'], (res) => {
      if (res && typeof res.vaiBatchDelaySeconds === 'number' && res.vaiBatchDelaySeconds >= 1) {
        batchState.delaySeconds = res.vaiBatchDelaySeconds;
        const delayInput = document.getElementById('vai-batch-delay-input');
        if (delayInput) delayInput.value = batchState.delaySeconds;
      }
    });
  } catch (_) {}

  function getBatchDelaySeconds() {
    const input = document.getElementById('vai-batch-delay-input');
    if (input) {
      const val = parseFloat(input.value);
      if (!isNaN(val) && val >= 0) {
        batchState.delaySeconds = val;
      }
    }
    return batchState.delaySeconds;
  }

  function clearBatchTimers() {
    if (batchState.countdownTimer) {
      clearInterval(batchState.countdownTimer);
      batchState.countdownTimer = null;
    }
    if (batchState.timeoutTimer) {
      clearTimeout(batchState.timeoutTimer);
      batchState.timeoutTimer = null;
    }
  }

  function updateBatchUI(statusText) {
    const panel      = document.getElementById('vai-batch-panel');
    const counterEl  = document.getElementById('vai-batch-counter');
    const fillEl     = document.getElementById('vai-batch-progress-fill');
    const fileEl     = document.getElementById('vai-batch-current-file');
    const btnStart   = document.getElementById('vai-btn-batch-start');
    const btnPause   = document.getElementById('vai-btn-batch-pause');

    const total = batchState.files.length;
    if (total === 0) {
      if (panel) panel.classList.add('vai-hidden');
      return;
    }

    if (panel) panel.classList.remove('vai-hidden');

    const completed = Math.min(batchState.currentIndex, total);
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    if (counterEl) counterEl.textContent = `${completed} / ${total} (${pct}%)`;
    if (fillEl) fillEl.style.width = `${pct}%`;

    if (fileEl) {
      if (statusText) {
        fileEl.textContent = statusText;
      } else if (batchState.status === 'running' && batchState.files[batchState.currentIndex]) {
        fileEl.textContent = `🔄 [${batchState.currentIndex + 1}/${total}] ${batchState.files[batchState.currentIndex].name}`;
      } else if (batchState.status === 'paused') {
        fileEl.textContent = '⏸️ Batch dijeda (Paused)';
      } else if (batchState.status === 'completed') {
        fileEl.textContent = `✅ Selesai semua (${total} file)`;
      } else if (batchState.status === 'ready') {
        fileEl.textContent = `📁 ${total} file siap diproses`;
      }
    }

    if (btnStart) {
      btnStart.style.display = (batchState.status === 'ready' || batchState.status === 'completed') ? 'flex' : 'none';
    }
    if (btnPause) {
      btnPause.style.display = (batchState.status === 'running' || batchState.status === 'paused') ? 'flex' : 'none';
      btnPause.textContent = batchState.status === 'paused' ? '▶️ Lanjut' : '⏸️ Pause';
    }
  }

  /**
   * Load selected folder/files into the batch queue and start processing
   */
  function loadFilesForBatch(fileList) {
    const validFiles = Array.from(fileList || []).filter((f) =>
      /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)
    );

    if (validFiles.length === 0) {
      log('warn', 'Tidak ada file gambar (.jpg, .png, .webp, .bmp, .gif) di dalam folder yang dipilih.');
      showToast('Tidak ditemukan file gambar di folder tersebut!', '⚠️');
      return;
    }

    // Sort naturally by filename
    validFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    clearBatchTimers();
    batchState.files = validFiles;
    batchState.currentIndex = 0;
    batchState.status = 'ready';

    const delaySec = getBatchDelaySeconds();
    log('info', `Folder batch dimuat: ${validFiles.length} gambar siap diproses (Jeda: ${delaySec} detik/proses).`);
    showToast(`📁 ${validFiles.length} gambar siap diproses!`, '✅');
    updateBatchUI();

    // Auto-start batch processing after 600ms
    setTimeout(() => {
      startBatchProcessing();
    }, 600);
  }

  function startBatchProcessing() {
    if (!isLicenseAuthorized) {
      log('warn', `Batch blocked — StockStudio Pro license unauthorized (${lastLicenseErrorCode}).`);
      showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
      return;
    }
    if (!batchState.files || batchState.files.length === 0) return;

    if (batchState.currentIndex >= batchState.files.length) {
      batchState.currentIndex = 0;
    }

    batchState.status = 'running';
    const delaySec = getBatchDelaySeconds();
    log('info', `🚀 Memulai proses batch (${batchState.files.length} file, jeda ${delaySec} detik per proses).`);
    updateBatchUI();
    processCurrentBatchItem();
  }

  function togglePauseBatch() {
    if (batchState.status === 'running') {
      batchState.status = 'paused';
      clearBatchTimers();
      log('info', '⏸️ Proses batch dijeda oleh pengguna.');
      showToast('Batch dijeda (Paused)', '⏸️');
      updateBatchUI();
    } else if (batchState.status === 'paused') {
      batchState.status = 'running';
      log('info', '▶️ Melanjutkan proses batch…');
      showToast('Melanjutkan batch…', '▶️');
      updateBatchUI();
      processCurrentBatchItem();
    }
  }

  function stopBatchProcessing() {
    clearBatchTimers();
    stopPostUploadPreCropCheck();
    resetErrorRetryState();
    batchState.status = 'idle';
    batchState.files = [];
    batchState.currentIndex = 0;
    log('info', '⏹️ Proses batch dihentikan oleh pengguna.');
    showToast('Batch dihentikan', '⏹️');
    setAutoStatus('Stopped');
    updateBatchUI();
  }

  /**
   * Feed the current image in the queue to Vectorizer.ai without reloading the page
   */
  function processCurrentBatchItem() {
    if (batchState.status !== 'running') return;

    const total = batchState.files.length;
    if (batchState.currentIndex >= total) {
      clearBatchTimers();
      batchState.status = 'completed';
      updateBatchUI();
      setAutoStatus('✅ Batch Complete!');
      log('info', `🎉 Proses vektorisasi massal selesai! Seluruh ${total} file telah didownload.`);
      showToast(`🎉 Batch selesai! ${total} file berhasil didownload.`, '✅');
      return;
    }

    const file = batchState.files[batchState.currentIndex];
    hasAutoDownloadedCurrent = false;

    const stepLabel = `[${batchState.currentIndex + 1}/${total}]`;
    log('info', `${stepLabel} Mengupload "${file.name}" (${(file.size / 1024).toFixed(1)} KB)…`);
    setAutoStatus(`⚡ Batch ${batchState.currentIndex + 1}/${total}`);
    updateBatchUI(`🔄 ${stepLabel} Mengupload: ${file.name}`);

    // 1. Set the filename in inject.js so the downloaded SVG retains the exact original name
    window.postMessage({
      type: 'VECTORIZE_AI_SET_FILENAME',
      filename: file.name
    }, '*');

    // 2. Start post-upload Pre-Crop pop-up detector
    startPostUploadPreCropCheck(file.name);

    // 3. Feed the file to Vectorizer.ai's native in-page message receiver (no page reload!)
    try {
      window.postMessage({ file: file }, '*');
    } catch (e) {
      log('error', `Gagal mengirim file "${file.name}" ke Vectorizer.ai`, e.message);
    }

    // 4. Safety timeout (90s) per file so batch doesn't get stuck if network/site hangs
    clearTimeout(batchState.timeoutTimer);
    batchState.timeoutTimer = setTimeout(() => {
      if (batchState.status === 'running') {
        log('warn', `⚠️ Timeout (90d) pada "${file.name}" — melewati ke file berikutnya…`);
        batchState.currentIndex++;
        processCurrentBatchItem();
      }
    }, 90000);
  }

  /**
   * Called when VECTORIZE_AI_RESULT_READY fires while batchState.status === 'running'
   */
  function handleBatchItemComplete(vectorData) {
    if (batchState.status !== 'running') return;
    if (hasAutoDownloadedCurrent) return;
    hasAutoDownloadedCurrent = true;

    clearTimeout(batchState.timeoutTimer);

    const total = batchState.files.length;
    const currentFile = batchState.files[batchState.currentIndex];
    const rawName = (currentFile && currentFile.name) || (vectorData && vectorData.name) || 'vectorized-art';
    const cleanName = rawName.replace(/\.[^/.]+$/, '');
    const stepLabel = `[${batchState.currentIndex + 1}/${total}]`;

    log('info', `${stepLabel} Vektorisasi selesai — mendownload "${cleanName}.svg"…`);
    updateBatchUI(`📥 ${stepLabel} Mendownload: ${cleanName}.svg`);

    setTimeout(() => {
      try {
        window.postMessage({
          type: 'VECTORIZE_AI_TRIGGER_DOWNLOAD',
          format: 'svg',
          options: exportOptions
        }, '*');
        showToast(`📥 [${batchState.currentIndex + 1}/${total}] Downloaded: ${cleanName}.svg`, '✅');
      } catch (e) {
        log('error', `Gagal mendownload "${cleanName}.svg"`, e.message);
      }

      // Advance index
      batchState.currentIndex++;
      updateBatchUI();

      // Check if all items are finished
      if (batchState.currentIndex >= total) {
        processCurrentBatchItem();
        return;
      }

      // Wait for the manually configured delay before starting the next file
      const delaySec = getBatchDelaySeconds();
      let remainingSec = Math.max(1, Math.round(delaySec));

      log('info', `⏳ Jeda ${remainingSec} detik sebelum memproses file berikutnya (${batchState.files[batchState.currentIndex].name})…`);
      updateBatchUI(`⏳ Jeda ${remainingSec} dtk → lanjut: ${batchState.files[batchState.currentIndex].name}`);
      setAutoStatus(`⏳ Jeda ${remainingSec}s…`);

      clearInterval(batchState.countdownTimer);
      batchState.countdownTimer = setInterval(() => {
        if (batchState.status !== 'running') {
          clearInterval(batchState.countdownTimer);
          batchState.countdownTimer = null;
          return;
        }

        remainingSec--;
        if (remainingSec > 0) {
          const nextName = batchState.files[batchState.currentIndex]
            ? batchState.files[batchState.currentIndex].name
            : '';
          updateBatchUI(`⏳ Jeda ${remainingSec} dtk → lanjut: ${nextName}`);
          setAutoStatus(`⏳ Jeda ${remainingSec}s…`);
        } else {
          clearInterval(batchState.countdownTimer);
          batchState.countdownTimer = null;
          processCurrentBatchItem();
        }
      }, 1000);
    }, 500);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTOMATION: STEP 2 — Auto-download SVG once vector is ready (Single-File Mode)
  // Called from the VECTORIZE_AI_RESULT_READY handler below
  // ─────────────────────────────────────────────────────────────────────────────
  let hasAutoDownloadedCurrent = false;

  function autoDownloadAndReturn(vectorData) {
    if (!isLicenseAuthorized) {
      log('warn', 'Auto-download blocked — StockStudio Pro license unauthorized.');
      return;
    }
    if (!vectorData || !vectorData.svgString) {
      log('error', 'Auto-download skipped — vector data missing or empty.');
      return;
    }

    // Prevent duplicate auto-downloads for the same image
    if (hasAutoDownloadedCurrent) {
      log('info', 'Auto-download already triggered for this image — skipping duplicate.');
      return;
    }
    hasAutoDownloadedCurrent = true;

    log('info', `Auto-downloading SVG: ${vectorData.name || 'vectorized-art'}`);
    setAutoStatus('📥 Downloading SVG…');

    // Small safety delay before triggering download
    setTimeout(() => {
      try {
        window.postMessage({
          type: 'VECTORIZE_AI_TRIGGER_DOWNLOAD',
          format: 'svg',
          options: exportOptions
        }, '*');
        showToast(`Auto-downloaded: ${(vectorData.name || 'art').replace(/\.[^/.]+$/, '')}.svg`, '✅');
        log('info', 'SVG download triggered successfully.');
      } catch (e) {
        log('error', 'Auto-download postMessage failed', e.message);
      }

      // STEP 3: Navigate back to vectorizer.ai after a delay
      setTimeout(() => {
        log('info', `Navigating back to vectorizer.ai after ${POST_DOWNLOAD_DELAY_MS}ms.`);
        setAutoStatus('🔄 Returning to Vectorizer.ai…');
        try {
          window.location.href = 'https://vectorizer.ai/';
        } catch (e) {
          log('error', 'Navigation back failed', e.message);
        }
      }, POST_DOWNLOAD_DELAY_MS);
    }, 600); // 600ms before download so page has settled
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTO-MODE STATUS DISPLAY (updates the widget badge label)
  // ─────────────────────────────────────────────────────────────────────────────
  function setAutoStatus(text) {
    const badge = document.getElementById('vai-status-badge');
    const infoStatus = document.getElementById('vai-info-status');
    if (badge) badge.textContent = text;
    if (infoStatus) infoStatus.textContent = text;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WIDGET HTML
  // ─────────────────────────────────────────────────────────────────────────────
  function createWidget() {
    if (document.getElementById('vectorize-ai-download-container')) return;

    const container = document.createElement('div');
    container.id = 'vectorize-ai-download-container';

    container.innerHTML = `
      <div class="vai-widget-card" id="vai-card">
        <!-- Header -->
        <div class="vai-widget-header" id="vai-header">
          <div class="vai-brand">
            <div class="vai-logo-icon">V</div>
            <span>Vectorize.ai</span>
            <span class="vai-status-badge vai-status-waiting" id="vai-status-badge">Waiting</span>
          </div>
          <div class="vai-header-actions">
            <button class="vai-icon-btn" id="vai-toggle-btn" title="Collapse / Expand" aria-label="Toggle">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="18 15 12 9 6 15"></polyline>
              </svg>
            </button>
          </div>
        </div>

        <!-- Body -->
        <div class="vai-widget-body" id="vai-body">
          <!-- Information Box -->
          <div class="vai-info-box" id="vai-info-box">
            <div class="vai-info-item">
              <span class="vai-info-label">Status</span>
              <span class="vai-info-val" id="vai-info-status">Upload an image</span>
            </div>
            <div class="vai-info-item">
              <span class="vai-info-label">Resolution</span>
              <span class="vai-info-val" id="vai-info-res">-</span>
            </div>
            <div class="vai-info-item">
              <span class="vai-info-label">Vector Shapes</span>
              <span class="vai-info-val" id="vai-info-shapes">-</span>
            </div>
            <div class="vai-info-item">
              <span class="vai-info-label">Palette</span>
              <span class="vai-info-val" id="vai-info-palette">-</span>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="vai-btn-group">
            <button class="vai-btn vai-btn-primary" id="vai-btn-download-svg" disabled>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Download SVG (Free)</span>
            </button>

            <div class="vai-btn-row">
              <button class="vai-btn vai-btn-secondary" id="vai-btn-download-png2" disabled title="Export as 2x PNG">
                🖼️ PNG 2x
              </button>
              <button class="vai-btn vai-btn-secondary" id="vai-btn-download-png4" disabled title="Export as 4x High-Res PNG">
                🖼️ PNG 4x
              </button>
              <button class="vai-btn vai-btn-secondary" id="vai-btn-copy-svg" disabled title="Copy raw SVG markup to clipboard">
                📋 Copy
              </button>
            </div>
          </div>

          <!-- Auto Mode Controls -->
          <div class="vai-auto-controls" id="vai-auto-controls">
            <div class="vai-option-row">
              <span>⚡ Auto-download on complete:</span>
              <label class="vai-toggle-label">
                <input type="checkbox" id="vai-auto-download-toggle" ${autoDownloadEnabled ? 'checked' : ''}>
                <span class="vai-toggle-track"></span>
              </label>
            </div>
            <button class="vai-btn vai-btn-accent" id="vai-btn-trigger-auto" title="Click Vectorize button &amp; start auto-workflow">
              🚀 Run Auto-Vectorize
            </button>
          </div>

          <!-- Batch Folder Vectorization Section -->
          <div class="vai-batch-section" id="vai-batch-section">
            <div class="vai-section-title">📁 Batch Vektorisasi Folder</div>

            <div class="vai-option-row">
              <span>⏱️ Jeda per proses (detik):</span>
              <div class="vai-delay-input-wrap">
                <input type="number" id="vai-batch-delay-input" min="1" max="600" step="1" value="${batchState.delaySeconds}">
                <span>dtk</span>
              </div>
            </div>

            <!-- Hidden Inputs for Folder and Multi-File Selection -->
            <input type="file" id="vai-batch-folder-input" webkitdirectory directory multiple style="display:none">
            <input type="file" id="vai-batch-files-input" multiple accept=".png,.jpg,.jpeg,.webp,.bmp,.gif,image/*" style="display:none">

            <div class="vai-btn-row">
              <button class="vai-btn vai-btn-batch" id="vai-btn-pick-folder" title="Pilih seluruh isi folder untuk vektorisasi massal">
                📁 Pilih Folder
              </button>
              <button class="vai-btn vai-btn-secondary" id="vai-btn-pick-files" title="Pilih banyak file gambar sekaligus (Ctrl+A)">
                🖼️ Pilih File
              </button>
            </div>

            <!-- Active Batch Progress Panel -->
            <div class="vai-batch-panel vai-hidden" id="vai-batch-panel">
              <div class="vai-batch-progress-header">
                <span>Progress Batch</span>
                <span id="vai-batch-counter">0 / 0 (0%)</span>
              </div>
              <div class="vai-batch-progress-track">
                <div class="vai-batch-progress-fill" id="vai-batch-progress-fill" style="width:0%"></div>
              </div>
              <div class="vai-batch-current-file" id="vai-batch-current-file">Siap</div>
              <div class="vai-btn-row">
                <button class="vai-btn vai-btn-accent" id="vai-btn-batch-start" style="display:none">
                  ▶️ Mulai
                </button>
                <button class="vai-btn vai-btn-secondary" id="vai-btn-batch-pause" style="display:none">
                  ⏸️ Pause
                </button>
                <button class="vai-btn vai-btn-danger" id="vai-btn-batch-stop">
                  ⏹️ Stop
                </button>
              </div>
            </div>
          </div>

          <!-- Error Log Panel -->
          <div class="vai-log-section" id="vai-log-section">
            <div class="vai-log-header">
              <span>📋 Error Log</span>
              <button class="vai-log-clear-btn" id="vai-log-clear">Clear</button>
            </div>
            <div class="vai-log-panel" id="vai-log-panel"></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    attachWidgetEvents();
    log('info', 'Widget created and attached to DOM.');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WIDGET EVENT LISTENERS
  // ─────────────────────────────────────────────────────────────────────────────
  function attachWidgetEvents() {
    const card          = document.getElementById('vai-card');
    const header        = document.getElementById('vai-header');
    const toggleBtn     = document.getElementById('vai-toggle-btn');
    const btnSvg        = document.getElementById('vai-btn-download-svg');
    const btnPng2       = document.getElementById('vai-btn-download-png2');
    const btnPng4       = document.getElementById('vai-btn-download-png4');
    const btnCopy       = document.getElementById('vai-btn-copy-svg');
    const autoToggle    = document.getElementById('vai-auto-download-toggle');
    const btnRunAuto    = document.getElementById('vai-btn-trigger-auto');
    const btnClearLog   = document.getElementById('vai-log-clear');

    // ── Collapse / Expand ──
    function toggleCollapse(e) {
      if (e.target.closest('.vai-icon-btn') || e.currentTarget === header) {
        isWidgetCollapsed = !isWidgetCollapsed;
        card.classList.toggle('vai-collapsed', isWidgetCollapsed);
        if (toggleBtn) {
          toggleBtn.innerHTML = isWidgetCollapsed
            ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`
            : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
        }
      }
    }
    if (header) header.addEventListener('click', toggleCollapse);

    // ── Manual Downloads ──
    if (btnSvg) {
      btnSvg.addEventListener('click', () => {
        if (!isLicenseAuthorized) {
          showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
          return;
        }
        log('info', 'User clicked Download SVG.');
        window.postMessage({ type: 'VECTORIZE_AI_TRIGGER_DOWNLOAD', format: 'svg', options: exportOptions }, '*');
        showToast('SVG download initiated!', '📥');
      });
    }
    if (btnPng2) {
      btnPng2.addEventListener('click', () => {
        if (!isLicenseAuthorized) {
          showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
          return;
        }
        log('info', 'User clicked Download PNG 2x.');
        window.postMessage({ type: 'VECTORIZE_AI_TRIGGER_DOWNLOAD', format: 'png', scale: 2, options: exportOptions }, '*');
        showToast('Generating 2x PNG download…', '🖼️');
      });
    }
    if (btnPng4) {
      btnPng4.addEventListener('click', () => {
        if (!isLicenseAuthorized) {
          showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
          return;
        }
        log('info', 'User clicked Download PNG 4x.');
        window.postMessage({ type: 'VECTORIZE_AI_TRIGGER_DOWNLOAD', format: 'png', scale: 4, options: exportOptions }, '*');
        showToast('Generating 4x High-Res PNG…', '🖼️');
      });
    }
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        if (!isLicenseAuthorized) {
          showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
          return;
        }
        if (!currentVectorData || !currentVectorData.svgString) {
          log('warn', 'Copy attempted but no SVG data available.');
          return;
        }
        navigator.clipboard.writeText(currentVectorData.svgString)
          .then(() => { showToast('SVG code copied to clipboard!', '📋'); log('info', 'SVG copied to clipboard.'); })
          .catch(err => { log('error', 'Clipboard copy failed', err.message); showToast('Failed to copy SVG', '⚠️'); });
      });
    }

    // ── Auto-download toggle ──
    if (autoToggle) {
      autoToggle.addEventListener('change', () => {
        autoDownloadEnabled = autoToggle.checked;
        log('info', `Auto-download ${autoDownloadEnabled ? 'enabled' : 'disabled'}.`);
        showToast(`Auto-download ${autoDownloadEnabled ? 'ON' : 'OFF'}`, autoDownloadEnabled ? '⚡' : '⏹️');
      });
    }

    // ── Run Auto-Vectorize button ──
    if (btnRunAuto) {
      btnRunAuto.addEventListener('click', () => {
        if (!isLicenseAuthorized) {
          showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
          return;
        }
        log('info', 'User triggered Run Auto-Vectorize.');
        setTimeout(() => {
          if (!tryAutoClickVectorizeButton()) {
            log('warn', '"Vectorize image" button not found — user must be on the upload page.');
            showToast('Button not found. Make sure you are on the Vectorizer.ai upload page.', '⚠️');
          }
        }, AUTO_CLICK_DELAY_MS);
      });
    }

    // ── Batch Folder Controls ──
    const delayInput     = document.getElementById('vai-batch-delay-input');
    const folderInput    = document.getElementById('vai-batch-folder-input');
    const filesInput     = document.getElementById('vai-batch-files-input');
    const btnPickFolder  = document.getElementById('vai-btn-pick-folder');
    const btnPickFiles   = document.getElementById('vai-btn-pick-files');
    const btnBatchStart  = document.getElementById('vai-btn-batch-start');
    const btnBatchPause  = document.getElementById('vai-btn-batch-pause');
    const btnBatchStop   = document.getElementById('vai-btn-batch-stop');

    if (delayInput) {
      delayInput.addEventListener('change', () => {
        const val = Math.max(1, parseInt(delayInput.value, 10) || 3);
        delayInput.value = val;
        batchState.delaySeconds = val;
        try { chrome.storage.local.set({ vaiBatchDelaySeconds: val }); } catch (_) {}
        log('info', `Jeda waktu per proses diatur ke: ${val} detik.`);
      });
    }

    if (btnPickFolder && folderInput) {
      btnPickFolder.addEventListener('click', () => {
        if (!isLicenseAuthorized) {
          showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
          return;
        }
        folderInput.value = '';
        folderInput.click();
      });
      folderInput.addEventListener('change', () => {
        if (folderInput.files && folderInput.files.length > 0) {
          loadFilesForBatch(folderInput.files);
        }
      });
    }

    if (btnPickFiles && filesInput) {
      btnPickFiles.addEventListener('click', () => {
        if (!isLicenseAuthorized) {
          showToast('🔒 Activate your license in StockStudio Pro Desktop first.', '⚠️');
          return;
        }
        filesInput.value = '';
        filesInput.click();
      });
      filesInput.addEventListener('change', () => {
        if (filesInput.files && filesInput.files.length > 0) {
          loadFilesForBatch(filesInput.files);
        }
      });
    }

    if (btnBatchStart) {
      btnBatchStart.addEventListener('click', () => startBatchProcessing());
    }
    if (btnBatchPause) {
      btnBatchPause.addEventListener('click', () => togglePauseBatch());
    }
    if (btnBatchStop) {
      btnBatchStop.addEventListener('click', () => stopBatchProcessing());
    }

    // ── Clear log ──
    if (btnClearLog) {
      btnClearLog.addEventListener('click', () => {
        const panel = document.getElementById('vai-log-panel');
        if (panel) panel.innerHTML = '';
        errorLog.length = 0;
        try { chrome.storage.local.remove('vaiErrorLog'); } catch (_) {}
        log('info', 'Error log cleared.');
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UPDATE WIDGET UI when vector is ready
  // ─────────────────────────────────────────────────────────────────────────────
  function updateWidgetUI(data) {
    createWidget();

    const badge      = document.getElementById('vai-status-badge');
    const infoStatus = document.getElementById('vai-info-status');
    const infoRes    = document.getElementById('vai-info-res');
    const infoShapes = document.getElementById('vai-info-shapes');
    const infoPalette= document.getElementById('vai-info-palette');
    const btnSvg     = document.getElementById('vai-btn-download-svg');
    const btnPng2    = document.getElementById('vai-btn-download-png2');
    const btnPng4    = document.getElementById('vai-btn-download-png4');
    const btnCopy    = document.getElementById('vai-btn-copy-svg');

    if (badge) { badge.textContent = 'Ready!'; badge.className = 'vai-status-badge vai-status-ready'; }
    if (infoStatus) infoStatus.textContent = 'Vector ready';
    if (infoRes)    infoRes.textContent    = `${data.width} × ${data.height} px`;
    if (infoShapes) infoShapes.textContent = `${data.shapesCount} shapes`;
    if (infoPalette)infoPalette.textContent= `${data.paletteCount || '-'} colors`;

    [btnSvg, btnPng2, btnPng4, btnCopy].forEach(btn => { if (btn) btn.disabled = !isLicenseAuthorized; });

    if (!isLicenseAuthorized) {
      applyLicenseGateToWidget();
      return;
    }

    showToast(`Vector extracted! (${data.width}×${data.height}, ${data.shapesCount} shapes)`, '✨');
    log('info', `Vector ready — ${data.name || 'unnamed'} | ${data.width}×${data.height} | ${data.shapesCount} shapes.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UPLOAD LISTENERS — detect image upload from file input, drag-drop, or paste
  // ─────────────────────────────────────────────────────────────────────────────
  document.addEventListener('change', (e) => {
    const target = e.target;
    if (target && target.tagName === 'INPUT' && target.type === 'file') {
      // Ignore our extension's own batch inputs (handled by loadFilesForBatch)
      if (target.id && target.id.startsWith('vai-')) return;

      const file = target.files && target.files[0];
      if (file) {
        startPostUploadPreCropCheck(file.name);
      }
    }
  }, true);

  document.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) {
      startPostUploadPreCropCheck(file.name);
    }
  }, true);

  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (items && items.length > 0) {
      startPostUploadPreCropCheck('clipboard-image');
    }
  }, true);

  // ─────────────────────────────────────────────────────────────────────────────
  // MESSAGE BUS — receive from inject.js (MAIN world)
  // ─────────────────────────────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (!event.data || typeof event.data.type !== 'string') return;

    if (event.data.type === 'VECTORIZE_AI_FILE_UPLOADED') {
      startPostUploadPreCropCheck(event.data.filename);
      return;
    }

    if (event.data.type === 'VECTORIZE_AI_RESULT_READY') {
      // Stop post-upload Pre-Crop check & reset Error Retry counter since vectorization succeeded
      stopPostUploadPreCropCheck('Pop-up Pre-Crop tidak muncul — vektorisasi selesai normal.');
      resetErrorRetryState();

      currentVectorData = event.data.detail;

      try {
        chrome.storage.local.set({ lastVectorData: currentVectorData, lastUpdated: Date.now() });
      } catch (e) {
        log('warn', 'Storage set failed', e.message);
      }

      updateWidgetUI(currentVectorData);

      // ── If Batch Folder mode is active, handle via batch engine (in-page, no reload) ──
      if (batchState.status === 'running') {
        handleBatchItemComplete(currentVectorData);
        return;
      }

      // ── Single-file Auto-download workflow ──
      if (autoDownloadEnabled) {
        log('info', 'Auto-download enabled — starting auto-download after vectorization.');
        autoDownloadAndReturn(currentVectorData);
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // MESSAGE BUS — receive from popup / background
  // ─────────────────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_VECTOR_DATA') {
      if (currentVectorData) {
        sendResponse({ success: true, data: currentVectorData });
      } else {
        window.postMessage({ type: 'VECTORIZE_AI_REQUEST_CURRENT_DATA' }, '*');
        sendResponse({ success: false, message: 'No vector data available yet.' });
      }
      return true;
    }

    if (request.type === 'TRIGGER_DOWNLOAD_FROM_POPUP') {
      if (!isLicenseAuthorized) {
        sendResponse({ success: false, error: 'UNAUTHORIZED' });
        return true;
      }
      window.postMessage({
        type: 'VECTORIZE_AI_TRIGGER_DOWNLOAD',
        format: request.format || 'svg',
        scale: request.scale || 2,
        options: request.options || exportOptions
      }, '*');
      sendResponse({ success: true });
      return true;
    }

    if (request.type === 'GET_ERROR_LOG') {
      sendResponse({ success: true, log: errorLog.slice(-50) });
      return true;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // BOOT SEQUENCE
  // ─────────────────────────────────────────────────────────────────────────────
  function boot() {
    createWidget();
    applyLicenseGateToWidget();
    verifyLicenseWithBackground(false).then((authorized) => {
      if (!authorized) {
        log('warn', `Extension locked — StockStudio Pro license check failed (${lastLicenseErrorCode}).`);
        return;
      }
      window.postMessage({ type: 'VECTORIZE_AI_REQUEST_CURRENT_DATA' }, '*');
      // Auto-click the Vectorize button after a short delay to allow SPA to render
      setTimeout(() => {
        if (isLicenseAuthorized) {
          scheduleAutoClickWhenReady();
        }
      }, AUTO_CLICK_DELAY_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
