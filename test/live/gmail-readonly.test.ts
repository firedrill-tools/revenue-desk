/**
 * Live and read-only (docs/ARCHITECTURE.md §11, "Optional live E2E"): the
 * real model summarises the connected Gmail inbox through Composio, from the
 * headless CLI, exactly as a person would run it.
 *
 * - Every action class except read is denied (AGENT_POLICY), so the Composio
 *   session is created with access "read" and no Gmail write tool is even
 *   offered; the run is capped at AGENT_MAX_BUDGET_USD=0.50.
 * - Keys are loaded at runtime and never printed: COMPOSIO_API_KEY and
 *   COMPOSIO_USER_ID through DOTENV_PATH (default ../gmail-agent/.env), and
 *   ANTHROPIC_API_KEY from LIVE_MODEL_ENV (default this repository's .env,
 *   which git ignores).
 * - Before the run, the connections are checked read-only and stored, as the
 *   app's Check does, so an integration Composio cannot serve is unavailable
 *   to the run instead of failing mid-run.
 * - The reply and the tool outputs contain real email. Nothing here prints
 *   them: assertions and the log line carry counts and tool names only. With
 *   LIVE_OUT_DIR set, the state directory (database and summary) is kept
 *   there for review; otherwise it is a temporary directory that is removed.
 *
 * Runs only under `LIVE_E2E=1 pnpm test:live`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgentEnv, withDotenvFile } from "../../src/config/env.js";
import type { RunSummary } from "../../src/contracts/cli.js";
import { ENV_DEFAULTS } from "../../src/contracts/env.js";
import type { ActionClass, ApprovalMode } from "../../src/contracts/integration.js";
import { databasePath, openDatabase } from "../../src/db/client.js";
import { saveConnectionStatus } from "../../src/db/repos/connections.js";
import { seedDatabase } from "../../src/db/seed.js";
import { checkConnections, integrations } from "../../src/integrations/registry.js";
import { REPOSITORY_ROOT } from "../support/harness.js";

if (process.env.LIVE_E2E !== "1") {
  throw new Error("Live tests read a real mailbox and cost money: run them with LIVE_E2E=1.");
}

const PROMPT =
  "What are the three most recent emails in my inbox about? Just summarise; don't change anything.";
const BUDGET_USD = 0.5;

/** Every class that can change something is denied; only reads run. */
const READ_ONLY_POLICY: { readonly [C in ActionClass]?: ApprovalMode } = {
  internal_write: "deny",
  outbound: "deny",
  financial: "deny",
  destructive: "deny",
};

/** Decisions under which a call actually ran. */
const RAN = new Set(["auto", "approved"]);
/** Decisions under which a call was stopped before it ran. */
const STOPPED = new Set(["denied", "policy_denied", "rejected", "stopped", "timed_out"]);

const dotenvPath = resolve(
  REPOSITORY_ROOT,
  process.env.DOTENV_PATH?.trim() || "../gmail-agent/.env",
);
const modelEnvPath = resolve(REPOSITORY_ROOT, process.env.LIVE_MODEL_ENV?.trim() || ".env");
const outDir = process.env.LIVE_OUT_DIR?.trim() || null;

function modelKey(): string {
  const key = parseEnv(readFileSync(modelEnvPath, "utf8")).ANTHROPIC_API_KEY?.trim() ?? "";
  if (key === "") throw new Error(`No ANTHROPIC_API_KEY in ${modelEnvPath}`);
  return key;
}

function stateDirectory(): string {
  if (outDir === null) return realpathSync(mkdtempSync(join(tmpdir(), "revenue-desk-live-")));
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  return realpathSync(mkdtempSync(join(outDir, "gmail-readonly-")));
}

