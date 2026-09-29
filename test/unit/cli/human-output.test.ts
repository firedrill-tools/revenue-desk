import { describe, expect, it } from "vitest";
import { formatDuration, ProgressPrinter } from "../../../src/cli/human-output.js";
import type { OutputStream } from "../../../src/cli/stdout-guard.js";
import type { RunSummary } from "../../../src/contracts/cli.js";
import type { AgentEvent, ToolMetadata } from "../../../src/contracts/events.js";
import { HEADLESS_ASK_DENIAL } from "../../../src/contracts/integration.js";

function stream(isTTY = false): OutputStream & { text: () => string } {
  let text = "";
  return {
    isTTY,
    write: (chunk) => {
      text += chunk;
    },
    flush: async () => undefined,
    text: () => text,
  };
}

function printer(options: { streamReply?: boolean; tty?: boolean } = {}) {
  const stdout = stream(options.tty);
  const stderr = stream(options.tty);
  const progress = new ProgressPrinter({
    stdout,
    stderr,
    redact: (text) => text.replaceAll("sk_test_leak123456", "[redacted]"),
    streamReply: options.streamReply ?? true,
  });
  return { progress, stdout, stderr };
}

const SUMMARY: RunSummary = {
  kind: "revenue-desk.run-summary",
  version: 1,
  runId: "run-1",
  conversationId: "conv-1",
  mode: "headless",
  status: "completed",
  reply: "Final answer.",
  model: "claude-sonnet-5",
  effort: "medium",
  startedAt: "2026-09-28T15:00:00.000Z",
  finishedAt: "2026-09-28T15:00:03.250Z",
  usage: null,
  stopReason: "end_turn",
  terminalReason: "completed",
  error: null,
  connections: [],
  toolCalls: [],
};

const refund: ToolMetadata = {
  integration: "stripe",
  connectionKind: "api",
  operation: "stripe.refunds.create",
  actionClass: "financial",
};

function text(id: string, ...deltas: string[]): AgentEvent[] {
  return [
    { type: "text.start", id },
    ...deltas.map((delta): AgentEvent => ({ type: "text.delta", id, delta })),
    { type: "text.end", id },
  ];
}

