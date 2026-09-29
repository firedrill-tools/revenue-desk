/**
 * Support for the live suites (`pnpm test:live`, `pnpm test:live:writes`):
 * the real model and the real accounts configured in the env file, through
 * the product's own code paths. Nothing here stands in for a service.
 *
 * - Keys come from the file DOTENV_PATH names (default: this repository's
 *   git-ignored .env). They are passed to children in an explicit
 *   environment and are never printed; a test chooses which integrations'
 *   variables a run receives, so a run reaches only the systems under test.
 * - A test checks the connections read-only first, as the app's Check does,
 *   and skips with the reason when its integration is not connected or not
 *   configured, unless LIVE_REQUIRE names it: then it fails with the reason
 *   (require.ts). It never fakes one.
 * - Replies and tool outputs hold real data. Tests print counts, tool names
 *   and states only. With LIVE_OUT_DIR (outside the repository) each run's
 *   state directory, summary and stderr are kept there for review;
 *   otherwise they live in a temporary directory that is removed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import Database from "better-sqlite3";
import type { TestContext } from "vitest";
import { loadAgentEnv } from "../../src/config/env.js";
import type { SettingsUpdate } from "../../src/contracts/api.js";
import type { RunSummary, RunSummaryToolCall } from "../../src/contracts/cli.js";
import {
  type AgentEnv,
  ENV_VAR_NAMES,
  ENV_VARS,
  type EnvVarName,
} from "../../src/contracts/env.js";
import {
  type ActionClass,
  type ApprovalMode,
  type ConnectionStatus,
  INTEGRATIONS,
  type IntegrationId,
} from "../../src/contracts/integration.js";
import { databasePath, openDatabase } from "../../src/db/client.js";
import { saveConnectionStatus } from "../../src/db/repos/connections.js";
import { updateSettings } from "../../src/db/repos/settings.js";
import { seedDatabase } from "../../src/db/seed.js";
import { checkConnections, integrations } from "../../src/integrations/registry.js";
import { REPOSITORY_ROOT } from "../support/repository.js";
import { requiredFailure, requiredIntegrations } from "./require.js";

// ---------------------------------------------------------------------------
// Opt-in
// ---------------------------------------------------------------------------

export function requireLive(): void {
  if (process.env.LIVE_E2E !== "1") {
    throw new Error(
      "Live tests call the real model and real accounts and cost money: run them with LIVE_E2E=1.",
    );
  }
  // A LIVE_REQUIRE that names no integration fails the suite before anything runs.
  requiredIntegrations();
}

export function requireLiveWrites(): void {
  requireLive();
  if (process.env.LIVE_E2E_WRITES !== "1") {
    throw new Error(
      "Live write tests change real (test-safe) accounts: run them with LIVE_E2E=1 LIVE_E2E_WRITES=1.",
    );
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The env file with the real keys. */
export const LIVE_DOTENV = resolve(REPOSITORY_ROOT, process.env.DOTENV_PATH?.trim() || ".env");

let fileValues: Readonly<Record<string, string>> | undefined;

/** The env file's non-blank values. Never print them. */
export function liveFileValues(): Readonly<Record<string, string>> {
  if (fileValues === undefined) {
    let text: string;
    try {
      text = readFileSync(LIVE_DOTENV, "utf8");
    } catch {
      throw new Error(`The live env file ${LIVE_DOTENV} could not be read (set DOTENV_PATH).`);
    }
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(parseEnv(text))) {
      if (value !== undefined && value.trim() !== "") values[name] = value.trim();
    }
    fileValues = values;
  }
  return fileValues;
}

/** Which systems a run may reach: the model always, plus the chosen integrations. */
export type Scope = "composio" | "hubspot" | "stripe";

const SCOPE_OF_GROUP: Readonly<Record<string, Scope | "model" | undefined>> = {
  model: "model",
  gmail: "composio",
  hubspot: "hubspot",
  stripe: "stripe",
};

/**
 * An explicit child environment: PATH, HOME and TMPDIR, the state directory,
 * the model key and the env file's values for the chosen integrations only.
 * Nothing is inherited from this process.
 */
export function liveEnvironment(
  stateDir: string,
  scopes: readonly Scope[],
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const values = liveFileValues();
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(stateDir, "home"),
    TMPDIR: tmpdir(),
    AGENT_STATE_DIR: stateDir,
  };
  mkdirSync(environment.HOME as string, { recursive: true });
  for (const name of ENV_VAR_NAMES) {
    const scope = SCOPE_OF_GROUP[ENV_VARS[name].group];
    if (scope === undefined) continue;
    if (scope !== "model" && !scopes.includes(scope)) continue;
    const value = values[name];
    if (value !== undefined) environment[name] = value;
  }
  if (environment.ANTHROPIC_API_KEY === undefined) {
    throw new Error(`No ANTHROPIC_API_KEY in ${LIVE_DOTENV}.`);
  }
  return { ...environment, ...extra };
}

