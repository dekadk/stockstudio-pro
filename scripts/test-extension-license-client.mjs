// =============================================================================
// StockStudio Pro — Phase 4 Automated Extension License Client Test Suite
//
// Tests:
// 1. Deterministic 32-char Chrome Extension ID derived from manifest.json "key"
// 2. Native host connection & valid extension entitlement
// 3. Missing extension entitlement (PRODUCT_NOT_ENTITLED)
// 4. Desktop not running / not installed / missing Native Messaging Host
// 5. Expired subscription, revoked/suspended license, offline grace & TTL cap
// 6. Malformed host response & request_id mismatch rejection
// 7. Session-only caching (never writes to chrome.storage.local)
// 8. Live integration against compiled stockstudio-nmh.exe over framed stdio!
// =============================================================================

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rawExtDir = process.env.STOCKSTUDIO_EXTENSION_DIR?.trim()
const EXT_DIR = rawExtDir
  ? path.resolve(REPO_ROOT, rawExtDir)
  : path.join(REPO_ROOT, "chrome-extension", "vectorize-ai-download")
const EXPECTED_EXTENSION_ID = "ejcjoljemplfeenipjehlhhclbkpialk"

const licenseClient = require(path.join(EXT_DIR, "background", "license-client.js"))

function deriveChromeExtensionIdFromBase64Key(pubKeyB64) {
  const der = Buffer.from(pubKeyB64, "base64")
  const hash = crypto.createHash("sha256").update(der).digest()
  let id = ""
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + ((hash[i] >> 4) & 0x0f))
    id += String.fromCharCode(97 + (hash[i] & 0x0f))
  }
  return id
}

function makeMockChrome(onPostMessage, opts = {}) {
  const sessionStore = new Map()
  const localStore = new Map()
  return {
    sessionStore,
    localStore,
    api: {
      runtime: {
        lastError: null,
        connectNative(hostName) {
          assert.equal(hostName, "com.stockstudiopro.license")
          const msgListeners = []
          const discListeners = []
          if (opts.throwOnConnect) {
            throw new Error("Specified native messaging host not found.")
          }
          return {
            onMessage: { addListener: (fn) => msgListeners.push(fn) },
            onDisconnect: { addListener: (fn) => discListeners.push(fn) },
            disconnect() {},
            postMessage(req) {
              queueMicrotask(() => {
                onPostMessage(req, {
                  reply: (msg) => msgListeners.forEach((fn) => fn(msg)),
                  disconnect: (errMsg) => {
                    if (errMsg) {
                      this._setLastError(errMsg)
                    }
                    discListeners.forEach((fn) => fn())
                  },
                })
              })
            },
            _setLastError(msg) {
              mockRef.api.runtime.lastError = { message: msg }
            },
          }
        },
      },
      storage: {
        session: {
          async get(keys) {
            const out = {}
            for (const k of keys) {
              if (sessionStore.has(k)) out[k] = sessionStore.get(k)
            }
            return out
          },
          async set(obj) {
            for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v)
          },
          async remove(keys) {
            for (const k of keys) sessionStore.delete(k)
          },
        },
        local: {
          async set(obj) {
            for (const [k, v] of Object.entries(obj)) localStore.set(k, v)
          },
        },
      },
    },
  }
}

let mockRef = null

