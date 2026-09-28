// AgentEvent -> UIMessageChunk mapping (docs/ARCHITECTURE.md §6), checked
// chunk by chunk and through the AI SDK's own reducer (readUIMessageStream,
// the one useChat runs).

import {
  type DynamicToolUIPart,
  isDynamicToolUIPart,
  readUIMessageStream,
  type UIMessageChunk,
} from "ai";
import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../../../src/contracts/api.js";
import type { AgentEvent, RunConnection } from "../../../src/contracts/events.js";
import { INTEGRATIONS } from "../../../src/contracts/integration.js";
import {
  automaticApprovalId,
  type ChatUIChunk,
  INTERRUPTED_TOOL_TEXT,
  isTransientChunk,
  noticeFor,
  UIStreamMapper,
  UNDECIDED_APPROVAL_TEXT,
} from "../../../src/server/ui-stream.js";
import {
  chunkTypes,
  ev,
  LOOKUP_CALL,
  REFUND_CALL,
  reduce,
  refundDescriptor,
  TEST_SECRET,
  testRedact,
} from "./harness.js";

const RUN_STARTED: AgentEvent = {
  type: "run.started",
  runId: "run_1",
  conversationId: "c1",
  source: "ui",
  mode: "interactive",
  model: "claude-sonnet-5",
  effort: "medium",
  startedAt: "2026-09-28T10:00:00.000Z",
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
      integration: "slack",
      kind: "api",
      profile: "slack-api",
      availability: "unavailable",
      state: "not_configured",
      detail: "Not configured. Set SLACK_BOT_TOKEN.",
      endpointLabel: null,
    },
    {
      integration: "google_calendar",
      kind: "composio",
      profile: "composio",
      availability: "unavailable",
      state: "needs_auth",
      detail: "Google Calendar is not connected",
      endpointLabel: "backend.composio.dev",
    },
  ],
};

function mapper(anomalies: string[] = []) {
  return new UIStreamMapper({
    messageId: "msg_a1",
    fallbackMetadata: { runId: "run_1", model: "claude-sonnet-5", effort: "medium" },
    redact: testRedact,
    onAnomaly: (message) => anomalies.push(message),
  });
}

function mapAll(events: readonly AgentEvent[], anomalies: string[] = []): ChatUIChunk[] {
  const m = mapper(anomalies);
  return events.flatMap((event) => m.map(event));
}

/** Every snapshot the reducer produced, and the tool part's states in order. */
async function snapshots(chunks: readonly ChatUIChunk[]) {
  const all: ChatUIMessage[] = [];
  for await (const snapshot of readUIMessageStream<ChatUIMessage>({
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    terminateOnError: false,
  })) {
    all.push(snapshot);
  }
  return all;
}

function toolStates(all: readonly ChatUIMessage[], toolCallId: string): string[] {
  return all
    .map(
      (snapshot) =>
        snapshot.parts.find(
          (part): part is DynamicToolUIPart =>
            isDynamicToolUIPart(part) && part.toolCallId === toolCallId,
        )?.state,
    )
    .filter((state): state is DynamicToolUIPart["state"] => state !== undefined)
    .filter((state, index, states) => state !== states[index - 1]);
}

function toolPart(message: ChatUIMessage | undefined, toolCallId: string): DynamicToolUIPart {
  const part = message?.parts.find(
    (candidate): candidate is DynamicToolUIPart =>
      isDynamicToolUIPart(candidate) && candidate.toolCallId === toolCallId,
  );
  if (part === undefined) throw new Error(`no tool part ${toolCallId}`);
  return part;
}

const descriptor = refundDescriptor();

/** The approved refund turn of the scripted core, as events. */
function approvedRefund(): AgentEvent[] {
  return [
    RUN_STARTED,
    { type: "session", sdkSessionId: "sess_1" },
    { type: "status", status: { phase: "requesting" } },
    { type: "step.start" },
    ...ev.reasoning("r1", "A duplicate charge."),
    ...ev.text("t1", "I'll refund it once you approve."),
    ...ev.toolInput(REFUND_CALL),
    { type: "step.finish" },
    { type: "approval.requested", approvalId: "apr_1", toolCallId: REFUND_CALL.id, descriptor },
    {
      type: "approval.resolved",
      approvalId: "apr_1",
      toolCallId: REFUND_CALL.id,
      approved: true,
      decidedBy: "user",
      reason: null,
    },
    { type: "tool.progress", toolCallId: REFUND_CALL.id, elapsedMs: 300 },
    ev.output(REFUND_CALL.id, { id: "re_1" }),
    { type: "step.start" },
    ...ev.text("t2", "Refunded."),
    { type: "step.finish" },
    ev.usage(),
    ev.finished("completed"),
  ];
}

