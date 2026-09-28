/**
 * `revenue-desk` in process: argument handling, configuration, the run
 * input, output, persistence, exit codes and stopping, against the fake
 * services (support/fake-services.ts). process.test.ts covers the same
 * behaviour through a real process.
 */
import { describe, expect, it } from "vitest";
import { type CliContext, runCli } from "../../../src/cli/cli.js";
import type { CliIo } from "../../../src/cli/io.js";
import type { EnvironmentRecord } from "../../../src/cli/ports.js";
import type { OutputStream } from "../../../src/cli/stdout-guard.js";
import type { CliSignal } from "../../../src/cli/stop.js";
import type { RunSummary } from "../../../src/contracts/cli.js";
import type { AgentEvent } from "../../../src/contracts/events.js";
import { HEADLESS_ASK_DENIAL } from "../../../src/contracts/integration.js";
import {
  BUSY_CONVERSATION,
  createFakeServices,
  EXISTING_CONVERSATION,
  type FakeOptions,
  REPLY_TEXT,
  TOOLS_REPLY,
} from "./support/fake-services.js";

const API_KEY = "sk-ant-test-key-0123456789abcdef";
const NOW = new Date("2026-09-28T02:30:00.000Z");
const GRACE_MS = 150;

type Harness = {
  readonly fake: ReturnType<typeof createFakeServices>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly signal: (signal: CliSignal) => void;
  readonly listeners: () => number;
  readonly run: (argv: readonly string[]) => Promise<number>;
};

