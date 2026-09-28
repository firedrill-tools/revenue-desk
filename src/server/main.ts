import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

// Loopback only: the API will hold approvals for financial and outbound actions.
const HOST = "127.0.0.1";
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

const server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
  process.stderr.write(`Revenue Desk listening on http://${HOST}:${info.port}\n`);
});

function shutdown(signal: NodeJS.Signals): void {
  process.stderr.write(`Received ${signal}; shutting down\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
