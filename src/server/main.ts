// Entry point of `pnpm dev:server` and `pnpm start` (docs/ARCHITECTURE.md §4).
//
//   environment (+ the DOTENV_PATH file) -> AgentEnv snapshot -> the agent
//   core and the six integrations -> startServer() on 127.0.0.1:PORT.
//
// Configuration problems name the variable, never its value, and stop the
// process before anything listens. SIGINT and SIGTERM stop every run (as
// shutdown), close the listener and the database, then exit; a second signal
// exits at once.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunTurn } from "../agent/run-turn.js";
import { loadAgentEnv, withDotenvFile } from "../config/env.js";
import { createRedactor } from "../config/redact.js";
import type { AgentEnv, ConfigProblem } from "../contracts/env.js";
import { stateDirUsageBaselines } from "../db/usage-baseline.js";
import { integrations } from "../integrations/registry.js";
import { listeningLines } from "./app.js";
import { type RunningServer, startServer } from "./runtime.js";

/** Exit code for refused configuration (the CLI's CLI_EXIT_CODES.config). */
const EXIT_CONFIG = 3;
/** How long shutdown may take before the process exits anyway. */
const SHUTDOWN_DEADLINE_MS = 8_000;

function readVersion(): string {
  // src/server/main.ts and dist/server/main.js are both two levels below package.json.
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const version = (pkg as { version?: unknown }).version;
  return typeof version === "string" ? version : "0.0.0";
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function loadConfiguration():
  | { readonly ok: true; readonly env: AgentEnv }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] } {
  const cwd = process.cwd();
  const merged = withDotenvFile(process.env, { cwd });
  if (!merged.ok) return { ok: false, problems: [merged.problem] };
  return loadAgentEnv(merged.environment, { cwd });
}

async function main(): Promise<void> {
  const configuration = loadConfiguration();
  if (!configuration.ok) {
    log("Revenue Desk cannot start: the configuration was refused.");
    for (const problem of configuration.problems) log(`  ${problem.variable}: ${problem.message}`);
    process.exit(EXIT_CONFIG);
  }
  const { env } = configuration;
  const redact = createRedactor(env);
  const version = readVersion();
  const catalog = integrations();
  // dist/server/main.js serves dist/web; under tsx this resolves to src/web,
  // which does not exist, and Vite serves the SPA instead.
  const webRoot = fileURLToPath(new URL("../web", import.meta.url));

  let server: RunningServer;
  try {
    server = await startServer({
      env,
      // A resumed session's usage is measured against what the database recorded.
      runTurn: createRunTurn({ catalog, version, usageStore: stateDirUsageBaselines }),
      integrations: Object.values(catalog),
      redact,
      version,
      log,
      webRoot,
    });
  } catch (error) {
    log(`Revenue Desk failed to start: ${redact(messageOf(error))}`);
    process.exit(1);
  }

  for (const line of listeningLines(server.url, existsSync(join(webRoot, "index.html")))) {
    log(line);
  }
  if (env.runtime.sandbox) log("Local sandbox — no real services");
  if (env.model.apiKey === null) {
    log("ANTHROPIC_API_KEY is not set: runs will fail until it is configured.");
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      log(`Received ${signal} again; exiting now`);
      process.exit(1);
    }
    stopping = true;
    log(`Received ${signal}; stopping runs and shutting down`);
    setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log(`Shutdown failed: ${redact(messageOf(error))}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
