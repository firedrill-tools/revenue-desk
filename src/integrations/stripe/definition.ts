// The Stripe integration: API kind, profile stripe-api.

import {
  INTEGRATIONS,
  type ProbeResult,
  type StripeConnection,
} from "../../contracts/integration.js";
import type { ApiIntegration, ApiIntegrationDeps } from "../shared/definition.js";
import { probeFailure } from "../shared/errors.js";
import type { HttpDeps } from "../shared/http.js";
import { bool } from "../shared/json.js";
import { classifyStripe } from "./classify.js";
import { StripeClient } from "./client.js";
import { STRIPE_PROFILE } from "./profile.js";
import { resolveStripe } from "./resolve.js";
import { StripeRunMemory } from "./run-memory.js";
import { createStripeTools } from "./tools.js";

export function stripeClientFor(connection: StripeConnection, http?: HttpDeps): StripeClient {
  return new StripeClient({
    baseUrl: connection.api.baseUrl,
    secretKey: connection.api.secretKey,
    apiVersion: connection.api.apiVersion,
    allowLive: connection.api.keyMode === "live",
    ...(http === undefined ? {} : { http }),
  });
}

/** Read-only check: GET /v1/balance, and the account mode must match the key's. */
export async function probeStripe(
  connection: StripeConnection,
  signal: AbortSignal,
  http?: HttpDeps,
): Promise<ProbeResult> {
  try {
    const balance = await stripeClientFor(connection, http).get("/v1/balance", {}, signal);
    const livemode = bool(balance, "livemode");
    const expectLive = connection.api.keyMode === "live";
    if (livemode !== undefined && livemode !== expectLive) {
      return {
        state: "error",
        detail: `Stripe reports ${livemode ? "live" : "test"} mode for a ${connection.api.keyMode} key.`,
        accountHint: null,
      };
    }
    return {
      state: "connected",
      detail: `Stripe ${connection.api.keyMode}-mode key accepted; balance is readable.`,
      accountHint: null,
    };
  } catch (error) {
    return probeFailure("Stripe", error);
  }
}

export function createStripeIntegration(deps: ApiIntegrationDeps = {}): ApiIntegration<"stripe"> {
  return {
    id: "stripe",
    label: INTEGRATIONS.stripe.label,
    kind: "api",
    profile: STRIPE_PROFILE,
    resolve: resolveStripe,
    classify: classifyStripe,
    probe: (connection, signal) => probeStripe(connection, signal, deps.http),
    tools: (connection, options) =>
      createStripeTools(stripeClientFor(connection, deps.http), options),
    // Refund and cancellation cards name the customer and charge this run read.
    runMemory: (settings) => new StripeRunMemory(settings),
  };
}
