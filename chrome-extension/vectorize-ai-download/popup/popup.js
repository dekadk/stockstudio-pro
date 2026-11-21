/**
 * Vectorize.ai Download - Popup Controller
 */

(function () {
  'use strict';

  // Elements
  const licenseCard = document.getElementById('license-card');
  const licenseTitle = document.getElementById('license-title');
  const licenseDesc = document.getElementById('license-desc');
  const licenseLockedPanel = document.getElementById('license-locked-panel');
  const btnRecheckLicense = document.getElementById('btn-recheck-license');
  const btnRetryLicense = document.getElementById('btn-retry-license');

  const statusCard = document.getElementById('status-card');
  const statusTitle = document.getElementById('status-title');
  const statusDesc = document.getElementById('status-desc');
  const vectorContent = document.getElementById('vector-content');
  const guideContent = document.getElementById('guide-content');

  const previewViewport = document.getElementById('preview-viewport');
  const previewFilename = document.getElementById('preview-filename');

  const statDim = document.getElementById('stat-dim');
  const statShapes = document.getElementById('stat-shapes');
  const statLoops = document.getElementById('stat-loops');
  const statColors = document.getElementById('stat-colors');

  const btnDownloadSvg = document.getElementById('btn-download-svg');
  const btnDownloadPng1 = document.getElementById('btn-download-png1');
  const btnDownloadPng2 = document.getElementById('btn-download-png2');
  const btnDownloadPng4 = document.getElementById('btn-download-png4');
  const btnCopySvg = document.getElementById('btn-copy-svg');
  const copyBtnText = document.getElementById('copy-btn-text');

  // State
  let currentVectorData = null;
  let activeTabId = null;
  let isLicenseAuthorized = false;

  function describeLicenseError(errorCode) {
    switch (errorCode) {
      case 'NATIVE_HOST_UNAVAILABLE':
      case 'NATIVE_HOST_DISCONNECTED':
      case 'NATIVE_HOST_TIMEOUT':
        return {
          title: 'StockStudio Pro Desktop Required',
          detail: 'Install or update StockStudio Pro Desktop on this computer so this extension can verify your license.'
        };
      case 'NOT_ACTIVATED':
        return {
          title: 'License Not Activated',
          detail: 'Open StockStudio Pro Desktop and activate your License Key on this device.'
        };
      case 'PRODUCT_NOT_ENTITLED':
        return {
          title: 'Extension Not Included in Plan',
          detail: 'Your current StockStudio Pro license does not include Vectorizer Extension entitlement.'
        };
      case 'LICENSE_EXPIRED':
        return {
          title: 'Subscription Expired',
          detail: 'Your StockStudio Pro subscription has expired. Renew in StockStudio Pro Desktop.'
        };
      case 'OFFLINE_GRACE_EXPIRED':
        return {
          title: 'Offline Grace Expired',
          detail: 'Reconnect to the internet and open StockStudio Pro Desktop to refresh your 7-day offline lease.'
        };
      case 'CLOCK_ROLLBACK_DETECTED':
        return {
          title: 'System Clock Error',
          detail: 'System clock rollback detected. Sync your Windows clock and refresh in StockStudio Pro Desktop.'
        };
      case 'LICENSE_REVOKED':
      case 'LICENSE_SUSPENDED':
      case 'LICENSE_INACTIVE':
        return {
          title: 'License Inactive',
          detail: 'This StockStudio Pro license is revoked, suspended, or inactive.'
        };
      default:
        return {
          title: 'License Verification Required',
          detail: 'Open StockStudio Pro Desktop and click Re-check License.'
        };
    }
  }

  function applyLicenseVerdict(verdict) {
    isLicenseAuthorized = Boolean(verdict && verdict.authorized === true);
    if (isLicenseAuthorized) {
      licenseCard.className = 'license-card license-authorized';
      licenseTitle.textContent = verdict.plan_name
        ? `StockStudio Pro · ${verdict.plan_name}`
        : 'StockStudio Pro Licensed';
      const graceNote = verdict.offline_grace_until
        ? `Offline grace until ${verdict.offline_grace_until.slice(0, 10)}`
        : 'Device authorized via StockStudio Pro Desktop';
      licenseDesc.textContent = graceNote;
      licenseLockedPanel.classList.add('hidden');
      statusCard.classList.remove('hidden');
      loadActiveTabVectorState();
    } else {
      const msg = describeLicenseError(verdict && verdict.error_code);
      licenseCard.className = 'license-card license-locked';
      licenseTitle.textContent = msg.title;
      licenseDesc.textContent = msg.detail;
      licenseLockedPanel.classList.remove('hidden');
      statusCard.classList.add('hidden');
      vectorContent.classList.add('hidden');
      guideContent.classList.add('hidden');
    }
  }

  function checkLicenseAndBoot(forceRefresh = false) {
    licenseCard.className = 'license-card license-checking';
    licenseTitle.textContent = 'Checking StockStudio Pro license…';
    licenseDesc.textContent = 'Verifying device authorization via StockStudio Pro Desktop';
    chrome.runtime.sendMessage({ type: 'GET_LICENSE_STATUS', forceRefresh }, (response) => {
      if (chrome.runtime.lastError || !response || !response.verdict) {
        applyLicenseVerdict({ authorized: false, error_code: 'NATIVE_HOST_UNAVAILABLE' });
        return;
      }
      applyLicenseVerdict(response.verdict);
    });
  }

  /**
   * Safe file download helper
   */
  function downloadBlob(blob, filename) {
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
   * Helper: Render SVG to PNG at specified scale
   */
  function exportSvgToPng(svgString, filename, scale = 2) {
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

      canvas.toBlob((pngBlob) => {
        URL.revokeObjectURL(url);
        if (pngBlob) {
          const pngName = filename.replace(/\.svg$/i, '') + `@${scale}x.png`;
          downloadBlob(pngBlob, pngName);
        }
      }, 'image/png');
    };

    img.onerror = function (e) {
      URL.revokeObjectURL(url);
      console.error('[Popup] PNG rendering error:', e);
      alert('Could not render PNG from SVG.');
    };

    img.src = url;
  }

  /**
   * Return SVG string for preview/export
   */
  function getAdjustedSvgString(rawSvg) {
    return rawSvg || '';
  }

  /**
   * Update UI to display the vector details
   */
  function displayVectorData(data) {
    if (!data || !data.svgString) return;
    currentVectorData = data;

    // Update status
    statusCard.className = 'status-card status-ready';
    statusTitle.textContent = 'Vector Output Ready!';
    statusDesc.textContent = `${data.width} × ${data.height} px • ${data.shapesCount} vector shapes`;

    // Update stats
    statDim.textContent = `${data.width} × ${data.height} px`;
    statShapes.textContent = data.shapesCount.toLocaleString();
    statLoops.textContent = (data.loopsCount || data.shapesCount).toLocaleString();
    statColors.textContent = `${data.paletteCount || '-'} colors`;

    // Update filename
    const cleanName = (data.name || 'vectorized-art').replace(/\.[^/.]+$/, '');
    previewFilename.textContent = `${cleanName}.svg`;

    // Render preview
    const svgToRender = getAdjustedSvgString(data.svgString);
    previewViewport.innerHTML = svgToRender;

    // Show vector content, hide empty guide
    vectorContent.classList.remove('hidden');
    guideContent.classList.add('hidden');
  }

  /**
   * Show waiting / empty state
   */
  function showWaitingState(isOnVectorizer = true) {
    vectorContent.classList.add('hidden');
    guideContent.classList.remove('hidden');

    if (isOnVectorizer) {
      statusCard.className = 'status-card status-waiting';
      statusTitle.textContent = 'Waiting for image...';
      statusDesc.textContent = 'Upload or paste an image on Vectorizer.ai';
    } else {
      statusCard.className = 'status-card status-waiting';
      statusTitle.textContent = 'Not on Vectorizer.ai';
      statusDesc.textContent = 'Open Vectorizer.ai in a tab to use this tool.';
    }
  }

  /**
   * Query active tab vector state (only called when license is authorized)
   */
  function loadActiveTabVectorState() {
    if (!isLicenseAuthorized) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab) return;

      activeTabId = activeTab.id;
      const url = activeTab.url || '';
      const isVectorizerTab = /vectoriz(er|e)\.ai/i.test(url);

      // 1. Try reading from chrome.storage.local first
      chrome.storage.local.get(['lastVectorData', 'lastUpdated'], (result) => {
        if (!isLicenseAuthorized) return;
        if (result.lastVectorData && isVectorizerTab) {
          displayVectorData(result.lastVectorData);
        } else if (!isVectorizerTab) {
          showWaitingState(false);
          return;
        } else {
          showWaitingState(true);
        }

        // 2. Also ask active content script for the latest live state
        if (isVectorizerTab) {
          chrome.tabs.sendMessage(activeTabId, { type: 'GET_VECTOR_DATA' }, (response) => {
            if (chrome.runtime.lastError || !isLicenseAuthorized) {
              // Content script might not be injected yet or page is loading
              return;
            }
            if (response && response.success && response.data) {
              displayVectorData(response.data);
            }
          });
        }
      });
    });
  }

  /**
   * Initialize popup with StockStudio Pro unified license check
   */
  function init() {
    attachEventHandlers();
    checkLicenseAndBoot(false);
  }

  /**
   * Attach button listeners
   */
  function attachEventHandlers() {
    if (btnRecheckLicense) {
      btnRecheckLicense.addEventListener('click', () => checkLicenseAndBoot(true));
    }
    if (btnRetryLicense) {
      btnRetryLicense.addEventListener('click', () => checkLicenseAndBoot(true));
    }

    // Download SVG
    btnDownloadSvg.addEventListener('click', () => {
      if (!isLicenseAuthorized || !currentVectorData) return;
      const cleanName = (currentVectorData.name || 'vectorized-art').replace(/\.[^/.]+$/, '');
      const finalSvg = getAdjustedSvgString(currentVectorData.svgString);
      const blob = new Blob([finalSvg], { type: 'image/svg+xml;charset=utf-8' });
      downloadBlob(blob, `${cleanName}.svg`);
    });

    // Download PNG 1x
    btnDownloadPng1.addEventListener('click', () => {
      if (!isLicenseAuthorized || !currentVectorData) return;
      const cleanName = (currentVectorData.name || 'vectorized-art').replace(/\.[^/.]+$/, '');
      const finalSvg = getAdjustedSvgString(currentVectorData.svgString);
      exportSvgToPng(finalSvg, cleanName, 1);
    });

    // Download PNG 2x
    btnDownloadPng2.addEventListener('click', () => {
      if (!isLicenseAuthorized || !currentVectorData) return;
      const cleanName = (currentVectorData.name || 'vectorized-art').replace(/\.[^/.]+$/, '');
      const finalSvg = getAdjustedSvgString(currentVectorData.svgString);
      exportSvgToPng(finalSvg, cleanName, 2);
    });

    // Download PNG 4x
    btnDownloadPng4.addEventListener('click', () => {
      if (!isLicenseAuthorized || !currentVectorData) return;
      const cleanName = (currentVectorData.name || 'vectorized-art').replace(/\.[^/.]+$/, '');
      const finalSvg = getAdjustedSvgString(currentVectorData.svgString);
      exportSvgToPng(finalSvg, cleanName, 4);
    });

    // Copy SVG Code
    btnCopySvg.addEventListener('click', () => {
      if (!isLicenseAuthorized || !currentVectorData) return;
      const finalSvg = getAdjustedSvgString(currentVectorData.svgString);
      navigator.clipboard.writeText(finalSvg)
        .then(() => {
          copyBtnText.textContent = 'Copied to Clipboard!';
          btnCopySvg.style.borderColor = '#00D395';
          btnCopySvg.style.color = '#00D395';
          setTimeout(() => {
            copyBtnText.textContent = 'Copy Raw SVG Code';
            btnCopySvg.style.borderColor = '';
            btnCopySvg.style.color = '';
          }, 2000);
        })
        .catch((err) => {
          console.error('[Popup] Copy failed:', err);
        });
    });
  }

  document.addEventListener('DOMContentLoaded', init);

})();
