/**
 * `pnpm dev:sandbox`: Revenue Desk's explicit, labelled local demo
 * (docs/ARCHITECTURE.md §11). Nothing here is a fallback: it runs only when
 * someone starts this script.
 *
 * It starts every local fake with the fictional Kestrel Analytics data (on
 * a clock that runs from the fixtures' date), sets AGENT_SANDBOX=1 and every
 * integration variable to the fakes, then starts the API server
 * (127.0.0.1:4320) and Vite (127.0.0.1:4321). The server gets an explicit
 * environment: no DOTENV_PATH and no inherited keys, so no real service can
 * be reached through it.
 *
 * The model: the real Anthropic API only when ANTHROPIC_API_KEY is set in
 * this process's environment (it is never read from a file), otherwise the
 * scripted model, which plays the J1–J5 scenarios by prompt. `--model` makes
 * the choice explicit.
 *
 *   pnpm dev:sandbox [--model scripted|real] [--hubspot stdio|http]
 *                    [--state-dir <dir>] [--no-web] [--built]
 *
 * --built runs the production build (dist/server/main.js, which also serves
 * the built app on the API port) instead of the sources, and no Vite: run
 * `pnpm build` first.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EnvVarName } from "../src/contracts/env.js";
import { JOB_SCENARIOS } from "../test/scenarios/index.js";
import type { HubSpotMode } from "../test/support/fakes/index.js";
import { type Harness, REPOSITORY_ROOT, startHarness } from "../test/support/harness.js";

export const SANDBOX_BANNER = "Local sandbox — no real services";
export const API_PORT = 4320;
export const WEB_PORT = 4321;

export interface SandboxOptions {
  readonly model: "scripted" | "real";
  readonly hubspot: HubSpotMode;
  /** Keep state here across restarts; default: a fresh temporary directory. */
  readonly stateDir: string | null;
  readonly web: boolean;
  /** Run dist/server/main.js (pnpm build first); it serves the built app itself, so no Vite. */
  readonly built: boolean;
}

export type SandboxArgs =
  | { readonly ok: true; readonly options: SandboxOptions }
  | { readonly ok: false; readonly message: string }
  | { readonly ok: "help" };

export const USAGE = [
  "Usage: pnpm dev:sandbox [--model scripted|real] [--hubspot stdio|http] [--state-dir <dir>] [--no-web] [--built]",
  "",
  "A labelled local demo against local fakes of Gmail, Google Calendar, HubSpot, Stripe,",
  "QuickBooks Online and Slack, loaded with a fictional company. No real service is contacted.",
  "  --model     scripted (default without ANTHROPIC_API_KEY) or real (default when",
  "              ANTHROPIC_API_KEY is set in the environment; it is never read from a file)",
  "  --hubspot   stdio (default: the pinned @hubspot/mcp-server) or http (the fake's MCP endpoint)",
  "  --state-dir keep the database and sessions here instead of a temporary directory",
  "  --no-web    start the API only, without Vite",
  "  --built     run the production build (pnpm build first); it serves the app on the API port",
].join("\n");

/** Parses the command line. The environment is consulted only for ANTHROPIC_API_KEY's presence. */
export function parseSandboxArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): SandboxArgs {
  const hasKey = (environment.ANTHROPIC_API_KEY ?? "").trim() !== "";
  let model: SandboxOptions["model"] = hasKey ? "real" : "scripted";
  let hubspot: HubSpotMode = "stdio";
  let stateDir: string | null = null;
  let web = true;
  let built = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const value = () => {
      const next = argv[index + 1];
      index += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") return { ok: "help" };
    if (arg === "--no-web") web = false;
    else if (arg === "--built") built = true;
    else if (arg === "--model") {
      const choice = value();
      if (choice !== "scripted" && choice !== "real")
        return { ok: false, message: "--model must be scripted or real" };
      model = choice;
    } else if (arg === "--hubspot") {
      const choice = value();
      if (choice !== "stdio" && choice !== "http")
        return { ok: false, message: "--hubspot must be stdio or http" };
      hubspot = choice;
    } else if (arg === "--state-dir") {
      const dir = value();
      if (dir === undefined || dir === "")
        return { ok: false, message: "--state-dir needs a directory" };
      stateDir = resolve(dir);
    } else {
      return { ok: false, message: `Unknown argument: ${arg}` };
    }
  }
  if (model === "real" && !hasKey) {
    return {
      ok: false,
      message:
        "--model real needs ANTHROPIC_API_KEY in the environment (it is never read from a file).",
    };
  }
  return { ok: true, options: { model, hubspot, stateDir, web: web && !built, built } };
}

