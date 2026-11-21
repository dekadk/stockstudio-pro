/**
 * Vectorize.ai Download - Background Service Worker
 */

'use strict';

importScripts('license-client.js');

// Default settings
const DEFAULT_SETTINGS = {
  precision: 3,
  includeBackground: false,
  backgroundColor: '#ffffff',
  includeGapFillers: false
};

// Lifecycle: Installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Vectorize.ai Download] Extension installed/updated:', details.reason);

  // Initialize storage
  chrome.storage.local.get(['exportSettings'], (result) => {
    if (!result.exportSettings) {
      chrome.storage.local.set({ exportSettings: DEFAULT_SETTINGS });
    }
  });

  // Create context menu item
  if (chrome.contextMenus && typeof chrome.contextMenus.create === 'function') {
    chrome.contextMenus.create({
    id: 'vai-open-vectorizer',
    title: 'Open Vectorizer.ai',
    contexts: ['action']
    }, () => {
      if (chrome.runtime.lastError) {}
    });
  }

  // Revalidate unified StockStudio Pro license status on install/update
  if (self.StockStudioLicenseClient) {
    self.StockStudioLicenseClient.getLicenseStatus({ forceRefresh: true }).catch(() => {});
  }
});

// Lifecycle: Browser startup -> revalidate license via Native Messaging
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    if (self.StockStudioLicenseClient) {
      self.StockStudioLicenseClient.getLicenseStatus({ forceRefresh: true }).catch(() => {});
    }
  });
}

// Context Menu Click
if (chrome.contextMenus && chrome.contextMenus.onClicked) chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'vai-open-vectorizer') {
    chrome.tabs.create({ url: 'https://vectorizer.ai' });
  }
});

// Storage Change: Update badge if vector ready
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.lastVectorData && changes.lastVectorData.newValue) {
    chrome.action.setBadgeText({ text: 'SVG' });
    chrome.action.setBadgeBackgroundColor({ color: '#00D395' });
  }
});

// Message listener from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_BADGE_STATUS') {
    const text = message.status === 'ready' ? 'SVG' : '';
    const color = message.status === 'ready' ? '#00D395' : '#FE9300';
    if (sender.tab && sender.tab.id) {
      chrome.action.setBadgeText({ text, tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color, tabId: sender.tab.id });
    } else {
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color });
    }
    sendResponse({ success: true });
    return true;
  }

  // Retrieve the persisted error log (written by content.js)
  if (message.type === 'GET_ERROR_LOG') {
    chrome.storage.local.get(['vaiErrorLog'], (result) => {
      sendResponse({ success: true, log: result.vaiErrorLog || [] });
    });
    return true; // async
  }

  // Unified StockStudio Pro License Verification (Native Messaging)
  if (message.type === 'GET_LICENSE_STATUS') {
    const forceRefresh = Boolean(message.forceRefresh);
    if (!self.StockStudioLicenseClient) {
      sendResponse({
        success: false,
        verdict: {
          authorized: false,
          license_status: 'error',
          error_code: 'CLIENT_UNAVAILABLE'
        }
      });
      return true;
    }
    self.StockStudioLicenseClient.getLicenseStatus({ forceRefresh })
      .then((verdict) => {
        sendResponse({ success: true, verdict });
      })
      .catch(() => {
        sendResponse({
          success: false,
          verdict: {
            authorized: false,
            license_status: 'error',
            error_code: 'NATIVE_HOST_UNAVAILABLE'
          }
        });
      });
    return true; // async
  }

  // Clear the persisted error log
  if (message.type === 'CLEAR_ERROR_LOG') {
    chrome.storage.local.remove('vaiErrorLog', () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
