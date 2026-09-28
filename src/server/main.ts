// Entry point of `pnpm dev:server` and `pnpm start`.
//
// The full server is startServer() in runtime.ts. It needs the agent core's
// runTurn (src/agent, W1), the integration definitions (src/integrations, W2),
// the configuration snapshot, redactor and approval gate (src/config and
// src/policy, W1). Until those are wired here, this entry point serves
// /api/health and the built SPA only; every other /api route answers 404.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { SERVER_HOST } from "./runtime.js";

const DEFAULT_PORT = 4320;

function readPort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${value}")`);
  }
  return port;
}

function readVersion(): string {
  // src/server/main.ts and dist/server/main.js are both two levels below package.json.
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const version = (pkg as { version?: unknown }).version;
  return typeof version === "string" ? version : "0.0.0";
}

const port = readPort(process.env.PORT);
const app = createApp({
  version: readVersion(),
  // dist/server/main.js serves dist/web; under tsx this resolves to src/web, which does not exist.
  webRoot: fileURLToPath(new URL("../web", import.meta.url)),
});

const server = serve({ fetch: app.fetch, hostname: SERVER_HOST, port }, (info) => {
  process.stderr.write(`Revenue Desk listening on http://${SERVER_HOST}:${info.port}\n`);
  process.stderr.write("The agent API is not wired into this entry point yet (health only).\n");
});

function shutdown(signal: NodeJS.Signals): void {
  process.stderr.write(`Received ${signal}; shutting down\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