/** The banner printed once everything is up. Never contains a credential. */
export function sandboxBanner(details: {
  readonly webUrl: string | null;
  readonly apiUrl: string;
  readonly model: SandboxOptions["model"];
  readonly hubspot: HubSpotMode;
  readonly stateDir: string;
  readonly keepsState: boolean;
  readonly workspace: Harness["workspace"];
}): string {
  const rule = "─".repeat(78);
  const lines = [
    rule,
    ` ${SANDBOX_BANNER}`,
    rule,
    ` Open:        ${details.webUrl ?? details.apiUrl}${details.webUrl === null ? "" : `   (API ${details.apiUrl})`}`,
    " Company:     Kestrel Analytics, Inc. (fictional; every address is on a .test domain)",
    ` Model:       ${details.model === "real" ? "the real Anthropic API (ANTHROPIC_API_KEY from the environment)" : "scripted J1–J5 (no model calls, no network)"}`,
    " Integrations (all local fakes on 127.0.0.1):",
    "   Gmail, Google Calendar  Composio API and session MCP fake",
    `   HubSpot                 ${details.hubspot === "stdio" ? "the pinned @hubspot/mcp-server over stdio, against a local CRM" : "local Streamable HTTP MCP endpoint"}`,
    "   Stripe, QuickBooks Online, Slack   local REST fakes",
    ` State:       ${details.stateDir}${details.keepsState ? "" : " (removed on exit)"}`,
  ];
  if (details.workspace === "unsupported") {
    lines.push(
      " Note:        this server build serves /api/health only; the chat API is not wired into src/server/main.ts yet.",
    );
  }
  lines.push(" Try:");
  for (const scenario of JOB_SCENARIOS) lines.push(`   • ${scenario.prompt}`);
  lines.push(" Stop with Ctrl+C.", rule);
  return lines.join("\n");
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once("error", () => resolveFree(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
  });
}

/** Vite's CLI file, from its package.json (the bin path is not in its exports). */
function viteBin(): string {
  const manifest = createRequire(import.meta.url).resolve("vite/package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: { vite?: string } };
  return join(dirname(manifest), pkg.bin?.vite ?? "bin/vite.js");
}

function startVite(): ChildProcess {
  const vite = viteBin();
  // Vite needs no credentials: it gets only what it needs to run.
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const name of ["HOME", "TMPDIR", "TERM", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return spawn(process.execPath, [vite, "--clearScreen", "false"], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** Waits until a URL answers, or fails when the process exits or 30 seconds pass. */
async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited with code ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Vite did not answer at ${url} within 30 s`);
}

/**
 * Starts the demo; resolves once everything is up. `ports` exists for tests:
 * Vite's /api proxy targets 4320, so the demo itself always uses the defaults.
 */
export async function startSandbox(
  options: SandboxOptions,
  runtime: {
    readonly apiPort?: number;
    readonly onServerOutput?: (text: string) => void;
    /** Extra server variables, e.g. AGENT_MAX_BUDGET_USD for a live run's per-run cap. */
    readonly env?: Readonly<Partial<Record<EnvVarName, string>>>;
  } = {},
): Promise<{ readonly harness: Harness; readonly banner: string; stop(): Promise<void> }> {
  const apiPort = runtime.apiPort ?? API_PORT;
  if (!(await portIsFree(apiPort))) {
    throw new Error(
      `Port ${apiPort} is in use. Stop \`pnpm dev\` (or another Revenue Desk server) first.`,
    );
  }
  if (options.web && !(await portIsFree(WEB_PORT))) {
    throw new Error(`Port ${WEB_PORT} is in use. Stop the other Vite server first.`);
  }
  if (options.stateDir !== null) mkdirSync(options.stateDir, { recursive: true });
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const harness = await startHarness({
    server: "process",
    entry: options.built ? "built" : "source",
    port: apiPort,
    ...(runtime.onServerOutput === undefined ? {} : { onServerOutput: runtime.onServerOutput }),
    clock: "running",
    hubspot: options.hubspot,
    ...(options.model === "real" ? { model: { real: { apiKey } } } : {}),
    ...(options.stateDir === null ? {} : { stateDir: options.stateDir }),
    ...(runtime.env === undefined ? {} : { env: runtime.env }),
  });
  let vite: ChildProcess | null = null;
  const stopVite = async () => {
    if (vite === null || vite.exitCode !== null || vite.signalCode !== null) return;
    const exited = new Promise((resolveExit) => vite?.once("exit", resolveExit));
    vite.kill("SIGTERM");
    await exited;
  };
  try {
    if (options.web) {
      vite = startVite();
      await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`, vite);
    }
  } catch (error) {
    await stopVite();
    await harness.close();
    throw error;
  }
  const banner = sandboxBanner({
    webUrl: options.web ? `http://127.0.0.1:${WEB_PORT}` : null,
    apiUrl: harness.url ?? `http://127.0.0.1:${apiPort}`,
    model: options.model,
    hubspot: options.hubspot,
    stateDir: harness.stateDir,
    keepsState: options.stateDir !== null,
    workspace: harness.workspace,
  });
  return {
    harness,
    banner,
    stop: async () => {
      await stopVite();
      await harness.close();
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseSandboxArgs(process.argv.slice(2), process.env);
  if (parsed.ok === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${SANDBOX_BANNER}: starting the local fakes and the server…\n`);
  const sandbox = await startSandbox(parsed.options, {
    onServerOutput: (text) => process.stderr.write(text),
  });
  process.stdout.write(`\n${sandbox.banner}\n\n`);
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\nReceived ${signal}; stopping the sandbox…\n`);
    sandbox.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(
          `Stopping failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
