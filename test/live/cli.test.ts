/**
 * Live: the headless CLI with the real model and no integration (each run
 * receives only the model key). What it does once a run is under way: the
 * reply on stdout and the status line on stderr, `--json`, continuing a
 * conversation (its SDK session is resumed), the app showing the CLI's runs,
 * SIGTERM mid-run, and a CLI killed with SIGKILL not blocking its
 * conversation. What it decides before a model call is in test/cli
 * (`pnpm test:cli`, no model).
 *
 * The prompts ask for plain text only, so no tool is called. Each run is
 * capped at $0.25.
 *
 * Runs only under `LIVE_E2E=1 pnpm test:live`.
 */
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { createRunTurn } from "../../src/agent/run-turn.js";
import { CLI_EXIT_CODES } from "../../src/contracts/cli.js";
import { databasePath } from "../../src/db/client.js";
import { stateDirUsageBaselines } from "../../src/db/usage-baseline.js";
import { createIntegrations } from "../../src/integrations/registry.js";
import { startServer } from "../../src/server/runtime.js";
import { ApiClient } from "../support/api-client.js";
import { freePort } from "../support/repository.js";
import {
  agentEnvOf,
  askJson,
  type LiveStateDir,
  liveEnvironment,
  liveStateDir,
  prepareWorkspace,
  requireLive,
  runCli,
} from "./support.js";

requireLive();

const BUDGET_USD = 0.25;
/** Long enough to be stopped part-way; no tool is needed. */
const LONG_PROMPT = "Write the whole numbers from 1 to 400, one per line, and nothing else.";

const states: LiveStateDir[] = [];

afterAll(() => {
  for (const state of states) state.cleanup();
});

function workspace(label: string): { state: LiveStateDir; environment: Record<string, string> } {
  const state = liveStateDir(label);
  states.push(state);
  const environment = liveEnvironment(state.dir, [], {
    AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
  });
  prepareWorkspace(state.dir, new Map());
  return { state, environment };
}

function onlyConversation(stateDir: string): string {
  const sqlite = new Database(databasePath(stateDir), { readonly: true, fileMustExist: true });
  try {
    const rows = sqlite.prepare("SELECT id FROM conversations").all() as { id: string }[];
    expect(rows).toHaveLength(1);
    return rows[0]?.id ?? "";
  } finally {
    sqlite.close();
  }
}

function runsOf(stateDir: string): { id: string; status: string; error_code: string | null }[] {
  const sqlite = new Database(databasePath(stateDir), { readonly: true, fileMustExist: true });
  try {
    return sqlite.prepare("SELECT id, status, error_code FROM runs ORDER BY started_at").all() as {
      id: string;
      status: string;
      error_code: string | null;
    }[];
  } finally {
    sqlite.close();
  }
}

describe("live: the headless CLI with the real model", () => {
  it("replies on stdout, continues the conversation with --json, and the app shows both runs", async () => {
    const { state, environment } = workspace("cli-reply");
    const first = await runCli(["ask", "Reply with exactly the word: ready"], {
      environment,
      keepIn: state.kept ? state.dir : null,
    });
    expect(first.code, first.stderr).toBe(CLI_EXIT_CODES.completed);
    expect(first.stdout.toLowerCase()).toContain("ready");
    expect(first.stderr).toMatch(/Done in [\d.]+ m?s · 0 tool calls · \$\d+\.\d{4}/);
    const conversationId = onlyConversation(state.dir);

    const { run, summary } = await askJson({
      state,
      environment,
      prompt: "Reply with exactly the word: again",
      policy: {},
      budgetUsd: BUDGET_USD,
      conversationId,
    });
    expect(run.code).toBe(CLI_EXIT_CODES.completed);
    expect(summary).toMatchObject({
      kind: "revenue-desk.run-summary",
      status: "completed",
      conversationId,
      mode: "headless",
      toolCalls: [],
      error: null,
    });
    expect((summary.reply ?? "").toLowerCase()).toContain("again");
    expect(summary.usage?.costUsd ?? 0).toBeGreaterThan(0);

    // The app, opened on the same state directory, lists both runs as the CLI's.
    const port = await freePort();
    const env = agentEnvOf({ ...environment, PORT: String(port) });
    const catalog = createIntegrations();
    const server = await startServer({
      env,
      runTurn: createRunTurn({
        catalog,
        version: "0.0.0-live",
        usageStore: stateDirUsageBaselines,
      }),
      integrations: Object.values(catalog),
      version: "0.0.0-live",
      log: () => {},
    });
    try {
      const api = new ApiClient(server.url);
      await api.session();
      const runs = await api.expect("GET /api/runs", { query: { conversationId, limit: 10 } });
      expect(runs.items.map((item) => [item.source, item.status])).toEqual([
        ["cli", "completed"],
        ["cli", "completed"],
      ]);
    } finally {
      await server.close();
    }
  });

  it("SIGTERM mid-run cancels it and exits 130 within 2 s", async () => {
    const { state, environment } = workspace("cli-sigterm");
    const run = await runCli(["ask", LONG_PROMPT], {
      environment,
      stop: { signal: "SIGTERM", onOutput: /^\s*20\s*$/m },
      keepIn: state.kept ? state.dir : null,
    });
    expect(run.afterSignalMs, "the run finished before it could be stopped").not.toBeNull();
    expect(run.code).toBe(CLI_EXIT_CODES.cancelled);
    expect(run.afterSignalMs ?? Number.POSITIVE_INFINITY).toBeLessThan(2_000);
    expect(run.stderr).toContain("Cancelled");
    expect(runsOf(state.dir).map((row) => row.status)).toEqual(["cancelled"]);
  });

  it("a CLI killed with SIGKILL does not block its conversation: the next invocation recovers it", async () => {
    const { state, environment } = workspace("cli-sigkill");
    const killed = await runCli(["ask", LONG_PROMPT], {
      environment,
      stop: { signal: "SIGKILL", onOutput: /^\s*20\s*$/m },
      keepIn: state.kept ? state.dir : null,
    });
    expect(killed.signal).toBe("SIGKILL");
    const conversationId = onlyConversation(state.dir);
    expect(runsOf(state.dir).map((row) => row.status)).toEqual(["running"]);

    const { run, summary } = await askJson({
      state,
      environment,
      prompt: "Reply with exactly the word: ok",
      policy: {},
      budgetUsd: BUDGET_USD,
      conversationId,
    });
    expect(run.code).toBe(CLI_EXIT_CODES.completed);
    expect(summary.status).toBe("completed");
    expect(run.stderr).toContain("recovered 1 earlier run(s) whose process had exited.");
    expect(runsOf(state.dir).map((row) => [row.status, row.error_code])).toEqual([
      ["failed", "server_restart"],
      ["completed", null],
    ]);
  });
});
