// The QuickBooks Online integration: API kind, profile quickbooks-api.

import {
  INTEGRATIONS,
  type ProbeResult,
  type QuickBooksConnection,
} from "../../contracts/integration.js";
import type { ApiIntegration, ApiIntegrationDeps } from "../shared/definition.js";
import { probeFailure } from "../shared/errors.js";
import type { HttpDeps } from "../shared/http.js";
import { obj, str } from "../shared/json.js";
import { maskIdentifier } from "../shared/text.js";
import { classifyQuickBooks } from "./classify.js";
import { QuickBooksClient } from "./client.js";
import { QUICKBOOKS_PROFILE } from "./profile.js";
import { resolveQuickBooks } from "./resolve.js";
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
      detail: name === undefined ? "QuickBooks company is readable." : `Connected to ${name}.`,
      accountHint: maskIdentifier(connection.api.realmId),
    };
  } catch (error) {
    return probeFailure("QuickBooks", error, { expired: (failure) => failure.status === 401 });
  }
}

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
  };
}
