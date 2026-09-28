// Connections (docs/ARCHITECTURE.md §9): status, a read-only Check, and
// Connect for Composio integrations on the user's click.

import type { Hono } from "hono";
import { z } from "zod";
import { API_PATHS, type ConnectResponse } from "../../contracts/api.js";
import { INTEGRATION_IDS, type IntegrationId } from "../../contracts/integration.js";
import { apiError, parseJsonBody } from "../http.js";
import { requestHost } from "../security.js";
import type { ApiServices } from "../services.js";

/** The SPA route Composio returns the user to after sign-in. */
export const CONNECT_CALLBACK_PATH = "/connections";

const emptyBody = z.strictObject({});

function integrationOf(value: string): IntegrationId | undefined {
  return INTEGRATION_IDS.find((id) => id === value);
}

export function registerConnectionRoutes(app: Hono, services: ApiServices): void {
  app.get(API_PATHS.connections, (c) => c.json({ items: services.connections.list() }));

  app.post(API_PATHS.connectionCheck, async (c) => {
    const body = await parseJsonBody(c, emptyBody);
    if (!body.ok) return body.response;
    const integration = integrationOf(c.req.param("integration"));
    if (integration === undefined) return apiError(c, "not_found", "No integration has this id.");
    const connection = await services.connections.check(integration, c.req.raw.signal);
    return c.json({ connection });
  });

  app.post(API_PATHS.connectionConnect, async (c) => {
    const body = await parseJsonBody(c, emptyBody);
    if (!body.ok) return body.response;
    const integration = integrationOf(c.req.param("integration"));
    if (integration === undefined) return apiError(c, "not_found", "No integration has this id.");
    // The callback is on the server's own origin (the Host was checked as loopback).
    const callback = new URL(`http://${requestHost(c)}${CONNECT_CALLBACK_PATH}`);
    callback.searchParams.set("connected", integration);
    const outcome = await services.connections.connect(integration, callback.toString());
    if (!outcome.ok) return apiError(c, outcome.code, outcome.message);
    const response: ConnectResponse = { redirectUrl: outcome.redirectUrl };
    return c.json(response);
  });
}
