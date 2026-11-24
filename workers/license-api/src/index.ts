// =============================================================================
// StockStudio Pro License API (v0.2.0) — Main Cloudflare Worker Router
// =============================================================================

import {
  handleAdminCreateLicense,
  handleAdminForceDeactivateDevice,
  handleAdminGetLicense,
  handleAdminGetMe,
  handleAdminGetStats,
  handleAdminListEvents,
  handleAdminListLicenses,
  handleAdminReinstateLicense,
  handleAdminRenewSubscription,
  handleAdminRevokeLicense,
  handleAdminSuspendLicense,
  handleAdminUpdateLicense,
  handleBillingWebhook,
} from "./admin-handlers";
import {
  handleActivateLicense,
  handleDeactivateLicense,
  handleListLicenseDevices,
  handleValidateLicense,
} from "./client-handlers";
import {
  handleAdminCreateTool,
  handleAdminDeleteTool,
  handleAdminListTools,
  handleAdminUpdateTool,
  handleClientListTools,
} from "./tools-handlers";
import { generatePrefixedId, hashClientIp } from "./crypto";
import { ApiError, errorResponse, jsonResponse } from "./errors";
import { Env, RequestContext } from "./types";
import { getExpectedProductId, getSigningKid, resolveClientIp } from "./utils";

function enforceTlsInProduction(request: Request, env: Env): void {
  const environment = (env.ENVIRONMENT ?? "development").toLowerCase();
  if (environment === "production" || environment === "staging") {
    const url = new URL(request.url);
    const forwardedProto = request.headers.get("X-Forwarded-Proto");
    const isHttps =
      url.protocol === "https:" || forwardedProto?.toLowerCase() === "https";
    if (!isHttps) {
      throw new ApiError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "HTTPS/TLS connection is required.",
      });
    }
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  nowOverride?: Date
): Promise<Response> {
  const now = nowOverride ?? new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const requestId = generatePrefixedId("req", now.getTime());
  const clientIp = resolveClientIp(request, env);
  const userAgent = (request.headers.get("User-Agent") ?? "unknown").slice(
    0,
    256
  );

  try {
    enforceTlsInProduction(request, env);

    const ipHash = await hashClientIp(
      clientIp ?? "unknown-ip",
      env.IP_HASH_SALT,
      nowIso
    );
    const ctx: RequestContext = {
      requestId,
      now,
      nowIso,
      clientIp,
      ipHash,
      userAgent,
    };

    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Health & Public Verification Key Metadata Endpoint
    if (method === "GET" && (path === "/v1/health" || path === "/health")) {
      return jsonResponse(
        {
          ok: true,
          service: "stockstudio-pro-license-api",
          version: "0.2.0",
          product_id: getExpectedProductId(env),
          signing_kid: getSigningKid(env),
          public_key_base64: env.LICENSE_SIGNING_PUBLIC_KEY_BASE64 ?? null,
          server_time: nowIso,
        },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // Public Client License Endpoints
    if (method === "POST" && path === "/v1/licenses/activate") {
      return await handleActivateLicense(request, env, ctx);
    }

    if (method === "POST" && path === "/v1/licenses/validate") {
      return await handleValidateLicense(request, env, ctx);
    }

    if (method === "POST" && path === "/v1/licenses/deactivate") {
      return await handleDeactivateLicense(request, env, ctx);
    }

    if (method === "GET" && path === "/v1/licenses/devices") {
      return await handleListLicenseDevices(request, env, ctx);
    }

    if (method === "GET" && path === "/v1/tools") {
      return await handleClientListTools(request, env, ctx);
    }

    // Administrative Endpoints
    if (method === "GET" && path === "/v1/admin/tools") {
      return await handleAdminListTools(request, env, ctx);
    }

    if (method === "POST" && path === "/v1/admin/tools") {
      return await handleAdminCreateTool(request, env, ctx);
    }

    const adminToolMatch = path.match(/^\/v1\/admin\/tools\/([A-Za-z0-9_-]+)$/);
    if (adminToolMatch) {
      const toolId = adminToolMatch[1];
      if (method === "PATCH") {
        return await handleAdminUpdateTool(request, env, ctx, toolId);
      }
      if (method === "DELETE") {
        return await handleAdminDeleteTool(request, env, ctx, toolId);
      }
    }

    if (method === "GET" && path === "/v1/admin/me") {
      return await handleAdminGetMe(request, env, ctx);
    }

    if (method === "GET" && path === "/v1/admin/stats") {
      return await handleAdminGetStats(request, env, ctx);
    }

    if (method === "GET" && path === "/v1/admin/events") {
      return await handleAdminListEvents(request, env, ctx);
    }

    if (method === "GET" && path === "/v1/admin/licenses") {
      return await handleAdminListLicenses(request, env, ctx);
    }

    if (method === "POST" && path === "/v1/admin/licenses") {
      return await handleAdminCreateLicense(request, env, ctx);
    }

    const adminLicenseMatch = path.match(
      /^\/v1\/admin\/licenses\/([A-Za-z0-9_-]+)$/
    );
    if (adminLicenseMatch) {
      const licenseId = adminLicenseMatch[1];
      if (method === "GET") {
        return await handleAdminGetLicense(request, env, ctx, licenseId);
      }
      if (method === "PATCH") {
        return await handleAdminUpdateLicense(request, env, ctx, licenseId);
      }
    }

    const adminActionMatch = path.match(
      /^\/v1\/admin\/licenses\/([A-Za-z0-9_-]+)\/(suspend|reinstate|revoke|renew)$/
    );
    if (adminActionMatch && method === "POST") {
      const [, licenseId, action] = adminActionMatch;
      if (action === "suspend") {
        return await handleAdminSuspendLicense(request, env, ctx, licenseId);
      }
      if (action === "reinstate") {
        return await handleAdminReinstateLicense(request, env, ctx, licenseId);
      }
      if (action === "revoke") {
        return await handleAdminRevokeLicense(request, env, ctx, licenseId);
      }
      if (action === "renew") {
        return await handleAdminRenewSubscription(request, env, ctx, licenseId);
      }
    }

    const adminDeviceMatch = path.match(
      /^\/v1\/admin\/licenses\/([A-Za-z0-9_-]+)\/devices\/([A-Za-z0-9_-]+)$/
    );
    if (adminDeviceMatch && method === "DELETE") {
      const [, licenseId, activationId] = adminDeviceMatch;
      return await handleAdminForceDeactivateDevice(
        request,
        env,
        ctx,
        licenseId,
        activationId
      );
    }

    // Provider-Independent Billing Webhook Endpoint
    const webhookMatch = path.match(/^\/v1\/billing\/webhooks\/([A-Za-z0-9_-]+)$/);
    if (webhookMatch && method === "POST") {
      return await handleBillingWebhook(request, env, ctx, webhookMatch[1]);
    }

    throw new ApiError({
      code: "INVALID_REQUEST",
      status: 404,
      message: `Endpoint not found: ${method} ${path}`,
    });
  } catch (err) {
    return errorResponse(err, requestId, nowIso);
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    return handleRequest(request, env);
  },
};
