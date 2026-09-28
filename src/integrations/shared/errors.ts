// Provider errors as the model and the action log see them: the gateway's
// ApiToolError, whose toJSON() is the frozen ToolFailure shape
// {provider, status, code, message}.

import type { ProbeResult, ToolFailure } from "../../contracts/integration.js";
import { ApiToolError } from "../../gateway/api-server.js";
import { TransportError } from "./http.js";

export { ApiToolError };

/** An ApiToolError for a request that got no HTTP response. */
export function transportFailure(provider: string, error: TransportError): ApiToolError {
  const code =
    error.kind === "aborted" ? "cancelled" : error.kind === "timeout" ? "timeout" : "network_error";
  return new ApiToolError(provider, error.message, { code });
}

/** Any thrown value as a ToolFailure. */
export function toToolFailure(error: unknown, provider: string | null = null): ToolFailure {
  if (error instanceof ApiToolError) {
    return {
      provider: error.provider,
      status: error.status ?? null,
      code: error.code ?? null,
      message: error.message,
    };
  }
  if (error instanceof TransportError) {
    return { provider, status: null, code: error.kind, message: error.message };
  }
  return {
    provider,
    status: null,
    code: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * A failed read-only check as a ProbeResult: rejected credentials make the
 * integration unavailable (needs_auth, or expired when the provider says so);
 * anything else is a transient error.
 */
export function probeFailure(
  label: string,
  error: unknown,
  rules: {
    readonly expired?: (failure: ToolFailure) => boolean;
    /** Default: HTTP 401 or 403. */
    readonly rejected?: (failure: ToolFailure) => boolean;
  } = {},
): ProbeResult {
  const failure = toToolFailure(error);
  if (rules.expired?.(failure) === true) {
    return {
      state: "expired",
      detail: `${label} credentials have expired: ${failure.message}`,
      accountHint: null,
    };
  }
  const rejected = rules.rejected ?? ((f: ToolFailure) => f.status === 401 || f.status === 403);
  if (rejected(failure)) {
    return {
      state: "needs_auth",
      detail: `${label} rejected the configured credentials: ${failure.message}`,
      accountHint: null,
    };
  }
  return { state: "error", detail: `${label} check failed: ${failure.message}`, accountHint: null };
}