function harness(
  options: Partial<FakeOptions> & {
    readonly environment?: EnvironmentRecord;
    readonly stdin?: string;
  } = {},
): Harness {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const listeners = new Set<(signal: CliSignal) => void>();
  const fake = createFakeServices({ scenario: "reply", ...options });
  const io: CliIo = {
    stdout,
    stderr,
    readStdin: async () => options.stdin ?? "",
    environment: options.environment ?? { ANTHROPIC_API_KEY: API_KEY },
    cwd: "/work",
    onSignal(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let nextId = 0;
  const context: CliContext = {
    io,
    version: "9.9.9-test",
    loadServices: fake.loadServices,
    stopGraceMs: GRACE_MS,
    cleanupMs: 20,
    now: () => NOW,
    newId: () => `id-${++nextId}`,
  };
  return {
    fake,
    stdout: stdout.text,
    stderr: stderr.text,
    signal: (signal) => {
      for (const listener of listeners) listener(signal);
    },
    listeners: () => listeners.size,
    run: (argv) => runCli(argv, context),
  };
}

function memoryStream(): OutputStream & { readonly text: () => string } {
  let text = "";
  return {
    isTTY: false,
    write(chunk) {
      text += chunk;
    },
    flush: async () => undefined,
    text: () => text,
  };
}

function summaryOf(stdout: string): RunSummary {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trimEnd().includes("\n")).toBe(false);
  return JSON.parse(stdout) as RunSummary;
}

function types(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Resolves once a waiting scenario is ready for a signal. */
function waiting(): { onWaiting: () => void; ready: Promise<void> } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { onWaiting: resolve, ready: promise };
}

describe("revenue-desk help and version", () => {
  it("prints help on stdout and exits 0", async () => {
    const h = harness();
    expect(await h.run(["--help"])).toBe(0);
    expect(h.stdout()).toMatch(/^Usage: revenue-desk ask \[options\] <prompt>/);
    expect(h.stderr()).toBe("");
  });

  it("prints the version", async () => {
    const h = harness();
    expect(await h.run(["--version"])).toBe(0);
    expect(h.stdout()).toBe("9.9.9-test\n");
  });

  it("reports a usage error on stderr with exit 2 and runs nothing", async () => {
    const h = harness();
    expect(await h.run(["ask", "--json", "--effort", "extreme", "x"])).toBe(2);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe(
      "revenue-desk: --effort must be one of low, medium, high, xhigh, max.\n" +
        "Run 'revenue-desk --help' for usage.\n",
    );
    expect(h.fake.state.workspaceOpened).toBe(false);
  });
});

describe("revenue-desk ask: a completed run", () => {
  it("streams the reply to stdout and the status to stderr", async () => {
    const h = harness();
    expect(await h.run(["ask", "Why was Kestrel charged twice?"])).toBe(0);
    expect(h.stdout()).toBe(`${REPLY_TEXT}\n`);
    expect(h.stderr()).toContain("Done in 2.4 s · 0 tool calls · $0.0123\n");
    expect(h.stderr()).not.toContain(REPLY_TEXT);
  });

  it("runs one headless CLI turn in a new conversation with the effective settings", async () => {
    const h = harness();
    await h.run(["ask", "  Why was Kestrel charged twice?\nIt was in September.  "]);
    expect(h.fake.created).toEqual([
      { id: "id-2", title: "Why was Kestrel charged twice?", createdAt: NOW.toISOString() },
    ]);
    expect(h.fake.inputs).toHaveLength(1);
    const [input] = h.fake.inputs;
    expect(input).toMatchObject({
      mode: "headless",
      source: "cli",
      runId: "id-1",
      conversationId: "id-2",
      prompt: "Why was Kestrel charged twice?\nIt was in September.",
      resumeSessionId: null,
      model: {
        model: "claude-sonnet-5",
        effort: "medium",
        thinkingDisplay: "omitted",
        maxTurns: 30,
        maxBudgetUsd: 2,
      },
      policy: {
        read: "auto",
        internal_write: "auto",
        outbound: "ask",
        financial: "ask",
        destructive: "deny",
      },
      // 02:30 UTC is still the 27th in the workspace's New York time zone.
      businessDate: "2026-09-27",
    });
    expect(input?.connections).toHaveLength(6);
    expect(input && "approvals" in input).toBe(false);
    expect(h.fake.planRequests[0]?.policy).toEqual(input?.policy);
  });

  it("records every event in order, ending with run.finished, and closes the database", async () => {
    const h = harness({ scenario: "tools" });
    await h.run(["ask", "Refund the duplicate"]);
    const recorded = types(h.fake.recorded);
    expect(recorded[0]).toBe("run.started");
    expect(recorded.at(-1)).toBe("run.finished");
    expect(recorded.filter((type) => type === "run.finished")).toHaveLength(1);
    expect(recorded).toContain("tool.denied");
    expect(h.fake.state.workspaceClosed).toBe(true);
  });

  it("prints exactly one RunSummary with --json", async () => {
    const h = harness({ scenario: "tools" });
    expect(await h.run(["ask", "--json", "Refund the duplicate"])).toBe(0);
    const summary = summaryOf(h.stdout());
    expect(summary).toMatchObject({
      kind: "revenue-desk.run-summary",
      version: 1,
      runId: "id-1",
      conversationId: "id-2",
      mode: "headless",
      status: "completed",
      reply: TOOLS_REPLY,
      error: null,
    });
    expect(summary.toolCalls).toEqual([
      {
        toolCallId: "toolu_charges",
        integration: "stripe",
        connectionKind: "api",
        tool: "mcp__stripe__list_charges",
        operation: "stripe.charges.list",
        actionClass: "read",
        decision: "auto",
        isError: false,
        durationMs: 120,
      },
      {
        toolCallId: "toolu_refund",
        integration: "stripe",
        connectionKind: "api",
        tool: "mcp__stripe__create_refund",
        operation: "stripe.refunds.create",
        actionClass: "financial",
        decision: "policy_denied",
        isError: false,
        durationMs: null,
      },
    ]);
    expect(h.stderr()).toContain(`blocked by policy: ${HEADLESS_ASK_DENIAL}`);
    expect(h.stderr()).toContain(`pass --policy '{"financial":"auto"}'`);
  });

  it("denies ask-mode actions in headless mode unless --policy makes them auto", async () => {
    const h = harness({ scenario: "tools" });
    await h.run(["ask", "--json", "--policy", '{"financial":"auto"}', "Refund the duplicate"]);
    expect(h.fake.inputs[0]?.policy.financial).toBe("auto");
    expect(summaryOf(h.stdout()).toolCalls[1]?.decision).toBe("auto");
    expect(h.stderr()).not.toContain("need approval");
  });

  it("layers the saved policy, AGENT_POLICY and --policy", async () => {
    const h = harness({
      savedPolicy: { outbound: "auto", financial: "deny" },
      environment: {
        ANTHROPIC_API_KEY: API_KEY,
        AGENT_POLICY: '{"financial":"ask","destructive":"ask"}',
      },
    });
    await h.run(["ask", "--policy", '{"destructive":"deny"}', "x"]);
    expect(h.fake.inputs[0]?.policy).toEqual({
      read: "auto",
      internal_write: "auto",
      outbound: "auto",
      financial: "ask",
      destructive: "deny",
    });
  });

  it("applies model flags over Settings and Settings over the environment", async () => {
    const settings = { defaultModel: "claude-settings", defaultEffort: "high" } as const;
    const fromSettings = harness({
      settings,
      environment: { ANTHROPIC_API_KEY: API_KEY, AGENT_MODEL: "claude-env" },
    });
    await fromSettings.run(["ask", "x"]);
    expect(fromSettings.fake.inputs[0]?.model).toMatchObject({
      model: "claude-settings",
      effort: "high",
    });

    const fromFlags = harness({ settings });
    await fromFlags.run([
      "ask",
      "--model",
      "claude-flag",
      "--effort",
      "low",
      "--max-turns",
      "4",
      "--max-budget-usd",
      "0.5",
      "x",
    ]);
    expect(fromFlags.fake.inputs[0]?.model).toEqual({
      model: "claude-flag",
      effort: "low",
      thinkingDisplay: "omitted",
      maxTurns: 4,
      maxBudgetUsd: 0.5,
    });
  });

  it("uses AGENT_BUSINESS_DATE when it is set", async () => {
    const h = harness({
      environment: { ANTHROPIC_API_KEY: API_KEY, AGENT_BUSINESS_DATE: "2026-10-01" },
    });
    await h.run(["ask", "x"]);
    expect(h.fake.inputs[0]?.businessDate).toBe("2026-10-01");
  });

  it("falls back to UTC for an unknown Settings time zone and says so", async () => {
    const h = harness({ settings: { timezone: "Mars/Olympus" } });
    await h.run(["ask", "x"]);
    expect(h.fake.inputs[0]?.businessDate).toBe("2026-09-28");
    expect(h.stderr()).toContain('The Settings time zone "Mars/Olympus" is not valid');
  });

  it("uses --state-dir as the state directory", async () => {
    const h = harness();
    await h.run(["ask", "--state-dir", "isolated", "x"]);
    expect(h.fake.inputs[0]?.env.runtime.stateDir).toBe("/work/isolated");
  });

  it("reads the prompt from stdin for '-'", async () => {
    const h = harness({ stdin: "Why was Kestrel charged twice?\n" });
    expect(await h.run(["ask", "-"])).toBe(0);
    expect(h.fake.inputs[0]?.prompt).toBe("Why was Kestrel charged twice?");
  });

  it("refuses an empty stdin prompt as a usage error", async () => {
    const h = harness({ stdin: " \n" });
    expect(await h.run(["ask", "--json", "-"])).toBe(2);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe("revenue-desk: The prompt is empty.\n");
  });
});

describe("revenue-desk ask --conversation", () => {
  it("continues the conversation and resumes its SDK session", async () => {
    const h = harness();
    expect(
      await h.run(["ask", "--conversation", EXISTING_CONVERSATION.id, "And the refund?"]),
    ).toBe(0);
    expect(h.fake.created).toEqual([]);
    expect(h.fake.inputs[0]).toMatchObject({
      conversationId: EXISTING_CONVERSATION.id,
      resumeSessionId: EXISTING_CONVERSATION.sdkSessionId,
    });
  });

  it("refuses an unknown conversation with exit 2", async () => {
    const h = harness();
    expect(await h.run(["ask", "--json", "--conversation", "conv-missing", "x"])).toBe(2);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe("revenue-desk: No conversation conv-missing in /work/data.\n");
    expect(h.fake.inputs).toEqual([]);
  });

  it("refuses a conversation that already has an active run", async () => {
    const h = harness();
    expect(await h.run(["ask", "--conversation", BUSY_CONVERSATION.id, "x"])).toBe(2);
    expect(h.stderr()).toContain("already has an active run");
    expect(h.fake.inputs).toEqual([]);
  });
});

describe("revenue-desk ask: configuration", () => {
  it("exits 3 without ANTHROPIC_API_KEY, before opening the database", async () => {
    const h = harness({ environment: {} });
    expect(await h.run(["ask", "--json", "x"])).toBe(3);
    expect(h.fake.state.workspaceOpened).toBe(false);
    expect(h.stderr()).toBe(
      "revenue-desk: ANTHROPIC_API_KEY is not set. Set it in the environment or in the file named by DOTENV_PATH.\n",
    );
    expect(summaryOf(h.stdout())).toMatchObject({
      status: "failed",
      runId: "id-1",
      conversationId: "id-2",
      model: "claude-sonnet-5",
      effort: "medium",
      error: { code: "config_missing" },
      toolCalls: [],
    });
  });

  it("exits 3 for refused values and names the variables", async () => {
    const h = harness({ environment: { ANTHROPIC_API_KEY: API_KEY, AGENT_EFFORT: "extreme" } });
    expect(await h.run(["ask", "x"])).toBe(3);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toContain("Invalid configuration. AGENT_EFFORT: must be");
  });

  it("exits 3 when DOTENV_PATH cannot be read", async () => {
    const h = harness({ environment: { DOTENV_PATH: "/nowhere/revenue-desk.env" } });
    expect(await h.run(["ask", "x"])).toBe(3);
    expect(h.stderr()).toContain(
      "DOTENV_PATH names /nowhere/revenue-desk.env, which could not be read",
    );
  });

  it("exits 1 when the agent runtime cannot be loaded", async () => {
    const h = harness({ failLoad: true });
    expect(await h.run(["ask", "--json", "x"])).toBe(1);
    expect(summaryOf(h.stdout()).error).toEqual({
      code: "internal",
      message: "Could not load the agent runtime: Cannot find module '../agent/run-turn.js'",
    });
  });
});

describe("revenue-desk ask: failures", () => {
  it.each([
    ["model-error", "model_error"],
    ["max-turns", "max_turns"],
  ] as const)("%s exits 1 with the core's error", async (scenario, code) => {
    const h = harness({ scenario });
    expect(await h.run(["ask", "--json", "x"])).toBe(1);
    expect(summaryOf(h.stdout())).toMatchObject({ status: "failed", error: { code } });
  });

  it("turns a thrown core error into a failed run, redacted, and records the end", async () => {
    const h = harness({ scenario: "throw" });
    expect(await h.run(["ask", "--json", "x"])).toBe(1);
    const summary = summaryOf(h.stdout());
    expect(summary.error).toEqual({
      code: "internal",
      message: "The agent failed: upstream rejected key [redacted]",
    });
    expect(h.stdout() + h.stderr()).not.toContain(API_KEY);
    const recorded = types(h.fake.recorded);
    expect(recorded[0]).toBe("run.started");
    expect(recorded.at(-1)).toBe("run.finished");
    expect(h.fake.recorded.at(-1)).toMatchObject({ status: "failed", error: { code: "internal" } });
  });

  it("fails a run the core ends without run.finished", async () => {
    const h = harness({ scenario: "no-finish" });
    expect(await h.run(["ask", "x"])).toBe(1);
    expect(h.stderr()).toContain("Failed (internal): The agent ended without a result.");
    expect(h.fake.recorded.at(-1)).toMatchObject({ type: "run.finished", status: "failed" });
  });

  it("fails the run and stops the core when recording fails", async () => {
    const h = harness({ scenario: "reply", failRecordingAt: "text.delta" });
    expect(await h.run(["ask", "--json", "x"])).toBe(1);
    expect(summaryOf(h.stdout()).error).toEqual({
      code: "internal",
      message: "Could not record the run: disk I/O error",
    });
    expect(h.fake.inputs[0]?.signal.aborted).toBe(true);
  });

  it("fails when the connections cannot be checked", async () => {
    const h = harness({ failPlan: "Composio is unreachable" });
    expect(await h.run(["ask", "x"])).toBe(1);
    expect(h.stderr()).toContain("Could not check the connections: Composio is unreachable");
    expect(h.fake.inputs).toEqual([]);
  });
});

describe("revenue-desk ask: stopping", () => {
  it.each([
    ["SIGINT", "user"],
    ["SIGTERM", "shutdown"],
  ] as const)("%s interrupts the run, which ends cancelled (130)", async (signal, reason) => {
    const { onWaiting, ready } = waiting();
    const h = harness({ scenario: "wait-for-stop", onWaiting });
    const exit = h.run(["ask", "--json", "x"]);
    await ready;
    h.signal(signal);
    expect(await exit).toBe(130);
    expect(h.fake.inputs[0]?.signal.reason).toBe(reason);
    expect(summaryOf(h.stdout())).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled", message: "The run was stopped." },
    });
    expect(h.fake.recorded.at(-1)).toMatchObject({ type: "run.finished", status: "cancelled" });
    expect(h.listeners()).toBe(0);
  });

  it("finishes the run itself when the core does not stop within the grace period", async () => {
    const { onWaiting, ready } = waiting();
    const h = harness({ scenario: "ignore-stop", onWaiting });
    const exit = h.run(["ask", "--json", "x"]);
    await ready;
    const stoppedAt = performance.now();
    h.signal("SIGTERM");
    expect(await exit).toBe(130);
    const elapsed = performance.now() - stoppedAt;
    expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS - 5);
    expect(elapsed).toBeLessThan(GRACE_MS + 500);
    expect(summaryOf(h.stdout()).error).toEqual({
      code: "cancelled",
      message: "Stopped by SIGTERM; the agent did not confirm the stop in time.",
    });
    expect(h.fake.recorded.at(-1)).toMatchObject({ type: "run.finished", status: "cancelled" });
  });

  it("a second signal ends the wait at once", async () => {
    const { onWaiting, ready } = waiting();
    const h = harness({ scenario: "ignore-stop", onWaiting });
    const exit = h.run(["ask", "x"]);
    await ready;
    const stoppedAt = performance.now();
    h.signal("SIGINT");
    h.signal("SIGINT");
    expect(await exit).toBe(130);
    expect(performance.now() - stoppedAt).toBeLessThan(GRACE_MS);
  });

  it("--timeout-ms ends the run timed_out (124)", async () => {
    const h = harness({ scenario: "wait-for-stop" });
    expect(await h.run(["ask", "--json", "--timeout-ms", "50", "x"])).toBe(124);
    expect(h.fake.inputs[0]?.signal.reason).toBe("timeout");
    expect(summaryOf(h.stdout())).toMatchObject({
      status: "timed_out",
      error: { code: "timeout" },
    });
  });

  it("a stop before the run starts ends it without starting the run", async () => {
    const h = harness({ planWaitsForStop: true });
    expect(await h.run(["ask", "--json", "--timeout-ms", "30", "x"])).toBe(124);
    expect(h.fake.inputs).toEqual([]);
    expect(h.fake.created).toEqual([]);
    expect(summaryOf(h.stdout())).toMatchObject({
      status: "timed_out",
      error: {
        code: "timeout",
        message: "Stopped by the 30 ms time limit before the run started.",
      },
    });
  });
});
