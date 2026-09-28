/**
 * The full-stack test harness: every local fake, the scripted Messages API
 * and the Revenue Desk server, in an isolated temporary state directory,
 * wired only through the ordinary environment variables (docs/ARCHITECTURE.md
 * §3, §11). Nothing ambient leaks in: the server gets an explicit environment
 * (no DOTENV_PATH, no inherited keys), every endpoint is loopback, and the
 * Claude CLI's HTTP(S) proxy is the scripted model, which refuses any other
 * host.
 *
 * Server modes:
 * - "process" (default): `node --import tsx src/server/main.ts` (or the built
 *   dist/server/main.js) as a child process, exactly as `pnpm dev:server` or
 *   `pnpm start` runs it.
 * - "in-process": startServer() from src/server/runtime.ts with runTurn and
 *   the production integrations, in this process.
 * - "none": fakes and model only (for the CLI or the agent core).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRunTurn } from "../../src/agent/run-turn.js";
import { loadAgentEnv } from "../../src/config/env.js";
import type { EnvVarName, SdkChildPassthroughVar } from "../../src/contracts/env.js";
import { stateDirUsageBaselines } from "../../src/db/usage-baseline.js";
import { createIntegrations } from "../../src/integrations/registry.js";
import { startServer } from "../../src/server/runtime.js";
import { sandboxResponder } from "../scenarios/index.js";
import { type Scenario, type ScenarioResponder, scenarioResponder } from "../scenarios/script.js";
import { ApiClient } from "./api-client.js";
import type { ClockMode } from "./fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "./fakes/credentials.js";
import { type Fakes, type HubSpotMode, startFakes } from "./fakes/index.js";
import { type MockAnthropic, type Responder, startMockAnthropic } from "./mock-anthropic.js";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");

export type ServerMode = "process" | "in-process" | "none";

/**
 * The real Messages API instead of the scripted one (the sandbox demo's
 * explicit choice). The key is passed in by the caller, never read from a
 * file; no base URL or proxy is set, so the Claude CLI talks to Anthropic.
 */
export type RealModel = { readonly real: { readonly apiKey: string } };

/** Where the agent's model requests go, for the server's environment. */
export type ModelEndpoint =
  | { readonly kind: "scripted"; readonly url: string }
  | { readonly kind: "real"; readonly apiKey: string };

export interface HarnessOptions {
  /**
   * The scripted model: a scenario, several (chosen by prompt), a scenario
   * responder, or a raw responder; or the real model. Default: the sandbox's
   * J1–J5 responder.
   */
  readonly model?: Scenario | readonly Scenario[] | ScenarioResponder | Responder | RealModel;
  /** How the product reaches HubSpot. Default "stdio" (the pinned vendor server). */
  readonly hubspot?: HubSpotMode;
  /** Mount each fake under a path prefix. Default false. */
  readonly prefixes?: boolean;
  /** Default "process". */
  readonly server?: ServerMode;
  /** Process mode: run src/server/main.ts under tsx ("source", default) or dist/server/main.js ("built"). */
  readonly entry?: "source" | "built";
  /** Product variables to add or override (e.g. AGENT_POLICY). */
  readonly env?: Readonly<Partial<Record<EnvVarName, string>>>;
  /** Set AGENT_SANDBOX=1 (every endpoint here is loopback). Default true. */
  readonly sandbox?: boolean;
  readonly clock?: ClockMode;
  /** Prepares the fakes (faults, connection states) before the server starts. */
  readonly arrange?: (fakes: Fakes) => void;
  /** Use this state directory instead of a fresh temporary one (kept on close). */
  readonly stateDir?: string;
  /** Server port. Default: a free ephemeral port. */
  readonly port?: number;
  /**
   * Workspace settings: "kestrel" (default) applies the fixture's settings
   * through PATCH /api/settings, as a user would in Settings (company name,
   * internal domains, Slack allowlist); "default" keeps the seeded ones.
   */
  readonly workspace?: "kestrel" | "default";
  /** Process mode: also hand the server's stdout and stderr to this (the sandbox prints them). */
  readonly onServerOutput?: (text: string) => void;
}