describe("UIStreamMapper: the approved refund (S1 sequence)", () => {
  it("emits the proven chunk order", () => {
    expect(chunkTypes(mapAll(approvedRefund()))).toEqual([
      "start",
      "data-notice",
      "data-status",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-available",
      "finish-step",
      "tool-approval-request",
      "tool-approval-response",
      "data-progress",
      "tool-output-available",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "data-usage",
      // usage, then status: consecutive repeats collapse into one entry
      "message-metadata",
      "finish",
    ]);
  });

  it("carries the message id, metadata, tool metadata and the approval descriptor", () => {
    const chunks = mapAll(approvedRefund());
    expect(chunks[0]).toEqual({
      type: "start",
      messageId: "msg_a1",
      messageMetadata: { runId: "run_1", model: "claude-sonnet-5", effort: "medium" },
    });
    expect(chunks.filter((chunk) => chunk.type === "data-notice")).toEqual([
      {
        type: "data-notice",
        id: "notice-slack",
        data: {
          level: "info",
          code: "connection_unavailable",
          integration: "slack",
          // The notice names its system.
          message: "Slack is not configured: set SLACK_BOT_TOKEN. Its tools are not offered.",
        },
      },
      {
        type: "data-notice",
        id: "notice-google_calendar",
        data: {
          level: "warning",
          code: "connection_unavailable",
          integration: "google_calendar",
          message: "Google Calendar is not connected",
        },
      },
    ]);
    expect(chunks.find((chunk) => chunk.type === "tool-input-start")).toEqual({
      type: "tool-input-start",
      toolCallId: REFUND_CALL.id,
      toolName: REFUND_CALL.toolName,
      dynamic: true,
      title: REFUND_CALL.title,
      toolMetadata: REFUND_CALL.tool,
    });
    expect(chunks.find((chunk) => chunk.type === "tool-approval-request")).toEqual({
      type: "tool-approval-request",
      approvalId: "apr_1",
      toolCallId: REFUND_CALL.id,
      approvalDescriptor: descriptor,
      reason: descriptor.consequence,
    });
    expect(chunks.at(-2)).toEqual({
      type: "message-metadata",
      messageMetadata: {
        runId: "run_1",
        model: "claude-sonnet-5",
        effort: "medium",
        status: "completed",
        usage: expect.objectContaining({ costUsd: 0.0123, numTurns: 2 }),
      },
    });
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("reduces to the rendered message: approval requested, responded, output available", async () => {
    const all = await snapshots(mapAll(approvedRefund()));
    expect(toolStates(all, REFUND_CALL.id)).toEqual([
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
    ]);
    const final = all.at(-1);
    expect(final?.id).toBe("msg_a1");
    expect(final?.parts.map((part) => part.type)).toEqual([
      "data-notice",
      "data-notice",
      "step-start",
      "reasoning",
      "text",
      "dynamic-tool",
      "step-start",
      "text",
      "data-usage",
    ]);
    expect(toolPart(final, REFUND_CALL.id)).toMatchObject({
      state: "output-available",
      input: REFUND_CALL.input,
      output: { id: "re_1" },
      title: REFUND_CALL.title,
      toolMetadata: REFUND_CALL.tool,
      approval: { id: "apr_1", approved: true, descriptor, requestReason: descriptor.consequence },
    });
    // Transient parts never become part of the message.
    expect(
      final?.parts.some((part) => part.type === "data-status" || part.type === "data-progress"),
    ).toBe(false);
    expect(final?.metadata).toMatchObject({ status: "completed", usage: { costUsd: 0.0123 } });
  });
});

describe("UIStreamMapper: denials", () => {
  const head: AgentEvent[] = [
    RUN_STARTED,
    { type: "step.start" },
    ...ev.toolInput(REFUND_CALL),
    { type: "step.finish" },
  ];

  it("maps a policy denial to an automatic request and response, then output-denied", async () => {
    const chunks = mapAll([
      ...head,
      {
        type: "tool.denied",
        toolCallId: REFUND_CALL.id,
        decision: "policy_denied",
        reason: "Financial actions are denied by policy.",
      },
      ev.finished("completed"),
    ]);
    const approvalId = automaticApprovalId(REFUND_CALL.id);
    expect(
      chunks.filter(
        (chunk) => chunk.type.startsWith("tool-approval") || chunk.type === "tool-output-denied",
      ),
    ).toEqual([
      {
        type: "tool-approval-request",
        approvalId,
        toolCallId: REFUND_CALL.id,
        isAutomatic: true,
        reason: "Financial actions are denied by policy.",
      },
      {
        type: "tool-approval-response",
        approvalId,
        approved: false,
        reason: "Financial actions are denied by policy.",
      },
      { type: "tool-output-denied", toolCallId: REFUND_CALL.id },
    ]);
    const part = toolPart(await reduce(chunks), REFUND_CALL.id);
    expect(part).toMatchObject({
      state: "output-denied",
      approval: {
        id: approvalId,
        approved: false,
        isAutomatic: true,
        reason: "Financial actions are denied by policy.",
        requestReason: "Financial actions are denied by policy.",
      },
    });
  });

  it("maps a user denial to the response, then output-denied", async () => {
    const chunks = mapAll([
      ...head,
      { type: "approval.requested", approvalId: "apr_1", toolCallId: REFUND_CALL.id, descriptor },
      {
        type: "approval.resolved",
        approvalId: "apr_1",
        toolCallId: REFUND_CALL.id,
        approved: false,
        decidedBy: "user",
        reason: "Wrong customer",
      },
      {
        type: "tool.denied",
        toolCallId: REFUND_CALL.id,
        decision: "denied",
        reason: "Wrong customer",
      },
      ev.finished("completed"),
    ]);
    expect(chunkTypes(chunks).slice(-5)).toEqual([
      "tool-approval-request",
      "tool-approval-response",
      "tool-output-denied",
      "message-metadata",
      "finish",
    ]);
    expect(toolPart(await reduce(chunks), REFUND_CALL.id)).toMatchObject({
      state: "output-denied",
      approval: { approved: false, reason: "Wrong customer", descriptor },
    });
  });

  it("answers the approval before the outcome even when the core skipped approval.resolved", async () => {
    const chunks = mapAll([
      ...head,
      { type: "approval.requested", approvalId: "apr_1", toolCallId: REFUND_CALL.id, descriptor },
      {
        type: "tool.denied",
        toolCallId: REFUND_CALL.id,
        decision: "timed_out",
        reason: "Not approved in time.",
      },
      ev.finished("completed"),
    ]);
    expect(chunks.find((chunk) => chunk.type === "tool-approval-response")).toEqual({
      type: "tool-approval-response",
      approvalId: "apr_1",
      approved: false,
      reason: "Not approved in time.",
    });
    expect(toolPart(await reduce(chunks), REFUND_CALL.id).state).toBe("output-denied");
  });

  it("answers an approval as approved when the call ran without approval.resolved", async () => {
    const chunks = mapAll([
      ...head,
      { type: "approval.requested", approvalId: "apr_1", toolCallId: REFUND_CALL.id, descriptor },
      ev.output(REFUND_CALL.id, { id: "re_1" }),
      ev.finished("completed"),
    ]);
    expect(chunkTypes(chunks).slice(-5, -2)).toEqual([
      "tool-approval-request",
      "tool-approval-response",
      "tool-output-available",
    ]);
    expect(toolPart(await reduce(chunks), REFUND_CALL.id)).toMatchObject({
      state: "output-available",
      approval: { approved: true },
    });
  });

  it("maps a rejected call (unknown tool or invalid input) to tool-output-error", async () => {
    const unknown = {
      ...LOOKUP_CALL,
      id: "toolu_unknown",
      toolName: "mcp__nowhere__x",
      title: "mcp__nowhere__x",
      tool: null,
    };
    const chunks = mapAll([
      RUN_STARTED,
      { type: "step.start" },
      ...ev.toolInput(unknown),
      { type: "step.finish" },
      {
        type: "tool.denied",
        toolCallId: unknown.id,
        decision: "rejected",
        reason: "Unknown tool mcp__nowhere__x.",
      },
      ev.finished("completed"),
    ]);
    expect(chunks.find((chunk) => chunk.type === "tool-input-start")).not.toHaveProperty(
      "toolMetadata",
    );
    expect(chunks.find((chunk) => chunk.type === "tool-output-error")).toEqual({
      type: "tool-output-error",
      toolCallId: unknown.id,
      errorText: "Unknown tool mcp__nowhere__x.",
    });
    expect(toolPart(await reduce(chunks), unknown.id)).toMatchObject({
      state: "output-error",
      errorText: "Unknown tool mcp__nowhere__x.",
    });
  });
});

describe("UIStreamMapper: outputs, failures and stops", () => {
  it("maps an error output to tool-output-error with the provider message", async () => {
    const chunks = mapAll([
      RUN_STARTED,
      { type: "step.start" },
      ...ev.toolInput(LOOKUP_CALL),
      { type: "step.finish" },
      ev.output(
        LOOKUP_CALL.id,
        { error: { message: "Rate limited" } },
        {
          isError: true,
          error: { provider: "stripe", status: 429, code: "rate_limit", message: "Rate limited" },
        },
      ),
      ev.finished("completed"),
    ]);
    expect(chunks.find((chunk) => chunk.type === "tool-output-error")).toEqual({
      type: "tool-output-error",
      toolCallId: LOOKUP_CALL.id,
      errorText: "Rate limited",
    });
    expect(toolPart(await reduce(chunks), LOOKUP_CALL.id).state).toBe("output-error");
  });

  it("redacts secrets in inputs, outputs, descriptors and error texts", () => {
    const leaky = { ...REFUND_CALL, input: { note: `key ${TEST_SECRET}` } };
    const chunks = mapAll([
      RUN_STARTED,
      { type: "step.start" },
      ...ev.toolInput(leaky),
      { type: "step.finish" },
      {
        type: "approval.requested",
        approvalId: "apr_1",
        toolCallId: leaky.id,
        descriptor: { ...descriptor, facts: [{ label: "Key", value: TEST_SECRET }] },
      },
      {
        type: "approval.resolved",
        approvalId: "apr_1",
        toolCallId: leaky.id,
        approved: true,
        decidedBy: "user",
        reason: null,
      },
      ev.output(leaky.id, { echoed: TEST_SECRET }),
      ev.finished("failed", { error: { code: "internal", message: `Bearer ${TEST_SECRET}` } }),
    ]);
    const serialised = JSON.stringify(chunks.filter((chunk) => chunk.type !== "tool-input-delta"));
    expect(serialised).not.toContain(TEST_SECRET);
    expect(serialised).toContain("[redacted]");
  });

  it("closes open parts and pending calls when the run is stopped", async () => {
    const chunks = mapAll([
      RUN_STARTED,
      { type: "step.start" },
      ...ev.toolInput(LOOKUP_CALL),
      ...ev.toolInput(REFUND_CALL),
      { type: "step.finish" },
      { type: "approval.requested", approvalId: "apr_1", toolCallId: REFUND_CALL.id, descriptor },
      { type: "step.start" },
      { type: "text.start", id: "t9" },
      { type: "text.delta", id: "t9", delta: "Partial" },
      ev.finished("cancelled", { stopReason: "user" }),
    ]);
    expect(chunkTypes(chunks).slice(-6)).toEqual([
      "text-end",
      "tool-output-error",
      "tool-approval-response",
      "tool-output-denied",
      "message-metadata",
      "abort",
    ]);
    expect(chunks.at(-1)).toEqual({ type: "abort", reason: "user" });
    const final = await reduce(chunks);
    expect(toolPart(final, LOOKUP_CALL.id)).toMatchObject({
      state: "output-error",
      errorText: INTERRUPTED_TOOL_TEXT,
    });
    expect(toolPart(final, REFUND_CALL.id)).toMatchObject({
      state: "output-denied",
      approval: { approved: false, reason: UNDECIDED_APPROVAL_TEXT },
    });
    expect(final?.parts.find((part) => part.type === "text")).toMatchObject({
      state: "done",
      text: "Partial",
    });
    expect(final?.metadata?.status).toBe("cancelled");
  });

  it("ends a failed run with a redacted error chunk and a timed-out one with abort", () => {
    const failed = mapAll([
      RUN_STARTED,
      ev.finished("failed", { error: { code: "model_error", message: "Overloaded" } }),
    ]);
    expect(failed.slice(-2)).toEqual([
      {
        type: "message-metadata",
        messageMetadata: {
          runId: "run_1",
          model: "claude-sonnet-5",
          effort: "medium",
          status: "failed",
        },
      },
      { type: "error", errorText: "Overloaded" },
    ]);
    expect(mapAll([RUN_STARTED, ev.finished("failed")]).at(-1)).toEqual({
      type: "error",
      errorText: "The run failed.",
    });
    expect(mapAll([RUN_STARTED, ev.finished("timed_out")]).at(-1)).toEqual({
      type: "abort",
      reason: "timeout",
    });
  });
});

describe("UIStreamMapper: ordering guards", () => {
  it("sends a start before any event that precedes run.started", () => {
    const anomalies: string[] = [];
    const chunks = mapAll([{ type: "step.start" }, RUN_STARTED], anomalies);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["start", "start-step"]);
    expect(anomalies).toEqual(["a second run.started"]);
  });

  it("drops out-of-order events and reports them, so the reducer never throws", async () => {
    const anomalies: string[] = [];
    const chunks = mapAll(
      [
        RUN_STARTED,
        { type: "step.start" },
        { type: "tool.input.delta", toolCallId: "ghost", inputTextDelta: "{" },
        { type: "text.delta", id: "ghost", delta: "x" },
        { type: "tool.progress", toolCallId: "ghost", elapsedMs: 1 },
        ev.output("ghost", {}),
        ...ev.toolInput(LOOKUP_CALL),
        // A repeat after a new step would duplicate the part.
        { type: "step.start" },
        {
          type: "tool.input.available",
          toolCallId: LOOKUP_CALL.id,
          toolName: LOOKUP_CALL.toolName,
          title: LOOKUP_CALL.title,
          input: LOOKUP_CALL.input,
          tool: LOOKUP_CALL.tool,
        },
        ev.output(LOOKUP_CALL.id, { data: [] }),
        ev.output(LOOKUP_CALL.id, { data: [] }),
        {
          type: "approval.resolved",
          approvalId: "x",
          toolCallId: LOOKUP_CALL.id,
          approved: true,
          decidedBy: "user",
          reason: null,
        },
        ev.finished("completed"),
        { type: "step.start" },
      ],
      anomalies,
    );
    expect(anomalies).toHaveLength(8);
    const final = await reduce(chunks);
    expect(final?.parts.filter((part) => part.type === "dynamic-tool")).toHaveLength(1);
    expect(toolPart(final, LOOKUP_CALL.id).state).toBe("output-available");
  });

  it("marks only status and progress chunks as transient", () => {
    const chunks = mapAll(approvedRefund());
    expect(chunks.filter(isTransientChunk).map((chunk) => chunk.type)).toEqual([
      "data-status",
      "data-progress",
    ]);
  });
});

describe("connection notices", () => {
  const connection = (
    integration: RunConnection["integration"],
    state: RunConnection["state"],
    detail: string | null,
  ): RunConnection => ({
    integration,
    kind: INTEGRATIONS[integration].kind,
    profile: INTEGRATIONS[integration].profile,
    availability: "unavailable",
    state,
    detail,
    endpointLabel: null,
  });

  it("name their system, so Gmail's and Calendar's read differently", () => {
    const missing = "Not configured. Set COMPOSIO_API_KEY and COMPOSIO_USER_ID.";
    expect(noticeFor(connection("gmail", "not_configured", missing)).message).toBe(
      "Gmail is not configured: set COMPOSIO_API_KEY and COMPOSIO_USER_ID. Its tools are not offered.",
    );
    expect(noticeFor(connection("google_calendar", "not_configured", missing)).message).toBe(
      "Google Calendar is not configured: set COMPOSIO_API_KEY and COMPOSIO_USER_ID. Its tools are not offered.",
    );
    // A check's detail already naming the system is kept; its provider line is not.
    expect(
      noticeFor(
        connection(
          "quickbooks",
          "expired",
          "QuickBooks Online rejected the access token (it expires hourly). Put a new QBO_ACCESS_TOKEN in your configuration file and restart Revenue Desk.\nQuickBooks said: 401",
        ),
      ).message,
    ).toBe(
      "QuickBooks Online rejected the access token (it expires hourly). Put a new QBO_ACCESS_TOKEN in your configuration file and restart Revenue Desk.",
    );
    expect(noticeFor(connection("hubspot", "error", "could not connect")).message).toBe(
      "HubSpot: could not connect",
    );
    expect(noticeFor(connection("slack", "unknown", null)).message).toBe(
      "Slack is unavailable for this run.",
    );
  });

  it("become one line when three or more systems are unavailable", () => {
    const ids = ["gmail", "google_calendar", "hubspot", "stripe", "quickbooks", "slack"] as const;
    const chunks = mapper().map({
      ...(RUN_STARTED as Extract<AgentEvent, { type: "run.started" }>),
      connections: ids.map((id) => connection(id, "not_configured", "Not configured. Set X.")),
    });
    const notices = chunks.filter((chunk) => chunk.type === "data-notice");
    expect(notices).toEqual([
      {
        type: "data-notice",
        id: "notice-connections",
        data: {
          level: "warning",
          code: "connection_unavailable",
          integration: "gmail",
          message:
            "Not available for this run: Gmail, Google Calendar, HubSpot, Stripe, QuickBooks Online, Slack. See Connections.",
        },
      },
    ]);
  });
});
