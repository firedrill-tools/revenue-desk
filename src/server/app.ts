import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createSpikeRoutes, type SpikeRoutesOptions } from "./ui-stream.js";

export interface AppOptions {
  /** Package version reported by /api/health. */
  version: string;
  /**
   * Absolute path of the built SPA (dist/web). When it has no index.html
   * (for example in development, where Vite serves the SPA), only /api is served.
   */
  webRoot?: string;
  /** Options for the spike S1 routes under /api/spike (removed when /api/chat lands). */
  spike?: SpikeRoutesOptions;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "revenue-desk", version: options.version }),
  );

  app.route("/", createSpikeRoutes(options.spike));

  app.all("/api/*", (c) =>
    c.json({ error: { code: "not_found", message: "Unknown API route" } }, 404),
  );

  const webRoot = options.webRoot;
  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.use("/*", serveStatic({ root: webRoot }));
    // Client-side routes fall back to the SPA entry point.
    app.get("/*", serveStatic({ root: webRoot, path: "index.html" }));
  }

  return app;
}
