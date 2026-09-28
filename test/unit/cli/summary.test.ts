import { describe, expect, it } from "vitest";
import { exitCodeFor, RunSummaryBuilder, type SummarySeed } from "../../../src/cli/summary.js";
import type { AgentEvent, RunConnection, ToolMetadata } from "../../../src/contracts/events.js";

const SEED: SummarySeed = {
  runId: "run-planned",
  conversationId: "conv-planned",
  model: "claude-sonnet-5",
  effort: "medium",
  startedAt: "2026-09-28T15:00:00.000Z",
  connections: [],
};

const STRIPE: RunConnection = {
  integration: "stripe",
  kind: "api",
  profile: "stripe-api",
  availability: "ready",
  state: "connected",
  detail: null,
  endpointLabel: "api.stripe.com",
};

const read: ToolMetadata = {
  integration: "stripe",
  connectionKind: "api",
  operation: "stripe.charges.list",
  actionClass: "read",
};
const post: ToolMetadata = {
  integration: "slack",
  connectionKind: "api",
  operation: "slack.chat.post_message",
  actionClass: "outbound",
};
const allowlistedPost: ToolMetadata = { ...post, actionClass: "internal_write" };

function inputs(toolCallId: string, toolName: string, tool: ToolMetadata | null): AgentEvent[] {
  return [
    { type: "tool.input.start", toolCallId, toolName, title: toolName, tool },
    { type: "tool.input.available", toolCallId, toolName, title: toolName, input: {}, tool },
  ];
}

function output(toolCallId: string, isError = false): AgentEvent {
  return {
    type: "tool.output",
    toolCallId,
    output: {},
    truncated: false,
    isError,
    error: isError
      ? { provider: "stripe", status: 402, code: "card_declined", message: "declined" }
      : null,
    durationMs: 80,
    execution: null,
  };
}

const finished: AgentEvent = {
  type: "run.finished",
  status: "completed",
  finishedAt: "2026-09-28T15:00:05.000Z",
  stopReason: "end_turn",
  terminalReason: "completed",
  reply: "Done.",
  error: null,
};

function build(events: readonly AgentEvent[]) {
  const builder = new RunSummaryBuilder(SEED);
  for (const event of events) builder.apply(event);
  return builder.build();
}

