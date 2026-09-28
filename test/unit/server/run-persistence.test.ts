// RunPersistence: what one run writes from its events, shared by the server's
// run registry and the CLI. On a real SQLite file.

import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, ToolMetadata } from "../../../src/contracts/events.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import { insertConversation } from "../../../src/db/repos/conversations.js";
import { listMessages } from "../../../src/db/repos/messages.js";
import { getRun, insertRun } from "../../../src/db/repos/runs.js";
import { listToolCalls } from "../../../src/db/repos/tool-calls.js";
import { seedDatabase } from "../../../src/db/seed.js";
import { RunPersistence } from "../../../src/server/run-persistence.js";
import { cleanupAll, openTestDatabase } from "../db/support.js";

afterEach(cleanupAll);

const T0 = "2026-09-28T10:00:00.000Z";
const REFUND: ToolMetadata = {
  integration: "stripe",
  connectionKind: "api",
  operation: "stripe.refunds.create",
  actionClass: "financial",
};

function setup() {
  const database = openTestDatabase();
  const { db } = database;
  seedDatabase(db, T0);
  insertConversation(db, { id: "c1", title: "", source: "cli", now: T0 });
  insertRun(db, {
    id: "r1",
    conversationId: "c1",
    source: "cli",
    mode: "headless",
    model: "claude-sonnet-5",
    effort: "medium",
    userMessageId: null,
    assistantMessageId: "m_assistant",
    policy: DEFAULT_POLICY,
    connections: [],
    startedAt: T0,
  });
  const lines: string[] = [];
  const persistence = new RunPersistence({
    db,
    runId: "r1",
    conversationId: "c1",
    assistantMessageId: "m_assistant",
    fallbackMetadata: { runId: "r1", model: "claude-sonnet-5", effort: "medium" },
    redact: (text) => text,
    now: () => new Date(T0),
    log: (line) => lines.push(line),
  });
  const apply = (event: AgentEvent) => {
    persistence.record(event);
    return persistence.map(event);
  };
  return { db, persistence, apply, lines };
}

const started: AgentEvent = {
  type: "run.started",
  runId: "r1",
  conversationId: "c1",
  source: "cli",
  mode: "headless",
  model: "claude-sonnet-5",
  effort: "medium",
  startedAt: T0,
  connections: [],
};

describe("RunPersistence", () => {
  it("records the action log and stores the assistant message the stream renders", async () => {
    const { db, persistence, apply } = setup();
    const chunks = [
      ...apply(started),
      ...apply({ type: "step.start" }),
      ...apply({ type: "text.start", id: "t1" }),
      ...apply({ type: "text.delta", id: "t1", delta: "Refunded $490.00." }),
      ...apply({ type: "text.end", id: "t1" }),
      ...apply({ type: "step.finish" }),
      ...apply({
        type: "run.finished",
        status: "completed",
        finishedAt: T0,
        stopReason: null,
        terminalReason: "completed",
        reply: "done",
        error: null,
      }),
    ];
    await persistence.end("completed");
    expect(chunks[0]).toMatchObject({ type: "start", messageId: "m_assistant" });
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
    expect(persistence.finished).toBe(true);
    expect(getRun(db, "r1")).toMatchObject({ status: "completed", terminalReason: "completed" });
    const [assistant] = listMessages(db, "c1");
    expect(assistant).toMatchObject({ id: "m_assistant", role: "assistant" });
    expect(assistant?.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "Refunded $490.00.", state: "done" },
    ]);
  });

  it("keeps a known tool's integration when its input cannot be classified", async () => {
    const { db, persistence, apply } = setup();
    apply(started);
    apply({ type: "step.start" });
    apply({
      type: "tool.input.start",
      toolCallId: "toolu_bad",
      toolName: "mcp__stripe__create_refund",
      title: "Refund a charge",
      tool: REFUND,
    });
    apply({
      type: "tool.input.available",
      toolCallId: "toolu_bad",
      toolName: "mcp__stripe__create_refund",
      title: "Refund a charge",
      input: { charge: "ch_1", amount: -1 },
      tool: null,
    });
    apply({ type: "step.finish" });
    apply({
      type: "tool.denied",
      toolCallId: "toolu_bad",
      decision: "rejected",
      reason: "amount: must be positive",
    });
    apply({
      type: "tool.input.start",
      toolCallId: "toolu_unknown",
      toolName: "mcp__nowhere__thing",
      title: "mcp__nowhere__thing",
      tool: null,
    });
    apply({
      type: "tool.input.available",
      toolCallId: "toolu_unknown",
      toolName: "mcp__nowhere__thing",
      title: "mcp__nowhere__thing",
      input: {},
      tool: null,
    });
    apply({
      type: "tool.denied",
      toolCallId: "toolu_unknown",
      decision: "rejected",
      reason: "No such tool",
    });
    apply({
      type: "run.finished",
      status: "completed",
      finishedAt: T0,
      stopReason: null,
      terminalReason: "completed",
      reply: null,
      error: null,
    });
    await persistence.end("completed");
    expect(listToolCalls(db, "r1")).toMatchObject([
      {
        toolCallId: "toolu_bad",
        integration: "stripe",
        connectionKind: "api",
        operation: "stripe.refunds.create",
        actionClass: "financial",
        decision: "rejected",
        status: "failed",
      },
      {
        toolCallId: "toolu_unknown",
        integration: null,
        connectionKind: null,
        operation: null,
        actionClass: null,
        decision: "rejected",
      },
    ]);
  });
});
