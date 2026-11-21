/**
 * StockStudio Pro — Thin Native Messaging License Client
 *
 * Connects to `com.stockstudiopro.license` (`stockstudio-nmh.exe`) to obtain
 * a minimal, sanitized authorization verdict for `vectorizer_extension`.
 *
 * Security invariants:
 * - Never requests, receives, or stores license keys, activation tokens,
 *   lease tokens, or device fingerprints.
 * - Never persists authorization verdicts in `chrome.storage.local`
 *   (volatile memory + `chrome.storage.session` only, bounded by short TTL
 *   and never exceeding `expires_at` or `offline_grace_until`).
 * - Always fails closed when the host is unavailable or returns malformed data.
 */

(function (globalScope) {
  'use strict';

  const NATIVE_HOST_NAME = 'com.stockstudiopro.license';
  const COMMAND_GET_LICENSE_STATUS = 'get_license_status';
  const PRODUCT_ID = 'vectorizer_extension';
  const SESSION_CACHE_KEY = 'ssproLicenseVerdict';
  const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const NATIVE_TIMEOUT_MS = 5000;

  let memoryCache = null;

  function generateRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      let hex = '';
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return `ext_${hex}`;
    }
    return `ext_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function makeDeniedVerdict(errorCode, licenseStatus, nowMs) {
    return {
      authorized: false,
      license_status: licenseStatus || 'unauthorized',
      plan_name: null,
      expires_at: null,
      offline_grace_until: null,
      products: [],
      error_code: errorCode || 'UNAUTHORIZED',
      checked_at: new Date(nowMs).toISOString(),
      cache_until_ms: 0
    };
  }

  function validateHostResponse(raw, expectedRequestId, nowMs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return makeDeniedVerdict('MALFORMED_RESPONSE', 'error', nowMs);
    }
    if (typeof raw.request_id !== 'string' || raw.request_id !== expectedRequestId) {
      return makeDeniedVerdict('REQUEST_ID_MISMATCH', 'error', nowMs);
    }
    if (typeof raw.authorized !== 'boolean' || typeof raw.license_status !== 'string') {
      return makeDeniedVerdict('MALFORMED_RESPONSE', 'error', nowMs);
    }
    if (!Array.isArray(raw.products)) {
      return makeDeniedVerdict('MALFORMED_RESPONSE', 'error', nowMs);
    }

    const authorized = raw.authorized === true;
    let cacheUntilMs = 0;
    if (authorized) {
      cacheUntilMs = nowMs + DEFAULT_CACHE_TTL_MS;
      if (typeof raw.offline_grace_until === 'string') {
        const graceMs = Date.parse(raw.offline_grace_until);
        if (Number.isFinite(graceMs)) {
          cacheUntilMs = Math.min(cacheUntilMs, graceMs);
        }
      }
      if (typeof raw.expires_at === 'string') {
        const expMs = Date.parse(raw.expires_at);
        if (Number.isFinite(expMs)) {
          cacheUntilMs = Math.min(cacheUntilMs, expMs);
        }
      }
      if (cacheUntilMs <= nowMs) {
        return makeDeniedVerdict('LICENSE_EXPIRED', 'expired', nowMs);
      }
    }

    return {
      authorized,
      license_status: raw.license_status,
      plan_name: typeof raw.plan_name === 'string' ? raw.plan_name : null,
      expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : null,
      offline_grace_until:
        typeof raw.offline_grace_until === 'string' ? raw.offline_grace_until : null,
      products: raw.products.map(String),
      error_code: typeof raw.error_code === 'string' ? raw.error_code : null,
      checked_at: new Date(nowMs).toISOString(),
      cache_until_ms: cacheUntilMs
    };
  }

  function isCacheValid(verdict, nowMs) {
    return (
      verdict &&
      verdict.authorized === true &&
      typeof verdict.cache_until_ms === 'number' &&
      nowMs < verdict.cache_until_ms
    );
  }

  async function readSessionCache(chromeApi) {
    if (memoryCache) return memoryCache;
    try {
      if (chromeApi && chromeApi.storage && chromeApi.storage.session) {
        const res = await chromeApi.storage.session.get([SESSION_CACHE_KEY]);
        if (res && res[SESSION_CACHE_KEY]) {
          memoryCache = res[SESSION_CACHE_KEY];
          return memoryCache;
        }
      }
    } catch (_) {}
    return null;
  }

  async function writeSessionCache(chromeApi, verdict) {
    memoryCache = verdict && verdict.authorized ? verdict : null;
    try {
      if (chromeApi && chromeApi.storage && chromeApi.storage.session) {
        if (memoryCache) {
          await chromeApi.storage.session.set({ [SESSION_CACHE_KEY]: memoryCache });
        } else {
          await chromeApi.storage.session.remove([SESSION_CACHE_KEY]);
        }
      }
    } catch (_) {}
  }

  function queryNativeHostOnce(chromeApi, nowMs) {
    return new Promise((resolve) => {
      if (
        !chromeApi ||
        !chromeApi.runtime ||
        typeof chromeApi.runtime.connectNative !== 'function'
      ) {
        resolve(makeDeniedVerdict('NATIVE_HOST_UNAVAILABLE', 'unavailable', nowMs));
        return;
      }

      const requestId = generateRequestId();
      let settled = false;
      let port = null;
      let timer = null;

      function finish(verdict) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (port) {
          try {
            port.disconnect();
          } catch (_) {}
        }
        resolve(verdict);
      }

      try {
        port = chromeApi.runtime.connectNative(NATIVE_HOST_NAME);
      } catch (_) {
        finish(makeDeniedVerdict('NATIVE_HOST_UNAVAILABLE', 'unavailable', nowMs));
        return;
      }

      timer = setTimeout(() => {
        finish(makeDeniedVerdict('NATIVE_HOST_TIMEOUT', 'unavailable', nowMs));
      }, NATIVE_TIMEOUT_MS);

      port.onMessage.addListener((message) => {
        const verdict = validateHostResponse(message, requestId, nowMs);
        finish(verdict);
      });

      port.onDisconnect.addListener(() => {
        const lastErr =
          chromeApi.runtime && chromeApi.runtime.lastError
            ? String(chromeApi.runtime.lastError.message || '')
            : '';
        const isNotFound = /not found|forbidden|specified native messaging host/i.test(lastErr);
        finish(
          makeDeniedVerdict(
            isNotFound ? 'NATIVE_HOST_UNAVAILABLE' : 'NATIVE_HOST_DISCONNECTED',
            'unavailable',
            nowMs
          )
        );
      });

      try {
        port.postMessage({
          request_id: requestId,
          command: COMMAND_GET_LICENSE_STATUS,
          product: PRODUCT_ID
        });
      } catch (_) {
        finish(makeDeniedVerdict('NATIVE_HOST_DISCONNECTED', 'unavailable', nowMs));
      }
    });
  }

  async function getLicenseStatus(options = {}) {
    const chromeApi = options.chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
    const forceRefresh = !!options.forceRefresh;

    if (!forceRefresh) {
      const cached = await readSessionCache(chromeApi);
      if (isCacheValid(cached, nowMs)) {
        return cached;
      }
    }

    const fresh = await queryNativeHostOnce(chromeApi, nowMs);
    await writeSessionCache(chromeApi, fresh);
    return fresh;
  }

  function clearMemoryCache() {
    memoryCache = null;
  }

  function describeLicenseError(errorCode) {
    switch (errorCode) {
      case 'NATIVE_HOST_UNAVAILABLE':
      case 'NATIVE_HOST_DISCONNECTED':
      case 'NATIVE_HOST_TIMEOUT':
        return {
          title: 'StockStudio Pro Desktop Required',
          detail:
            'Install or update StockStudio Pro Desktop on this computer so this extension can verify your license.'
        };
      case 'NOT_ACTIVATED':
        return {
          title: 'License Not Activated',
          detail:
            'Open StockStudio Pro Desktop and activate your License Key on this device. No key entry is needed here.'
        };
      case 'PRODUCT_NOT_ENTITLED':
        return {
          title: 'Extension Not Included in Plan',
          detail:
            'Your current StockStudio Pro license does not include Vectorizer Extension entitlement.'
        };
      case 'LICENSE_EXPIRED':
        return {
          title: 'Subscription Expired',
          detail: 'Your StockStudio Pro subscription has expired. Renew in StockStudio Pro Desktop.'
        };
      case 'OFFLINE_GRACE_EXPIRED':
        return {
          title: 'Offline Grace Expired',
          detail:
            'Your 7-day offline grace period ended. Reconnect to the internet and open StockStudio Pro Desktop to refresh.'
        };
      case 'CLOCK_ROLLBACK_DETECTED':
        return {
          title: 'System Clock Error',
          detail:
            'System clock rollback detected. Sync your Windows clock and refresh in StockStudio Pro Desktop.'
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
          title: 'License Verification Failed',
          detail:
            'Unable to verify your StockStudio Pro license. Open StockStudio Pro Desktop and click Re-check.'
        };
    }
  }

  const exported = {
    NATIVE_HOST_NAME,
    COMMAND_GET_LICENSE_STATUS,
    PRODUCT_ID,
    SESSION_CACHE_KEY,
    DEFAULT_CACHE_TTL_MS,
    validateHostResponse,
    getLicenseStatus,
    clearMemoryCache,
    describeLicenseError
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (globalScope) {
    globalScope.StockStudioLicenseClient = exported;
  }
})(typeof self !== 'undefined' ? self : globalThis);