describe("RunSummaryBuilder", () => {
  it("takes identity, model and connections from run.started and the outcome from run.finished", () => {
    const summary = build([
      {
        type: "run.started",
        runId: "run-1",
        conversationId: "conv-1",
        source: "cli",
        mode: "headless",
        model: "claude-opus-5",
        effort: "high",
        startedAt: "2026-09-28T15:00:00.100Z",
        connections: [STRIPE],
      },
      {
        type: "usage",
        costUsd: 0.02,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheCreationTokens: 2,
        numTurns: 1,
        modelRequests: 1,
        durationMs: 900,
        durationApiMs: 800,
      },
      finished,
    ]);
    expect(summary).toEqual({
      kind: "revenue-desk.run-summary",
      version: 1,
      runId: "run-1",
      conversationId: "conv-1",
      mode: "headless",
      status: "completed",
      reply: "Done.",
      model: "claude-opus-5",
      effort: "high",
      startedAt: "2026-09-28T15:00:00.100Z",
      finishedAt: "2026-09-28T15:00:05.000Z",
      usage: {
        costUsd: 0.02,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheCreationTokens: 2,
        numTurns: 1,
        modelRequests: 1,
        durationMs: 900,
        durationApiMs: 800,
      },
      stopReason: "end_turn",
      terminalReason: "completed",
      error: null,
      connections: [STRIPE],
      toolCalls: [],
    });
  });

  it("keeps the seed when the core never reported run.started", () => {
    const summary = build([
      { ...finished, status: "failed", reply: null, error: { code: "internal", message: "boom" } },
    ]);
    expect(summary).toMatchObject({
      runId: "run-planned",
      conversationId: "conv-planned",
      usage: null,
    });
  });

  it("records each tool call once, in order, with its decision", () => {
    const summary = build([
      ...inputs("t-read", "mcp__stripe__list_charges", read),
      ...inputs("t-approved", "mcp__slack__post_message", post),
      ...inputs("t-denied", "mcp__slack__post_message", post),
      ...inputs("t-policy", "mcp__stripe__create_refund", read),
      ...inputs("t-unknown", "mcp__stripe__drop_tables", null),
      ...inputs("t-inflight", "mcp__stripe__list_charges", read),
      output("t-read"),
      {
        type: "approval.requested",
        approvalId: "a-1",
        toolCallId: "t-approved",
        descriptor: {
          actionClass: "outbound",
          integration: "slack",
          connectionKind: "api",
          operation: "slack.chat.post_message",
          title: "Post",
          consequence: "Post to #general",
          facts: [],
          expiresAt: "2026-09-28T15:15:00.000Z",
        },
      },
      {
        type: "approval.resolved",
        approvalId: "a-1",
        toolCallId: "t-approved",
        approved: true,
        decidedBy: "user",
        reason: null,
      },
      output("t-approved", true),
      {
        type: "approval.resolved",
        approvalId: "a-2",
        toolCallId: "t-denied",
        approved: false,
        decidedBy: "user",
        reason: "no",
      },
      { type: "tool.denied", toolCallId: "t-denied", decision: "denied", reason: "no" },
      {
        type: "tool.denied",
        toolCallId: "t-policy",
        decision: "policy_denied",
        reason: "Requires human approval",
      },
      {
        type: "tool.denied",
        toolCallId: "t-unknown",
        decision: "rejected",
        reason: "Unknown tool",
      },
      finished,
    ]);
    expect(
      summary.toolCalls.map((call) => [
        call.toolCallId,
        call.decision,
        call.isError,
        call.durationMs,
      ]),
    ).toEqual([
      ["t-read", "auto", false, 80],
      ["t-approved", "approved", true, 80],
      ["t-denied", "denied", false, null],
      ["t-policy", "policy_denied", false, null],
      ["t-unknown", "rejected", false, null],
      ["t-inflight", "pending", false, null],
    ]);
    expect(summary.toolCalls[4]).toEqual({
      toolCallId: "t-unknown",
      integration: null,
      connectionKind: null,
      tool: "mcp__stripe__drop_tables",
      operation: null,
      actionClass: null,
      decision: "rejected",
      isError: false,
      durationMs: null,
    });
  });

  it("reports the classification of the complete input over the base class", () => {
    const summary = build([
      {
        type: "tool.input.start",
        toolCallId: "t",
        toolName: "mcp__slack__post_message",
        title: "Post",
        tool: post,
      },
      {
        type: "tool.input.available",
        toolCallId: "t",
        toolName: "mcp__slack__post_message",
        title: "Post",
        input: {},
        tool: allowlistedPost,
      },
      output("t"),
      finished,
    ]);
    expect(summary.toolCalls[0]).toMatchObject({ actionClass: "internal_write", decision: "auto" });
  });

  it("keeps the base class when the input could not be classified", () => {
    const summary = build([
      {
        type: "tool.input.start",
        toolCallId: "t",
        toolName: "mcp__slack__post_message",
        title: "Post",
        tool: post,
      },
      {
        type: "tool.input.available",
        toolCallId: "t",
        toolName: "mcp__slack__post_message",
        title: "Post",
        input: {},
        tool: null,
      },
      { type: "tool.denied", toolCallId: "t", decision: "policy_denied", reason: "unclassifiable" },
      finished,
    ]);
    expect(summary.toolCalls[0]).toMatchObject({ integration: "slack", actionClass: "outbound" });
  });

  it("keeps the first run.finished", () => {
    const summary = build([finished, { ...finished, status: "failed", reply: null }]);
    expect(summary.status).toBe("completed");
  });

  it("refuses to build before run.finished", () => {
    expect(() => new RunSummaryBuilder(SEED).build()).toThrow(/before run.finished/);
  });
});

describe("exitCodeFor", () => {
  it.each([
    [{ status: "completed", error: null }, 0],
    [{ status: "failed", error: { code: "model_error", message: "" } }, 1],
    [{ status: "failed", error: { code: "max_turns", message: "" } }, 1],
    [{ status: "failed", error: { code: "config_missing", message: "" } }, 3],
    [{ status: "timed_out", error: { code: "timeout", message: "" } }, 124],
    [{ status: "cancelled", error: { code: "cancelled", message: "" } }, 130],
  ] as const)("%j -> %i", (finished, code) => {
    expect(exitCodeFor(finished)).toBe(code);
  });
});
