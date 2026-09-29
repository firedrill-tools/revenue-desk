// GET /api/health and GET /api/session (docs/ARCHITECTURE.md §7).

import type { Hono } from "hono";
import { API_PATHS, type HealthResponse, type SessionInfo } from "../../contracts/api.js";
import { readSettings } from "../../db/repos/settings.js";
import { businessDate, uiModelSettings } from "../run-context.js";
import { setSessionCookie } from "../security.js";
import type { ApiServices } from "../services.js";

export function healthResponse(version: string): HealthResponse {
  return { status: "ok", service: "revenue-desk", version };
}

export function registerSessionRoutes(app: Hono, services: ApiServices): void {
  app.get(API_PATHS.session, (c) => {
    const { env } = services;
    const settings = readSettings(services.db);
    const model = uiModelSettings(env, settings);
    const info: SessionInfo = {
      csrfToken: services.secrets.csrfToken,
      version: services.version,
      model: model.model,
      effort: model.effort,
      businessDate: businessDate(settings, services.now()),
      approvalTimeoutMs: env.runtime.approvalTimeoutMs,
      modelConfigured: env.model.apiKey !== null,
    };
    setSessionCookie(c, services.secrets);
    c.header("cache-control", "no-store");
    return c.json(info);
  });
}
