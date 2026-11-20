// =============================================================================
// StockStudio Pro License API (v0.2.0) — Error Handling & Response Envelopes
// =============================================================================

export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "PRODUCT_MISMATCH"
  | "CLOCK_SKEW_TOO_LARGE"
  | "INVALID_LICENSE_KEY"
  | "UNAUTHORIZED_TOKEN"
  | "FORBIDDEN_ROLE"
  | "LICENSE_EXPIRED"
  | "LICENSE_SUSPENDED"
  | "LICENSE_REVOKED"
  | "ACTIVATION_REVOKED"
  | "DEVICE_MISMATCH"
  | "ACTIVATION_NOT_FOUND"
  | "LICENSE_NOT_FOUND"
  | "DEVICE_LIMIT_REACHED"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;
  public readonly headers?: Record<string, string>;

  constructor(options: {
    code: ApiErrorCode;
    status: number;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? options.status >= 500;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

export function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...(extraHeaders ?? {}),
    },
  });
}

export function errorResponse(
  error: unknown,
  requestId: string,
  serverTime: string
): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {}),
        },
        request_id: requestId,
        server_time: serverTime,
      },
      error.status,
      {
        "X-Request-Id": requestId,
        ...(error.headers ?? {}),
      }
    );
  }

  // Never leak internal stack traces or secret values in 500 error responses
  const safeMessage =
    error instanceof Error ? error.message : "Unexpected internal server error";
  console.error(
    JSON.stringify({
      level: "error",
      event: "unhandled_api_error",
      request_id: requestId,
      message: safeMessage,
    })
  );

  return jsonResponse(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal server error occurred.",
        retryable: true,
      },
      request_id: requestId,
      server_time: serverTime,
    },
    500,
    { "X-Request-Id": requestId }
  );
}
