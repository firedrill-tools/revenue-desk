/**
 * The built CLI end to end (docs/ARCHITECTURE.md §10, §11): `node
 * dist/cli/main.js ask …` as a separate process, with the real Claude Agent
 * SDK subprocess against the scripted model, every local fake, and the
 * shared SQLite state directory. Needs `pnpm build` first (pnpm verify runs
 * it before this suite). Fails, never skips, without the build or the native
 * Claude CLI.
 */
import { existsSync, rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createRunTurn } from "../../src/agent/run-turn.js";
import { loadAgentEnv } from "../../src/config/env.js";
import { CLI_EXIT_CODES, type RunSummary } from "../../src/contracts/cli.js";
import { databasePath } from "../../src/db/client.js";
import { stateDirUsageBaselines } from "../../src/db/usage-baseline.js";
import { createIntegrations } from "../../src/integrations/registry.js";
import { startServer } from "../../src/server/runtime.js";
import { expectedIdempotencyKey } from "../scenarios/facts.js";
import {
  J1_BILLING_INQUIRY,
  J2_REFUND_DUPLICATE,
  J5_WEEKLY_DIGEST,
  type Scenario,
  text,
} from "../scenarios/index.js";
import { J2_SLACK_UNAVAILABLE } from "../scenarios/j2-refund-duplicate.js";
import { J5_NOT_POSTED } from "../scenarios/j5-weekly-digest.js";
import { ApiClient } from "../support/api-client.js";
import { FAKE_CREDENTIAL_VALUES } from "../support/fakes/credentials.js";
import { freePort, type Harness, startHarness } from "../support/harness.js";
import { requireNativeSdkBinary } from "../support/sdk-gate-support.js";
import {
  BUILT_CLI,
  type CliResult,
  freshStateDir,
  prepareWorkspace,
  readState,
  requireBuiltCli,
  runBuiltCli,
  until,
} from "./support.js";

/** A model request that never gets an answer, so the run is still going when it is stopped. */
const MODEL_NEVER_ANSWERS: Scenario = {
  id: "cli-model-never-answers",
  job: "failure",
  title: "The model never answers",
  prompt: "Check the overnight payments (the scripted model never answers this).",
  steps: [() => ({ hang: true })],
  approvals: {},
  expected: { status: "cancelled" },
};

/** A CLI run that is killed with SIGKILL while its model request is open. */
const KILLED_MID_RUN: Scenario = {
  id: "cli-killed-mid-run",
  job: "failure",
  title: "The CLI is killed mid-run",
  prompt: "Reconcile yesterday's payouts (the scripted model never answers; the CLI is killed).",
  steps: [() => ({ hang: true })],
  approvals: {},
  expected: { status: "failed" },
};

/** The next turn of that conversation, in the app or in another CLI invocation. */
const AFTER_THE_KILL: Scenario = {
  id: "after-killed-cli",
  job: "failure",
  title: "Continue after the CLI was killed",
  prompt: "Pick up where the command line left off.",
  steps: [() => [text("Picked up after the command line stopped.")]],
  approvals: {},
  expected: { status: "completed" },
};

let harness: Harness;
let env: Record<string, string>;

beforeAll(async () => {
  requireBuiltCli();
  requireNativeSdkBinary();
  harness = await startHarness({
    server: "none",
    model: [
      J1_BILLING_INQUIRY,
      J2_REFUND_DUPLICATE,
      J5_WEEKLY_DIGEST,
      MODEL_NEVER_ANSWERS,
      KILLED_MID_RUN,
      AFTER_THE_KILL,
    ],
  });
  // The harness's environment without a server port (the CLI does not listen).
  const { PORT: _port, ...rest } = harness.env;
  env = rest;
});

afterAll(async () => {
  await harness?.close();
});

/** The real server (in this process) on a state directory the CLI wrote, as the app would open it. */
async function openApp(stateDir: string): Promise<{ api: ApiClient; close(): Promise<void> }> {
  const loaded = loadAgentEnv({
    ...env,
    AGENT_STATE_DIR: stateDir,
    PORT: String(await freePort()),
  });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.problems));
  const catalog = createIntegrations();
  const server = await startServer({
    env: loaded.env,
    runTurn: createRunTurn({
      catalog,
      version: "0.0.0-e2e",
      usageStore: stateDirUsageBaselines,
    }),
    integrations: Object.values(catalog),
    version: "0.0.0-e2e",
    log: () => {},
  });
  return { api: new ApiClient(server.url), close: () => server.close() };
}

