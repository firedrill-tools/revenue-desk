// The Hono app: the /api routes of src/contracts/api.ts behind the /api guard,
// then the built SPA (docs/ARCHITECTURE.md §4, §7).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { API_PATHS } from "../contracts/api.js";
import { apiError } from "./http.js";
import { describeError } from "./redaction.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerRunRoutes } from "./routes/runs.js";
import { healthResponse, registerSessionRoutes } from "./routes/session.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { apiGuard, createSessionSecrets, securityHeaders } from "./security.js";
import type { ApiServices } from "./services.js";

export interface AppOptions {
  /** Package version reported by /api/health. */
  readonly version: string;
  /**
   * Absolute path of the built SPA (dist/web). When it has no index.html
   * (for example in development, where Vite serves the SPA), only /api is served.
   */
  readonly webRoot?: string;
  /**
   * The agent's API. Without it only /api/health answers (the entry point
   * serves that until the agent core is wired in).
   */
  readonly api?: ApiServices;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const { api } = options;

  app.onError((error, c) => {
    const message = api === undefined ? String(error) : describeError(error, api.redact);
    (api?.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `${c.req.method} ${c.req.path} failed: ${message}`,
    );
    return apiError(c, "internal", "The server could not handle this request.");
  });

  app.use("*", securityHeaders());
  app.use("/api/*", apiGuard(api?.secrets ?? createSessionSecrets()));
  app.get(API_PATHS.health, (c) => c.json(healthResponse(options.version)));

  if (api !== undefined) {
    registerSessionRoutes(app, api);
    registerChatRoutes(app, api);
    registerConversationRoutes(app, api);
    registerRunRoutes(app, api);
    registerApprovalRoutes(app, api);
    registerConnectionRoutes(app, api);
    registerSettingsRoutes(app, api);
  }

  app.all("/api/*", (c) => apiError(c, "not_found", "Unknown API route"));

  const webRoot = options.webRoot;
  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.use("/*", serveStatic({ root: webRoot }));
    // Client-side routes fall back to the SPA entry point.
    app.get("/*", serveStatic({ root: webRoot, path: "index.html" }));
  }

  return app;
}