/** The snapshot the product builds from that environment. */
export function agentEnvOf(environment: Readonly<Record<string, string>>): AgentEnv {
  const loaded = loadAgentEnv(environment, { cwd: REPOSITORY_ROOT });
  if (!loaded.ok) {
    const names = loaded.problems.map((problem) => problem.variable).join(", ");
    throw new Error(`The live configuration was refused: ${names}`);
  }
  return loaded.env;
}

/** A configured value from the env file, or null. Never print it. */
export function liveValue(name: EnvVarName): string | null {
  return liveFileValues()[name] ?? null;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export type LiveConnections = ReadonlyMap<IntegrationId, ConnectionStatus>;

/** Every integration checked read-only, as the app's Check does. */
export async function checkLive(env: AgentEnv): Promise<LiveConnections> {
  const statuses = await checkConnections(integrations(), env, AbortSignal.timeout(90_000));
  return new Map(statuses.map((status) => [status.integration, status]));
}

/** Null when the integration is connected; otherwise why it cannot be used, and what to do. */
export function unavailableReason(
  connections: LiveConnections,
  integration: IntegrationId,
): string | null {
  const status = connections.get(integration);
  const label = INTEGRATIONS[integration].label;
  if (status === undefined) return `${label} was not checked.`;
  switch (status.state) {
    case "connected":
      return null;
    case "needs_auth":
    case "expired":
      return `${label} needs sign-in (${status.state}): ${status.detail}`;
    case "not_configured":
      return `${label} is not configured: set ${status.missing.join(" and ")} in ${LIVE_DOTENV}.`;
    default:
      return `${label} is ${status.state}: ${status.detail}`;
  }
}

/**
 * The test cannot exercise `integration`, for `reason`: it fails with the
 * reason when LIVE_REQUIRE names the integration, and skips otherwise. Logs
 * the outcome under `label` either way.
 */
export function cannotTest(
  context: Pick<TestContext, "skip">,
  label: string,
  integration: IntegrationId,
  reason: string,
): never {
  const failure = requiredFailure(integration, reason);
  if (failure !== null) {
    console.log(`${label}: failed. ${failure.message}`);
    throw failure;
  }
  console.log(`${label}: skipped. ${reason}`);
  return context.skip(reason);
}

/** One line per integration: "gmail connected, stripe not_configured, …". */
export function describeConnections(connections: LiveConnections): string {
  return [...connections.values()]
    .map((status) => `${status.integration} ${status.state}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// State directories and the workspace
// ---------------------------------------------------------------------------

/** LIVE_OUT_DIR, which must be outside the repository (real data goes there). */
export function liveOutDir(): string | null {
  const raw = process.env.LIVE_OUT_DIR?.trim();
  if (raw === undefined || raw === "") return null;
  const dir = resolve(raw);
  const inside = relative(REPOSITORY_ROOT, dir);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new Error("LIVE_OUT_DIR must be outside the repository: live runs hold real data.");
  }
  return dir;
}

export type LiveStateDir = { readonly dir: string; readonly kept: boolean; cleanup(): void };

export function liveStateDir(label: string): LiveStateDir {
  const out = liveOutDir();
  if (out === null) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `revenue-desk-live-${label}-`)));
    return { dir, kept: false, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const dir = realpathSync(mkdtempSync(join(out, `${label}-`)));
  return { dir, kept: true, cleanup: () => {} };
}

/**
 * The state directory as the app leaves it: seeded, with the connection
 * checks stored (so a run leaves out what Composio cannot serve) and the
 * workspace settings a test needs.
 */
export function prepareWorkspace(
  stateDir: string,
  connections: LiveConnections,
  settings: SettingsUpdate = {},
): void {
  const database = openDatabase({ path: databasePath(stateDir) });
  try {
    const now = new Date().toISOString();
    seedDatabase(database.db, now);
    for (const status of connections.values()) saveConnectionStatus(database.db, status, now);
    if (Object.keys(settings).length > 0) updateSettings(database.db, settings, now);
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export type Policy = { readonly [C in ActionClass]?: ApprovalMode };

/** Every class that can change something is denied; only reads run. */
export const READ_ONLY_POLICY: Policy = {
  read: "auto",
  internal_write: "deny",
  outbound: "deny",
  financial: "deny",
  destructive: "deny",
};

/** Decisions under which a call actually ran. */
export const RAN: ReadonlySet<string> = new Set(["auto", "approved"]);
/** Decisions under which a call was stopped before it ran. */
export const STOPPED: ReadonlySet<string> = new Set([
  "denied",
  "policy_denied",
  "rejected",
  "stopped",
  "timed_out",
]);

// ---------------------------------------------------------------------------
// The headless CLI with the real model
// ---------------------------------------------------------------------------

export type CliRun = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** From the stop signal to exit, when one was sent. */
  readonly afterSignalMs: number | null;
};

export type CliRunOptions = {
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Sends this signal once stdout or stderr matches `onOutput`. */
  readonly stop?: { readonly signal: NodeJS.Signals; readonly onOutput: RegExp };
  /** Where to keep stdout and stderr (a kept state directory). */
  readonly keepIn?: string | null;
};

/** `revenue-desk <args>` from source, as a separate process. */
export function runCli(args: readonly string[], options: CliRunOptions): Promise<CliRun> {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const child = spawn(
    process.execPath,
    ["--import", tsx, join(REPOSITORY_ROOT, "src/cli/main.ts"), ...args],
    { cwd: REPOSITORY_ROOT, env: options.environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let signalledAt: number | null = null;
  const maybeStop = () => {
    const stop = options.stop;
    if (stop === undefined || signalledAt !== null) return;
    if (stop.onOutput.test(stdout) || stop.onOutput.test(stderr)) {
      signalledAt = performance.now();
      child.kill(stop.signal);
    }
  };
  child.stdout.setEncoding("utf8").on("data", (piece: string) => {
    stdout += piece;
    maybeStop();
  });
  child.stderr.setEncoding("utf8").on("data", (piece: string) => {
    stderr += piece;
    maybeStop();
  });
  const timeoutMs = options.timeoutMs ?? 240_000;
  return new Promise((resolveRun, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The CLI did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const ended = performance.now();
      if (options.keepIn) {
        const stamp = Date.now().toString(36);
        writeFileSync(join(options.keepIn, `stdout-${stamp}.txt`), stdout, { mode: 0o600 });
        writeFileSync(join(options.keepIn, `stderr-${stamp}.txt`), stderr, { mode: 0o600 });
      }
      resolveRun({
        code,
        signal,
        stdout,
        stderr,
        afterSignalMs: signalledAt === null ? null : ended - signalledAt,
      });
    });
  });
}

export type AskOptions = {
  readonly state: LiveStateDir;
  readonly environment: Readonly<Record<string, string>>;
  readonly prompt: string;
  readonly policy: Policy;
  readonly budgetUsd: number;
  readonly maxTurns?: number;
  readonly conversationId?: string;
};

/** One headless run with `--json`; the summary must be the only thing on stdout. */
export async function askJson(
  options: AskOptions,
): Promise<{ readonly run: CliRun; readonly summary: RunSummary }> {
  const args = [
    "ask",
    "--json",
    "--policy",
    JSON.stringify(options.policy),
    "--max-budget-usd",
    options.budgetUsd.toFixed(2),
    "--max-turns",
    String(options.maxTurns ?? 12),
    ...(options.conversationId === undefined ? [] : ["--conversation", options.conversationId]),
    options.prompt,
  ];
  const run = await runCli(args, {
    environment: options.environment,
    keepIn: options.state.kept ? options.state.dir : null,
  });
  let summary: RunSummary;
  try {
    summary = JSON.parse(run.stdout) as RunSummary;
  } catch {
    throw new Error(`stdout was not one JSON run summary (exit ${String(run.code)})`);
  }
  return { run, summary };
}

// ---------------------------------------------------------------------------
// What a run did
// ---------------------------------------------------------------------------

export function ranCalls(summary: RunSummary): RunSummaryToolCall[] {
  return summary.toolCalls.filter((call) => RAN.has(call.decision));
}

/** "GMAIL_FETCH_EMAILS x2" style counts, for the log and assertion messages. */
export function countNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} x${count}`).join(", ") || "none";
}

/** One log line with no real data: status, calls by name, cost and turns. */
export function describeRun(label: string, run: CliRun, summary: RunSummary): string {
  const ran = ranCalls(summary);
  const stopped = summary.toolCalls.filter((call) => !RAN.has(call.decision));
  return (
    `live ${label}: ${summary.status} (exit ${String(run.code)}); ` +
    `ran ${ran.length}: ${countNames(ran.map((call) => call.tool))}; ` +
    `stopped ${stopped.length}: ${countNames(stopped.map((call) => `${call.tool}:${call.decision}`))}; ` +
    `$${(summary.usage?.costUsd ?? Number.NaN).toFixed(4)}, ${summary.usage?.numTurns ?? "?"} turns, ${summary.model}`
  );
}

export type StoredCall = {
  readonly tool_name: string;
  readonly integration: string | null;
  readonly operation: string | null;
  readonly action_class: string | null;
  readonly decision: string;
  readonly status: string;
  readonly idempotency_key: string | null;
  readonly http_status: number | null;
};

/** The run's row and its tool calls, read with plain SQL. */
export function storedRun(
  stateDir: string,
  runId: string,
): {
  readonly run:
    | { source: string; mode: string; status: string; policy_snapshot: string }
    | undefined;
  readonly calls: readonly StoredCall[];
} {
  const sqlite = new Database(databasePath(stateDir), { readonly: true, fileMustExist: true });
  try {
    const run = sqlite
      .prepare("SELECT source, mode, status, policy_snapshot FROM runs WHERE id = ?")
      .get(runId) as
      | { source: string; mode: string; status: string; policy_snapshot: string }
      | undefined;
    const calls = sqlite
      .prepare(
        "SELECT tool_name, integration, operation, action_class, decision, status, idempotency_key, http_status FROM tool_calls WHERE run_id = ? ORDER BY started_at",
      )
      .all(runId) as StoredCall[];
    return { run, calls };
  } finally {
    sqlite.close();
  }
}

/** A marker for records a write test creates, so they can be found and removed. */
export function liveMarker(): string {
  return `revenue-desk-live-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