function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const child = spawn(
    process.execPath,
    ["--import", tsx, join(REPOSITORY_ROOT, "src/cli/main.ts"), ...args],
    { cwd: REPOSITORY_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (piece: string) => {
    stdout += piece;
  });
  child.stderr.setEncoding("utf8").on("data", (piece: string) => {
    stderr += piece;
  });
  return new Promise((resolveRun, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The CLI did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

/** "GMAIL_FETCH_EMAILS x2" style counts, for the log and assertion messages. */
function countNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} x${count}`).join(", ") || "none";
}

describe("live: Gmail through Composio, read-only", () => {
  const stateDir = stateDirectory();
  afterAll(() => {
    if (outDir === null) rmSync(stateDir, { recursive: true, force: true });
  });

  it("summarises the inbox with read tools only, within $0.50", async () => {
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HOME: join(stateDir, "home"),
      DOTENV_PATH: dotenvPath,
      ANTHROPIC_API_KEY: modelKey(),
      // The DOTENV_PATH file belongs to another app; these win over its values.
      AGENT_MODEL: ENV_DEFAULTS.AGENT_MODEL,
      AGENT_MAX_TURNS: "12",
      AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
      AGENT_POLICY: JSON.stringify(READ_ONLY_POLICY),
      AGENT_STATE_DIR: stateDir,
    };
    mkdirSync(environment.HOME as string, { recursive: true });

    // The app's Check, read-only: Composio lists the user's connections.
    const merged = withDotenvFile(environment, { cwd: REPOSITORY_ROOT });
    if (!merged.ok) throw new Error(`DOTENV_PATH: ${merged.problem.message}`);
    const loaded = loadAgentEnv(merged.environment, { cwd: REPOSITORY_ROOT });
    if (!loaded.ok) {
      throw new Error(
        `Configuration refused: ${loaded.problems.map((problem) => problem.variable).join(", ")}`,
      );
    }
    const statuses = await checkConnections(
      integrations(),
      loaded.env,
      AbortSignal.timeout(60_000),
    );
    const states = Object.fromEntries(statuses.map((status) => [status.integration, status.state]));
    expect(states.gmail, "Gmail must be connected in Composio for this user").toBe("connected");
    const database = openDatabase({ path: databasePath(stateDir) });
    try {
      const now = new Date().toISOString();
      seedDatabase(database.db, now);
      for (const status of statuses) saveConnectionStatus(database.db, status, now);
    } finally {
      database.close();
    }

    const result = await runCli(["ask", "--json", PROMPT], environment, 240_000);
    if (outDir !== null) {
      writeFileSync(join(stateDir, "summary.json"), result.stdout);
      writeFileSync(join(stateDir, "stderr.txt"), result.stderr);
    }
    let summary: RunSummary;
    try {
      summary = JSON.parse(result.stdout) as RunSummary;
    } catch {
      throw new Error(`stdout was not one JSON run summary (exit ${String(result.code)})`);
    }

    const ran = summary.toolCalls.filter((call) => RAN.has(call.decision));
    const notRead = summary.toolCalls.filter((call) => call.actionClass !== "read");
    const cost = summary.usage?.costUsd ?? Number.NaN;
    console.log(
      `live gmail read-only: ${summary.status} (exit ${String(result.code)}), ` +
        `Gmail ${states.gmail}, Calendar ${String(states.google_calendar)}; ` +
        `ran ${ran.length}: ${countNames(ran.map((call) => call.tool))}; ` +
        `blocked ${notRead.length}: ${countNames(notRead.map((call) => `${call.tool}:${call.decision}`))}; ` +
        `$${cost.toFixed(4)}, ${summary.usage?.numTurns ?? "?"} turns, ${summary.model}`,
    );

    expect(result.code, "exit code").toBe(0);
    expect(summary.status, "run status").toBe("completed");
    expect(summary.error, "run error").toBeNull();
    expect((summary.reply ?? "").trim().length, "reply length").toBeGreaterThan(0);
    expect(
      summary.connections.find((connection) => connection.integration === "gmail")?.availability,
      "Gmail offered to the run",
    ).toBe("ready");

    // Only Gmail reads ran; at least one did.
    expect(ran.length, "calls that ran").toBeGreaterThan(0);
    expect(
      ran.filter((call) => call.integration !== "gmail" || call.actionClass !== "read"),
      "calls that ran other than Gmail reads",
    ).toEqual([]);
    // Nothing was sent, drafted or labelled: no write-class call ran.
    expect(
      notRead
        .filter((call) => !STOPPED.has(call.decision))
        .map((call) => `${call.tool}:${call.decision}`),
      "non-read calls that were not stopped",
    ).toEqual([]);

    // The database agrees: the run used the read-only policy, and every call
    // that succeeded is a Gmail read.
    const sqlite = new Database(databasePath(stateDir), { readonly: true, fileMustExist: true });
    try {
      const run = sqlite
        .prepare("SELECT source, mode, status, policy_snapshot FROM runs WHERE id = ?")
        .get(summary.runId) as
        | { source: string; mode: string; status: string; policy_snapshot: string }
        | undefined;
      expect(run?.source, "run source").toBe("cli");
      expect(run?.mode, "run mode").toBe("headless");
      expect(run?.status, "stored run status").toBe("completed");
      expect(JSON.parse(run?.policy_snapshot ?? "{}"), "stored policy").toMatchObject({
        read: "auto",
        ...READ_ONLY_POLICY,
      });
      const succeeded = sqlite
        .prepare("SELECT operation, action_class FROM tool_calls WHERE run_id = ? AND status = ?")
        .all(summary.runId, "succeeded") as { operation: string | null; action_class: string }[];
      expect(
        succeeded
          .filter((row) => row.action_class !== "read" || !row.operation?.startsWith("gmail."))
          .map((row) => row.operation),
        "succeeded calls other than Gmail reads",
      ).toEqual([]);
    } finally {
      sqlite.close();
    }

    expect(cost, "cost in USD").toBeGreaterThan(0);
    expect(cost, "cost in USD").toBeLessThan(BUDGET_USD);
  });
});