async function runTests() {
  // 1. Verify manifest.json stable key, ID, and nativeMessaging permission
  const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"))
  assert.ok(manifest.key, "manifest.json must pin a public key")
  assert.equal(deriveChromeExtensionIdFromBase64Key(manifest.key), EXPECTED_EXTENSION_ID)
  assert.ok(manifest.permissions.includes("nativeMessaging"))
  console.log("PASS 1: Stable Chrome Extension ID & manifest.json permissions verified")

  // 2. Valid extension entitlement + session-only cache (never local storage)
  licenseClient.clearMemoryCache()
  const nowMs = Date.parse("2026-11-21T12:00:00Z")
  let calls = 0
  mockRef = makeMockChrome((req, ctl) => {
    calls++
    assert.equal(req.command, "get_license_status")
    assert.equal(req.product, "vectorizer_extension")
    ctl.reply({
      request_id: req.request_id,
      authorized: true,
      license_status: "active",
      plan_name: "Lifetime",
      expires_at: null,
      offline_grace_until: "2026-11-28T12:00:00Z",
      products: ["desktop", "vectorizer_extension"],
      error_code: null,
    })
  })
  const v1 = await licenseClient.getLicenseStatus({ chromeApi: mockRef.api, nowMs })
  assert.equal(v1.authorized, true)
  assert.equal(v1.plan_name, "Lifetime")
  assert.equal(mockRef.localStore.size, 0, "must NEVER write license verdict to chrome.storage.local")
  assert.equal(mockRef.sessionStore.size, 1, "must cache sanitized verdict in chrome.storage.session")

  // Cached hit within TTL
  const v1Cached = await licenseClient.getLicenseStatus({
    chromeApi: mockRef.api,
    nowMs: nowMs + 60_000,
  })
  assert.equal(v1Cached.authorized, true)
  assert.equal(calls, 1)
  console.log("PASS 2: Valid entitlement & session-only TTL caching verified")

  // 3. Missing extension entitlement (PRODUCT_NOT_ENTITLED) -> fails closed, clears session cache
  licenseClient.clearMemoryCache()
  mockRef = makeMockChrome((req, ctl) => {
    ctl.reply({
      request_id: req.request_id,
      authorized: false,
      license_status: "active",
      plan_name: "Lifetime",
      expires_at: null,
      offline_grace_until: "2026-11-28T12:00:00Z",
      products: ["desktop"],
      error_code: "PRODUCT_NOT_ENTITLED",
    })
  })
  const vUnentitled = await licenseClient.getLicenseStatus({
    chromeApi: mockRef.api,
    nowMs,
    forceRefresh: true,
  })
  assert.equal(vUnentitled.authorized, false)
  assert.equal(vUnentitled.error_code, "PRODUCT_NOT_ENTITLED")
  assert.equal(mockRef.sessionStore.size, 0)
  console.log("PASS 3: Missing extension entitlement denied cleanly")

  // 4. Missing Native Messaging Host / Desktop not installed -> fails closed
  licenseClient.clearMemoryCache()
  mockRef = makeMockChrome((_req, ctl) => {
    ctl.disconnect("Specified native messaging host not found.")
  })
  const vMissingHost = await licenseClient.getLicenseStatus({
    chromeApi: mockRef.api,
    nowMs,
    forceRefresh: true,
  })
  assert.equal(vMissingHost.authorized, false)
  assert.equal(vMissingHost.error_code, "NATIVE_HOST_UNAVAILABLE")
  console.log("PASS 4: Missing Native Messaging Host fails closed")

  // 5. Expired subscription / revoked / suspended / offline grace cap
  for (const code of ["LICENSE_EXPIRED", "LICENSE_REVOKED", "LICENSE_SUSPENDED", "OFFLINE_GRACE_EXPIRED"]) {
    licenseClient.clearMemoryCache()
    mockRef = makeMockChrome((req, ctl) => {
      ctl.reply({
        request_id: req.request_id,
        authorized: false,
        license_status: "unauthorized",
        plan_name: null,
        expires_at: null,
        offline_grace_until: null,
        products: [],
        error_code: code,
      })
    })
    const res = await licenseClient.getLicenseStatus({
      chromeApi: mockRef.api,
      nowMs,
      forceRefresh: true,
    })
    assert.equal(res.authorized, false)
    assert.equal(res.error_code, code)
  }
  console.log("PASS 5: Expired, revoked, suspended, and offline-grace-expired verdicts denied")

  // 6. Malformed response & request_id mismatch -> rejected
  licenseClient.clearMemoryCache()
  mockRef = makeMockChrome((_req, ctl) => {
    ctl.reply({
      request_id: "wrong_id",
      authorized: true,
      license_status: "active",
      products: ["vectorizer_extension"],
    })
  })
  const vMismatch = await licenseClient.getLicenseStatus({
    chromeApi: mockRef.api,
    nowMs,
    forceRefresh: true,
  })
  assert.equal(vMismatch.authorized, false)
  assert.equal(vMismatch.error_code, "REQUEST_ID_MISMATCH")

  const vMalformed = licenseClient.validateHostResponse("not-an-object", "req_1", nowMs)
  assert.equal(vMalformed.authorized, false)
  assert.equal(vMalformed.error_code, "MALFORMED_RESPONSE")
  console.log("PASS 6: Malformed response & request_id mismatch rejected")

  // 7. Live framed stdin/stdout round-trip against compiled stockstudio-nmh.exe (Desktop not running)
  const nmhExe = path.resolve("src-tauri", "target", "release", "stockstudio-nmh.exe")
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sspro-ext-nmh-"))
  const missingStatePath = path.join(tmpDir, "license-state.json")
  const reqPayload = JSON.stringify({
    request_id: "ext_live_01",
    command: "get_license_status",
    product: "vectorizer_extension",
  })
  const reqBuf = Buffer.from(reqPayload, "utf8")
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(reqBuf.length, 0)
  const framedInput = Buffer.concat([lenBuf, reqBuf])

  const proc = spawnSync(nmhExe, [], {
    input: framedInput,
    env: { ...process.env, LOCALAPPDATA: tmpDir },
  })
  assert.equal(proc.status, 0, "stockstudio-nmh.exe must exit 0 on valid request")
  const respLen = proc.stdout.readUInt32LE(0)
  const respJson = JSON.parse(proc.stdout.subarray(4, 4 + respLen).toString("utf8"))
  const validatedLive = licenseClient.validateHostResponse(respJson, "ext_live_01", nowMs)
  assert.equal(validatedLive.authorized, false)
  assert.equal(validatedLive.error_code, "NOT_ACTIVATED")
  rmSync(tmpDir, { recursive: true, force: true })
  console.log("PASS 7: Live stockstudio-nmh.exe framed stdio round-trip verified (Desktop closed)")
}

await runTests()
console.log("ALL_PHASE_4_EXTENSION_TESTS_PASSED")
