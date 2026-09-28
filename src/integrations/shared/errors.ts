// Provider errors as the model and the action log see them: the gateway's
// ApiToolError, whose toJSON() is the frozen ToolFailure shape
// {provider, status, code, message}.

import type { ProbeResult, ToolFailure } from "../../contracts/integration.js";
import { ApiToolError } from "../../gateway/api-server.js";
import { OUTCOME_UNKNOWN, outcomeUnknownMessage } from "../../gateway/types.js";
import { TransportError } from "./http.js";

export { ApiToolError };

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  stripe: "Stripe",
  quickbooks: "QuickBooks",
  slack: "Slack",
  hubspot: "HubSpot",
};

/**
 * An ApiToolError for a request that got no HTTP response. A write that may
 * have reached the provider is `outcome_unknown`: it may have been applied,
 * so the model is told to check before anything is retried.
 */
export function transportFailure(provider: string, error: TransportError): ApiToolError {
  if (error.outcomeUnknown) {
    const label = PROVIDER_LABELS[provider] ?? provider;
    return new ApiToolError(
      provider,
      outcomeUnknownMessage(
        `${label} did not answer after the request was sent (${error.message})`,
      ),
      { code: OUTCOME_UNKNOWN },
    );
  }
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

/** How a provider's refusal of its credential is judged and explained. */
export type CredentialRules = {
  /** The failure says the credential expired. */
  readonly expired?: (failure: ToolFailure) => boolean;
  /** The failure says the credential was refused. Default: HTTP 401 or 403. */
  readonly rejected?: (failure: ToolFailure) => boolean;
  /** The configuration variable that holds it, e.g. "QBO_ACCESS_TOKEN". */
  readonly variable?: string;
  /** What it is, in words: "the access token (it expires hourly)". */
  readonly credential?: string;
};

/** The provider's own words, kept as a second line under the plain sentence. */
function providerLine(label: string, failure: ToolFailure): string {
  return `\n${label} said: ${failure.message}`;
}

/**
 * A failed read-only check as a ProbeResult: rejected credentials make the
 * integration unavailable (needs_auth, or expired when the provider says so);
 * anything else is a transient error. The detail's first line is a plain
 * sentence with the next step; the provider's own text follows on a second
 * line (the Connections screen shows it muted).
 */
export function probeFailure(
  label: string,
  error: unknown,
  rules: CredentialRules = {},
): ProbeResult {
  const failure = toToolFailure(error);
  const credential = rules.credential ?? "the configured credentials";
  const fix =
    rules.variable === undefined
      ? "Update them in your configuration file and restart Revenue Desk."
      : `Put a new ${rules.variable} in your configuration file and restart Revenue Desk.`;
  if (rules.expired?.(failure) === true) {
    return {
      state: "expired",
      detail: `${label} rejected ${credential}. ${fix}${providerLine(label, failure)}`,
      accountHint: null,
    };
  }
  const rejected = rules.rejected ?? ((f: ToolFailure) => f.status === 401 || f.status === 403);
  if (rejected(failure)) {
    return {
      state: "needs_auth",
      detail: `${label} rejected ${credential}. ${fix}${providerLine(label, failure)}`,
      accountHint: null,
    };
  }
  const status = failure.status === null ? "" : ` (HTTP ${failure.status})`;
  return {
    state: "error",
    detail: `${label} did not answer the check${status}. Try Check again later.${providerLine(label, failure)}`,
    accountHint: null,
  };
}

/**
 * What a failed tool call says about its connection: the provider refused
 * the credential itself (expired or rejected, by `rules`), so the
 * connection is recorded as a check would record it and the next run leaves
 * the integration out. Any other failure (a declined card, a missing record,
 * a 500) says nothing about the connection: null.
 */
export function credentialFailure(
  label: string,
  failure: ToolFailure,
  rules: CredentialRules,
): ProbeResult | null {
  const result = probeFailure(
    label,
    new ApiToolError(failure.provider ?? label, failure.message, {
      ...(failure.status === null ? {} : { status: failure.status }),
      ...(failure.code === null ? {} : { code: failure.code }),
    }),
    rules,
  );
  return result.state === "error" ? null : result;
}