export interface Harness {
  readonly fakes: Fakes;
  /** The scripted Messages API, or null with the real model. */
  readonly model: MockAnthropic | null;
  /** The scripted responder when the model is scenario-driven, else null. */
  readonly script: ScenarioResponder | null;
  readonly stateDir: string;
  /** The server's complete environment; a CLI run with it shares the server's state. */
  readonly env: Readonly<Record<string, string>>;
  /** http://127.0.0.1:<port>, or null without a server. */
  readonly url: string | null;
  /** An API client for the server (call session() first), or null without a server. */
  readonly api: ApiClient | null;
  /**
   * Whether the Kestrel workspace settings were applied: "applied", "kept"
   * (workspace "default" or no server), or "unsupported" (the server does not
   * serve /api/session and /api/settings yet).
   */
  readonly workspace: "applied" | "kept" | "unsupported";
  /** What the server wrote to stderr (process mode) or logged (in-process mode). */
  serverLog(): string;
  close(): Promise<void>;
}

/**
 * The server's explicit environment. Pure: tests check it directly. Values
 * from the calling process are limited to PATH and the temp directory.
 */
export function harnessEnvironment(options: {
  readonly fakes: Fakes;
  readonly model: ModelEndpoint;
  readonly stateDir: string;
  readonly port: number;
  readonly sandbox: boolean;
  readonly extra?: Readonly<Partial<Record<EnvVarName, string>>>;
}): Record<string, string> {
  const scripted = options.model.kind === "scripted" ? options.model.url : null;
  // With the scripted model the CLI's proxy is the model itself, which refuses every other host.
  const passthrough: Partial<Record<SdkChildPassthroughVar, string>> =
    scripted === null
      ? {}
      : {
          HTTP_PROXY: scripted,
          HTTPS_PROXY: scripted,
          NO_PROXY: "127.0.0.1,localhost",
          CLAUDE_CODE_MAX_RETRIES: "0",
        };
  const product: Partial<Record<EnvVarName, string>> = {
    ...(options.model.kind === "real"
      ? { ANTHROPIC_API_KEY: options.model.apiKey }
      : {
          ANTHROPIC_API_KEY: FAKE_CREDENTIALS.anthropicApiKey,
          ANTHROPIC_BASE_URL: options.model.url,
        }),
    PORT: String(options.port),
    AGENT_STATE_DIR: options.stateDir,
    AGENT_BUSINESS_DATE: options.fakes.fixtures.company.businessDate,
    ...(options.sandbox ? { AGENT_SANDBOX: "1" } : {}),
    ...options.fakes.env(),
    ...options.extra,
  };
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(options.stateDir, "server-home"),
    TMPDIR: tmpdir(),
  };
  for (const [name, value] of Object.entries({ ...passthrough, ...product })) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const cleanups: (() => Promise<void> | void)[] = [];
  const close = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  try {
    const fakes = await startFakes({
      hubspot: options.hubspot ?? "stdio",
      ...(options.prefixes === undefined ? {} : { prefixes: options.prefixes }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    cleanups.push(() => fakes.close());
    options.arrange?.(fakes);

    let model: MockAnthropic | null = null;
    let script: ScenarioResponder | null = null;
    let endpoint: ModelEndpoint;
    if (
      options.model !== undefined &&
      typeof options.model === "object" &&
      "real" in options.model
    ) {
      endpoint = { kind: "real", apiKey: options.model.real.apiKey };
    } else {
      const scripted = responderFor(options.model);
      script = scripted.script;
      const mock = await startMockAnthropic(FAKE_CREDENTIALS.anthropicApiKey, scripted.respond);
      cleanups.push(() => mock.close());
      model = mock;
      endpoint = { kind: "scripted", url: mock.url };
    }

    let stateDir = options.stateDir;
    if (stateDir === undefined) {
      const created = realpathSync(mkdtempSync(join(tmpdir(), "revenue-desk-harness-")));
      cleanups.push(() => rmSync(created, { recursive: true, force: true }));
      stateDir = created;
    }
    mkdirSync(join(stateDir, "server-home"), { recursive: true });
    const mode = options.server ?? "process";
    const port = options.port ?? (mode === "none" ? 0 : await freePort());
    const env = harnessEnvironment({
      fakes,
      model: endpoint,
      stateDir,
      port,
      sandbox: options.sandbox ?? true,
      ...(options.env === undefined ? {} : { extra: options.env }),
    });

    let url: string | null = null;
    let serverLog = () => "";
    if (mode === "process") {
      const server = await spawnServer(env, options.entry ?? "source", options.onServerOutput);
      cleanups.push(() => server.stop());
      url = server.url;
      serverLog = server.log;
    } else if (mode === "in-process") {
      const lines: string[] = [];
      const loaded = loadAgentEnv(env, { cwd: REPOSITORY_ROOT });
      if (!loaded.ok)
        throw new Error(`The harness environment was refused: ${JSON.stringify(loaded.problems)}`);
      const catalog = createIntegrations();
      const server = await startServer({
        env: loaded.env,
        runTurn: createRunTurn({
          catalog,
          version: "0.0.0-harness",
          // As src/server/main.ts: usage baselines from the database.
          usageStore: stateDirUsageBaselines,
          onStderr: (line) => lines.push(`[claude] ${line}`),
        }),
        integrations: Object.values(catalog),
        version: "0.0.0-harness",
        log: (line) => lines.push(line),
      });
      cleanups.push(() => server.close());
      url = server.url;
      serverLog = () => lines.join("\n");
    }
    const api = url === null ? null : new ApiClient(url);
    const workspace =
      api === null || options.workspace === "default"
        ? "kept"
        : await applyWorkspaceSettings(api, fakes);
    return {
      fakes,
      model,
      script,
      stateDir,
      env,
      url,
      api,
      workspace,
      serverLog: () => serverLog(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** PATCH /api/settings with the fixture company's workspace settings. */
export async function applyWorkspaceSettings(
  api: ApiClient,
  fakes: Fakes,
): Promise<"applied" | "unsupported"> {
  const probe = await fetch(`${api.baseUrl}/api/session`);
  if (probe.status === 404) return "unsupported";
  await api.session();
  await api.expect("PATCH /api/settings", { body: fakes.fixtures.company.workspaceSettings });
  return "applied";
}

function responderFor(model: Exclude<HarnessOptions["model"], RealModel>): {
  readonly respond: Responder;
  readonly script: ScenarioResponder | null;
} {
  if (model === undefined) {
    const script = sandboxResponder();
    return { respond: script.respond, script };
  }
  if (typeof model === "function") return { respond: model, script: null };
  if ("respond" in model) return { respond: model.respond, script: model };
  const script = scenarioResponder(model);
  return { respond: script.respond, script };
}

/** A free loopback port (closed again before the server binds it). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

interface ServerProcess {
  readonly url: string;
  log(): string;
  stop(): Promise<void>;
}

async function spawnServer(
  env: Readonly<Record<string, string>>,
  entry: "source" | "built",
  onOutput?: (text: string) => void,
): Promise<ServerProcess> {
  const args =
    entry === "built"
      ? [join(REPOSITORY_ROOT, "dist/server/main.js")]
      : [
          "--import",
          pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
          join(REPOSITORY_ROOT, "src/server/main.ts"),
        ];
  const child = spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-65_536);
    onOutput?.(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const url = `http://127.0.0.1:${env.PORT}`;
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", (code) => resolveExit(code)),
  );
  const deadline = Date.now() + 30_000;
  while (true) {
    const early = await Promise.race([exited, delay(100).then(() => "pending" as const)]);
    if (early !== "pending")
      throw new Error(`The server exited (code ${String(early)}) before it was ready:\n${output}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      await stopChild(child, exited);
      throw new Error(`The server was not ready within 30 s:\n${output}`);
    }
  }
  // If this process exits without stopping the server (a crash), take it down too.
  const killOnExit = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.once("exit", killOnExit);
  return {
    url,
    log: () => output,
    stop: async () => {
      process.off("exit", killOnExit);
      await stopChild(child, exited);
    },
  };
}

async function stopChild(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