function expectNoCredentials(result: CliResult): void {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const credential of FAKE_CREDENTIAL_VALUES) expect(output).not.toContain(credential);
}

function onlySummary(result: CliResult): RunSummary {
  expect(result.stdout.endsWith("\n")).toBe(true);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines, result.stdout).toHaveLength(1);
  const summary = JSON.parse(lines[0] ?? "") as RunSummary;
  expect(summary).toMatchObject({ kind: "revenue-desk.run-summary", version: 1, mode: "headless" });
  return summary;
}

describe("the built CLI against the fakes and the scripted model", () => {
  it("human mode prints the reply on stdout and a status line on stderr, and records the run", async () => {
    const stateDir = freshStateDir("human");
    prepareWorkspace(stateDir, harness.fakes);
    const result = await runBuiltCli(
      [
        "ask",
        "--state-dir",
        stateDir,
        "--policy",
        '{"financial":"auto"}',
        J2_REFUND_DUPLICATE.prompt,
      ],
      { env },
    );
    expect(result.code, result.stderr).toBe(CLI_EXIT_CODES.completed);
    expect(result.stdout).toContain("Refunded $490.00 on the duplicate charge");
    expect(result.stdout).toContain(J2_SLACK_UNAVAILABLE);
    expect(result.stdout).not.toContain('"kind"');
    // Progress lines per tool call, then one status line.
    expect(result.stderr).toContain("> Refund charge in Stripe [API]");
    expect(result.stderr.trimEnd().split("\n").at(-1)).toMatch(
      /^Done in \d+ ms · 5 tool calls · \$/,
    );
    expectNoCredentials(result);

    const state = readState(stateDir);
    expect(state.runs).toHaveLength(1);
    const [run] = state.runs;
    expect(run).toMatchObject({ source: "cli", mode: "headless", status: "completed" });
    expect(state.conversations).toEqual([
      expect.objectContaining({ id: run?.conversation_id, source: "cli", status: "idle" }),
    ]);
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    // --policy made the refund auto: it ran once, with the run's own key.
    expect(state.toolCalls.find((call) => call.tool_use_id === "toolu_j2_refund")).toMatchObject({
      connection_kind: "api",
      operation: "stripe.refunds.create",
      decision: "auto",
      status: "succeeded",
    });
    expect(harness.fakes.stripe.writes().map((write) => write.idempotencyKey)).toEqual([
      expectedIdempotencyKey(run?.id ?? "", "toolu_j2_refund"),
    ]);
    expect(harness.script?.problems ?? []).toEqual([]);

    // The app, opened on the same state directory, shows the CLI's run and conversation.
    const app = await openApp(stateDir);
    try {
      const runs = await app.api.expect("GET /api/runs", { query: { source: "cli" } });
      expect(runs.items.map((item) => [item.id, item.source, item.mode, item.status])).toEqual([
        [run?.id, "cli", "headless", "completed"],
      ]);
      const detail = await app.api.expect("GET /api/conversations/:conversationId", {
        params: { conversationId: run?.conversation_id ?? "" },
      });
      expect(detail.conversation.source).toBe("cli");
      expect(detail.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(detail.messages[1]?.parts)).toContain(J2_SLACK_UNAVAILABLE);
    } finally {
      await app.close();
    }
  });

  it("--json prints exactly one RunSummary; outbound actions are denied in headless mode", async () => {
    const stateDir = freshStateDir("json");
    prepareWorkspace(stateDir, harness.fakes);
    const sentBefore = harness.fakes.composio.gmail.outbox.length;
    const result = await runBuiltCli(
      ["ask", "--json", "--state-dir", stateDir, J1_BILLING_INQUIRY.prompt],
      { env },
    );
    expect(result.code, result.stderr).toBe(CLI_EXIT_CODES.completed);
    expectNoCredentials(result);
    const summary = onlySummary(result);
    expect(summary.status).toBe("completed");
    expect(summary.reply).toContain("saved as a draft and was not sent");
    expect(summary.connections).toHaveLength(6);
    expect(summary.usage).not.toBeNull();
    const byTool = (tool: string) => summary.toolCalls.find((call) => call.tool === tool);
    expect(byTool("mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT")).toMatchObject({
      connectionKind: "composio",
      decision: "auto",
      isError: false,
    });
    expect(byTool("mcp__gmail__GMAIL_SEND_DRAFT")).toMatchObject({
      actionClass: "outbound",
      decision: "policy_denied",
    });
    expect(new Set(summary.toolCalls.map((call) => call.connectionKind))).toEqual(
      new Set(["composio", "mcp", "api"]),
    );
    expect(harness.fakes.composio.gmail.outbox).toHaveLength(sentBefore);

    const state = readState(stateDir);
    expect(state.runs.map((run) => [run.id, run.source, run.status])).toEqual([
      [summary.runId, "cli", "completed"],
    ]);
    expect(state.toolCalls.find((call) => call.tool_use_id === "toolu_j1_send")).toMatchObject({
      decision: "policy_denied",
      status: "denied",
    });
  });

  it("missing or refused configuration exits 3 with a clear message, and nothing is recorded", async () => {
    const stateDir = freshStateDir("config");
    const { ANTHROPIC_API_KEY: _key, ...withoutKey } = env;
    const missing = await runBuiltCli(
      ["ask", "--json", "--state-dir", stateDir, J1_BILLING_INQUIRY.prompt],
      { env: withoutKey },
    );
    expect(missing.code).toBe(CLI_EXIT_CODES.config);
    expect(missing.stderr).toContain("ANTHROPIC_API_KEY is not set");
    const summary = onlySummary(missing);
    expect(summary).toMatchObject({ status: "failed", error: { code: "config_missing" } });
    expect(existsSync(databasePath(stateDir))).toBe(false);

    const refused = await runBuiltCli(["ask", "--state-dir", stateDir, "Hello"], {
      env: { ...env, AGENT_EFFORT: "turbo-9000" },
    });
    expect(refused.code).toBe(CLI_EXIT_CODES.config);
    expect(refused.stderr).toContain("AGENT_EFFORT");
    expect(refused.stderr).not.toContain("turbo-9000");
    expect(refused.stdout).toBe("");
    expectNoCredentials(refused);
  });

  it("SIGTERM stops a run in flight: exit 130 within 2 s, cancelled in the summary and the database", async () => {
    const stateDir = freshStateDir("sigterm");
    prepareWorkspace(stateDir, harness.fakes);
    const model = harness.model;
    if (model === null) throw new Error("scripted model expected");
    const asked = () =>
      model.requests.some((request) =>
        JSON.stringify(request.body ?? null).includes(MODEL_NEVER_ANSWERS.prompt),
      );
    const result = await runBuiltCli(
      ["ask", "--json", "--state-dir", stateDir, MODEL_NEVER_ANSWERS.prompt],
      { env, stop: { signal: "SIGTERM", when: () => until(asked) } },
    );
    expect(result.code, result.stderr).toBe(CLI_EXIT_CODES.cancelled);
    expect(result.afterSignalMs).not.toBeNull();
    expect(result.afterSignalMs ?? Number.POSITIVE_INFINITY).toBeLessThan(2_000);
    const summary = onlySummary(result);
    expect(summary.status).toBe("cancelled");
    const state = readState(stateDir);
    expect(state.runs).toEqual([
      expect.objectContaining({ id: summary.runId, source: "cli", status: "cancelled" }),
    ]);
    expect(state.runs[0]?.stop_reason).toBe("shutdown");
  });

  /** Runs KILLED_MID_RUN in the built CLI and kills it with SIGKILL once the model was asked. */
  async function killedCliRun(stateDir: string): Promise<{
    readonly runId: string;
    readonly conversationId: string;
    readonly pid: number;
  }> {
    const model = harness.model;
    if (model === null) throw new Error("scripted model expected");
    const before = model.requests.length;
    const asked = () =>
      model.requests
        .slice(before)
        .some((request) => JSON.stringify(request.body ?? null).includes(KILLED_MID_RUN.prompt));
    const result = await runBuiltCli(["ask", "--state-dir", stateDir, KILLED_MID_RUN.prompt], {
      env,
      stop: { signal: "SIGKILL", when: () => until(asked) },
    });
    expect(result.signal).toBe("SIGKILL");
    // Nothing ran the CLI's cleanup: its run is still `running`, owned by the dead process.
    const sqlite = new Database(databasePath(stateDir), { readonly: true });
    try {
      const rows = sqlite
        .prepare(
          "SELECT id, conversation_id, status, source, owner_pid, owner_started_at FROM runs WHERE status = 'running'",
        )
        .all() as {
        id: string;
        conversation_id: string;
        source: string;
        owner_pid: number | null;
        owner_started_at: string | null;
      }[];
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (row === undefined || row.owner_pid === null) throw new Error("no owned running run");
      expect(row.source).toBe("cli");
      expect(row.owner_started_at).not.toBeNull();
      return { runId: row.id, conversationId: row.conversation_id, pid: row.owner_pid };
    } finally {
      sqlite.close();
    }
  }

  it("a CLI killed with SIGKILL does not block its conversation: the app's next turn recovers it", async () => {
    const stateDir = freshStateDir("sigkill-app");
    prepareWorkspace(stateDir, harness.fakes);
    // The app is already running when the CLI dies, so its boot recovery plays no part.
    const app = await openApp(stateDir);
    onTestFinished(() => rmSync(stateDir, { recursive: true, force: true }));
    try {
      const killed = await killedCliRun(stateDir);
      expect(readState(stateDir).conversations).toEqual([
        expect.objectContaining({ id: killed.conversationId, source: "cli", status: "running" }),
      ]);

      await app.api.session();
      const chunks = await app.api.chat(killed.conversationId, AFTER_THE_KILL.prompt);
      const streamed = chunks
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => String(chunk.delta))
        .join("");
      expect(streamed).toContain("Picked up after the command line stopped.");

      const state = readState(stateDir);
      expect(state.runs.map((run) => [run.id === killed.runId, run.source, run.status])).toEqual([
        [true, "cli", "failed"],
        [false, "ui", "completed"],
      ]);
      expect(state.runs[0]?.error_code).toBe("server_restart");
      expect(state.conversations).toEqual([
        expect.objectContaining({ id: killed.conversationId, status: "idle" }),
      ]);
      const runs = await app.api.expect("GET /api/runs", {
        query: { conversationId: killed.conversationId },
      });
      expect(runs.items.find((item) => item.id === killed.runId)?.error).toEqual({
        code: "server_restart",
        message: "The command-line process running this run exited before it finished.",
      });
      expect(harness.script?.problems ?? []).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("a CLI killed with SIGKILL does not block its conversation: the next CLI invocation recovers it", async () => {
    const stateDir = freshStateDir("sigkill-cli");
    onTestFinished(() => rmSync(stateDir, { recursive: true, force: true }));
    prepareWorkspace(stateDir, harness.fakes);
    const killed = await killedCliRun(stateDir);
    const result = await runBuiltCli(
      [
        "ask",
        "--json",
        "--state-dir",
        stateDir,
        "--conversation",
        killed.conversationId,
        AFTER_THE_KILL.prompt,
      ],
      { env },
    );
    expect(result.code, result.stderr).toBe(CLI_EXIT_CODES.completed);
    expect(result.stderr).toContain("recovered 1 earlier run(s) whose process had exited");
    const summary = onlySummary(result);
    expect(summary.reply).toContain("Picked up after the command line stopped.");
    const state = readState(stateDir);
    expect(state.runs.map((run) => [run.id, run.status, run.error_code])).toEqual([
      [killed.runId, "failed", "server_restart"],
      [summary.runId, "completed", null],
    ]);
  });

  it("runs four at once with isolated state directories", async () => {
    const stateDirs = [1, 2, 3, 4].map((index) => freshStateDir(`parallel-${index}`));
    for (const stateDir of stateDirs) prepareWorkspace(stateDir, harness.fakes);
    const results = await Promise.all(
      stateDirs.map((stateDir) =>
        runBuiltCli(["ask", "--json", "--state-dir", stateDir, J5_WEEKLY_DIGEST.prompt], { env }),
      ),
    );
    const summaries = results.map((result) => {
      expect(result.code, result.stderr).toBe(CLI_EXIT_CODES.completed);
      expectNoCredentials(result);
      return onlySummary(result);
    });
    expect(new Set(summaries.map((summary) => summary.runId)).size).toBe(4);
    for (const [index, stateDir] of stateDirs.entries()) {
      const state = readState(stateDir);
      // Each directory holds its own run only.
      expect(state.runs.map((run) => [run.id, run.source, run.status])).toEqual([
        [summaries[index]?.runId, "cli", "completed"],
      ]);
      expect(summaries[index]?.reply).toContain(J5_NOT_POSTED);
    }
  });

  it("runs as an executable through its shebang", async () => {
    const mode = statSync(BUILT_CLI).mode;
    expect(mode & 0o111).not.toBe(0);
    const result = await runBuiltCli(["--version"], { env, asExecutable: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\S*\n$/);
  });
});