describe("ProgressPrinter", () => {
  it("streams text blocks to stdout, separated by a blank line and ending with a newline", () => {
    const { progress, stdout, stderr } = printer();
    for (const event of [...text("a", "Checking ", "Stripe."), ...text("b", "Final answer.")]) {
      progress.handle(event);
    }
    progress.finish(SUMMARY);
    expect(stdout.text()).toBe("Checking Stripe.\n\nFinal answer.\n");
    expect(stderr.text()).toBe("Done in 3.3 s · 0 tool calls\n");
  });

  it("prints the reply at the end when no text streamed", () => {
    const { progress, stdout } = printer();
    progress.finish(SUMMARY);
    expect(stdout.text()).toBe("Final answer.\n");
  });

  it("writes nothing to stdout when the reply belongs to the --json summary", () => {
    const { progress, stdout, stderr } = printer({ streamReply: false });
    for (const event of text("a", "Hello")) progress.handle(event);
    progress.finish({ ...SUMMARY, usage: { ...usage(), costUsd: 0.5 } });
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("Done in 2.0 s · 0 tool calls · $0.5000\n");
  });

  it("lists unavailable connections on one line", () => {
    const { progress, stderr } = printer();
    progress.handle({
      type: "run.started",
      runId: "r",
      conversationId: "c",
      source: "cli",
      mode: "headless",
      model: "m",
      effort: "medium",
      startedAt: SUMMARY.startedAt,
      connections: [
        {
          integration: "stripe",
          kind: "api",
          profile: "stripe-api",
          availability: "ready",
          state: "connected",
          detail: null,
          endpointLabel: "api.stripe.com",
        },
        {
          integration: "google_calendar",
          kind: "composio",
          profile: "composio",
          availability: "unavailable",
          state: "needs_auth",
          detail: "Reconnect it.",
          endpointLabel: null,
        },
        {
          integration: "slack",
          kind: "composio",
          profile: "composio",
          availability: "unavailable",
          state: "not_configured",
          detail: "Set COMPOSIO_API_KEY.",
          endpointLabel: null,
        },
      ],
    });
    expect(stderr.text()).toBe(
      "Not available this run: Google Calendar (needs sign-in), Slack (not configured)\n",
    );
  });

  it("shows tool activity, redacted, and suggests --policy for calls that needed approval", () => {
    const { progress, stderr } = printer();
    const events: AgentEvent[] = [
      {
        type: "tool.input.available",
        toolCallId: "t1",
        toolName: "mcp__stripe__list_charges",
        title: "List charges in Stripe",
        input: {},
        tool: { ...refund, operation: "stripe.charges.list", actionClass: "read" },
      },
      {
        type: "tool.input.available",
        toolCallId: "t2",
        toolName: "mcp__stripe__create_refund",
        title: "Refund $49.00 to Contoso",
        input: {},
        tool: refund,
      },
      {
        type: "tool.input.available",
        toolCallId: "t3",
        toolName: "mcp__stripe__get_balance",
        title: "Read balance",
        input: {},
        tool: null,
      },
      {
        type: "tool.output",
        toolCallId: "t1",
        output: {},
        truncated: false,
        isError: false,
        error: null,
        durationMs: 1_250,
        execution: null,
      },
      {
        type: "tool.output",
        toolCallId: "t3",
        output: {},
        truncated: false,
        isError: true,
        error: {
          provider: "stripe",
          status: 401,
          code: null,
          message: "Invalid key sk_test_leak123456",
        },
        durationMs: 40,
        execution: null,
      },
      {
        type: "tool.denied",
        toolCallId: "t2",
        decision: "policy_denied",
        reason: HEADLESS_ASK_DENIAL,
      },
      {
        type: "status",
        status: {
          phase: "retrying",
          attempt: 2,
          maxAttempts: 10,
          retryInMs: 3_000,
          errorStatus: 529,
        },
      },
    ];
    for (const event of events) progress.handle(event);
    progress.finish({ ...SUMMARY, reply: null });
    expect(stderr.text().split("\n")).toEqual([
      "> List charges in Stripe [API]",
      "> Refund $49.00 to Contoso [API]",
      "> Read balance",
      "  List charges in Stripe: done in 1.3 s",
      "  Read balance: failed: Invalid key [redacted]",
      `  Refund $49.00 to Contoso: blocked by policy: ${HEADLESS_ASK_DENIAL}`,
      "Model busy (HTTP 529), retrying 2/10 in 3.0 s",
      "Done in 3.3 s · 0 tool calls",
      "Not run because they need approval, which the CLI cannot ask for: Refund $49.00 to Contoso. " +
        `To allow financial actions for one run, pass --policy '{"financial":"auto"}'.`,
      "",
    ]);
  });

  it("names failed, cancelled and timed-out outcomes", () => {
    for (const [summary, line] of [
      [
        { ...SUMMARY, status: "failed", error: { code: "model_error", message: "overloaded" } },
        "Failed (model_error): overloaded",
      ],
      [
        {
          ...SUMMARY,
          status: "cancelled",
          error: { code: "cancelled", message: "Stopped by SIGINT." },
        },
        "Cancelled: Stopped by SIGINT.",
      ],
      [
        { ...SUMMARY, status: "timed_out", error: null },
        "Timed out: the run reached its time limit",
      ],
    ] as const) {
      const { progress, stderr } = printer({ streamReply: false });
      progress.finish(summary);
      expect(stderr.text()).toBe(`${line}\n`);
    }
  });

  it("starts stderr lines on a fresh line when both streams share a terminal", () => {
    const { progress, stdout, stderr } = printer({ tty: true });
    progress.handle({ type: "text.start", id: "a" });
    progress.handle({ type: "text.delta", id: "a", delta: "Looking" });
    progress.handle({
      type: "tool.input.available",
      toolCallId: "t",
      toolName: "x",
      title: "Read",
      input: {},
      tool: null,
    });
    progress.handle({ type: "text.delta", id: "a", delta: " done." });
    progress.finish(SUMMARY);
    expect(stdout.text()).toBe("Looking done.\n");
    expect(stderr.text().startsWith("\n> Read\n")).toBe(true);
  });

  it("prints reasoning on stderr only", () => {
    const { progress, stdout, stderr } = printer();
    progress.handle({ type: "reasoning.start", id: "r" });
    progress.handle({ type: "reasoning.delta", id: "r", delta: "Check the ledger first." });
    progress.handle({ type: "reasoning.end", id: "r" });
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("Thinking: Check the ledger first.\n");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [999, "999 ms"],
    [1_000, "1.0 s"],
    [61_500, "61.5 s"],
  ])("%i ms -> %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

function usage() {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    numTurns: 1,
    modelRequests: 1,
    durationMs: 2_000,
    durationApiMs: 1_500,
  };
}
