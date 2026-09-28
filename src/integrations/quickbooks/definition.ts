// The QuickBooks Online integration: API kind, profile quickbooks-api.

import {
  INTEGRATIONS,
  type ProbeResult,
  type QuickBooksConnection,
} from "../../contracts/integration.js";
import type { ApiIntegration, ApiIntegrationDeps } from "../shared/definition.js";
import { type CredentialRules, probeFailure } from "../shared/errors.js";
import type { HttpDeps } from "../shared/http.js";
import { obj, str } from "../shared/json.js";
import { maskIdentifier, sentence } from "../shared/text.js";
import { classifyQuickBooks } from "./classify.js";
import { QuickBooksClient } from "./client.js";
import { QUICKBOOKS_PROFILE } from "./profile.js";
import { resolveQuickBooks } from "./resolve.js";
import { QuickBooksRunMemory } from "./run-memory.js";
import { createQuickBooksTools } from "./tools.js";

export function quickBooksClientFor(
  connection: QuickBooksConnection,
  http?: HttpDeps,
): QuickBooksClient {
  return new QuickBooksClient({
    baseUrl: connection.api.baseUrl,
    accessToken: connection.api.accessToken,
    realmId: connection.api.realmId,
    minorVersion: connection.api.minorVersion,
    ...(http === undefined ? {} : { http }),
  });
}

/**
 * Read-only check: GET companyinfo. QuickBooks access tokens expire hourly,
 * so a 401 is reported as expired.
 */
export async function probeQuickBooks(
  connection: QuickBooksConnection,
  signal: AbortSignal,
  http?: HttpDeps,
): Promise<ProbeResult> {
  const client = quickBooksClientFor(connection, http);
  try {
    const body = await client.get(`companyinfo/${encodeURIComponent(client.realmId)}`, signal);
    const name = str(obj(body, "CompanyInfo"), "CompanyName");
    return {
      state: "connected",
      detail:
        name === undefined ? "QuickBooks company is readable." : sentence(`Connected to ${name}`),
      accountHint: maskIdentifier(connection.api.realmId),
    };
  } catch (error) {
    return probeFailure(INTEGRATIONS.quickbooks.label, error, QUICKBOOKS_CREDENTIAL_RULES);
  }
}

/** QuickBooks access tokens expire hourly: a 401 is an expired token; a 403, a refused one. */
export const QUICKBOOKS_CREDENTIAL_RULES: CredentialRules = {
  variable: "QBO_ACCESS_TOKEN",
  credential: "the access token (it expires hourly)",
  expired: (failure) => failure.status === 401,
};

export function createQuickBooksIntegration(
  deps: ApiIntegrationDeps = {},
): ApiIntegration<"quickbooks"> {
  return {
    id: "quickbooks",
    label: INTEGRATIONS.quickbooks.label,
    kind: "api",
    profile: QUICKBOOKS_PROFILE,
    resolve: resolveQuickBooks,
    classify: classifyQuickBooks,
    probe: (connection, signal) => probeQuickBooks(connection, signal, deps.http),
    tools: (connection, options) =>
      createQuickBooksTools(quickBooksClientFor(connection, deps.http), options),
    // Approval cards name the customers and invoices this run read, not only their ids.
    runMemory: (settings) => new QuickBooksRunMemory(settings),
  };
}
