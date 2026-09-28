// Boot recovery: runs the server owned end failed, their approvals expire,
// their messages close; the CLI's runs are left alone.

import { afterEach, describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../../../src/contracts/api.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import {
  closeInterruptedMessage,
  INTERRUPTED_TOOL_TEXT,
  RESTART_APPROVAL_REASON,
  RESTART_RUN_MESSAGE,
  recoverAfterRestart,
} from "../../../src/db/recover.js";
import { getApproval, insertPendingApproval } from "../../../src/db/repos/approvals.js";
import {
  getConversation,
  insertConversation,
  setConversationStatus,
} from "../../../src/db/repos/conversations.js";
import {
  getMessageRow,
  toChatMessage,
  upsertAssistantMessage,
} from "../../../src/db/repos/messages.js";
import { getRun, insertRun } from "../../../src/db/repos/runs.js";
import {
  getToolCallByToolUseId,
  insertToolCall,
  markToolCallAwaitingApproval,
} from "../../../src/db/repos/tool-calls.js";
import { seedDatabase } from "../../../src/db/seed.js";
import { cleanupAll, openTestDatabase, refundDescriptor } from "./support.js";

afterEach(cleanupAll);

const T0 = "2026-09-28T10:00:00.000Z";
const BOOT = "2026-09-28T11:00:00.000Z";

const interruptedMessage: ChatUIMessage = {
  id: "a1",
  role: "assistant",
  metadata: { runId: "r_ui", model: "claude-sonnet-5", effort: "medium" },
  parts: [
    { type: "step-start" },
    { type: "reasoning", text: "Thinking", state: "streaming" },
    { type: "text", text: "Refunding", state: "streaming" },
    {
      type: "dynamic-tool",
      toolName: "mcp__stripe__list_charges",
      toolCallId: "toolu_read",
      state: "input-available",
      input: { customer: "cus_1" },
      title: "List charges",
    },
    {
      type: "dynamic-tool",
      toolName: "mcp__stripe__create_refund",
      toolCallId: "toolu_refund",
      state: "approval-requested",
      input: { charge: "ch_1" },
      title: "Refund charge",
      toolMetadata: { integration: "stripe" },
      approval: {
        id: "apr_1",
        descriptor: { consequence: "Refund $49.00" },
        requestReason: "Refund $49.00",
      },
    },
    {
      type: "dynamic-tool",
      toolName: "mcp__slack__post_message",
      toolCallId: "toolu_post",
      state: "input-streaming",
      input: undefined,
    },
    {
      type: "dynamic-tool",
      toolName: "mcp__stripe__get_balance",
      toolCallId: "toolu_done",
      state: "output-available",
      input: {},
      output: { available: 1 },
    },
  ],
};

function setup() {
  const database = openTestDatabase();
  seedDatabase(database.db, T0);
  const { db } = database;
  insertConversation(db, { id: "c_ui", title: "UI", source: "ui", now: T0 });
  insertConversation(db, { id: "c_cli", title: "CLI", source: "cli", now: T0 });
  for (const [id, conversationId, source] of [
    ["r_ui", "c_ui", "ui"],
    ["r_cli", "c_cli", "cli"],
  ] as const) {
    insertRun(db, {
      id,
      conversationId,
      source,
      mode: source === "ui" ? "interactive" : "headless",
      model: "claude-sonnet-5",
      effort: "medium",
      userMessageId: null,
      assistantMessageId: id === "r_ui" ? "a1" : null,
      policy: DEFAULT_POLICY,
      connections: [],
      startedAt: T0,
    });
  }
  setConversationStatus(db, "c_ui", "awaiting_approval", T0);
  setConversationStatus(db, "c_cli", "running", T0);
  insertToolCall(db, {
    id: "tc_refund",
    runId: "r_ui",
    conversationId: "c_ui",
    toolUseId: "toolu_refund",
    integration: "stripe",
    connectionKind: "api",
    toolName: "mcp__stripe__create_refund",
    operation: "stripe.refunds.create",
    actionClass: "financial",
    title: "Refund charge",
    input: { charge: "ch_1" },
    startedAt: T0,
  });
  markToolCallAwaitingApproval(db, "toolu_refund", "apr_1");
  insertPendingApproval(db, {
    id: "apr_1",
    runId: "r_ui",
    conversationId: "c_ui",
    toolUseId: "toolu_refund",
    descriptor: refundDescriptor(),
    requestedAt: T0,
    expiresAt: refundDescriptor().expiresAt,
  });
  upsertAssistantMessage(db, {
    conversationId: "c_ui",
    runId: "r_ui",
    message: interruptedMessage,
    now: T0,
  });
  return database;
}

describe("recoverAfterRestart", () => {
  it("fails the server's running runs and expires their approvals", () => {
    const { db } = setup();
    expect(recoverAfterRestart(db, { now: BOOT })).toEqual({ runs: 1, toolCalls: 1, approvals: 1 });

    expect(getRun(db, "r_ui")).toMatchObject({
      status: "failed",
      errorCode: "server_restart",
      errorMessage: RESTART_RUN_MESSAGE,
      finishedAt: BOOT,
    });
    expect(getToolCallByToolUseId(db, "toolu_refund")).toMatchObject({
      status: "interrupted",
      finishedAt: BOOT,
    });
    expect(getApproval(db, "apr_1")).toMatchObject({
      status: "expired",
      decidedBy: "restart",
      reason: RESTART_APPROVAL_REASON,
      decidedAt: BOOT,
    });
    expect(getConversation(db, "c_ui")?.status).toBe("error");

    // The CLI's run belongs to another process.
    expect(getRun(db, "r_cli")?.status).toBe("running");
    expect(getConversation(db, "c_cli")?.status).toBe("running");
  });

  it("closes the persisted message so no card or spinner is left open", () => {
    const { db } = setup();
    recoverAfterRestart(db, { now: BOOT });
    const row = getMessageRow(db, "a1");
    if (row === undefined) throw new Error("missing message");
    const message = toChatMessage(row);
    expect(message.metadata?.status).toBe("failed");
    expect(message.parts.map((part) => ("state" in part ? part.state : part.type))).toEqual([
      "step-start",
      "done",
      "done",
      "output-error",
      "output-denied",
      "output-error",
      "output-available",
    ]);
    expect(message.parts[3]).toMatchObject({
      errorText: INTERRUPTED_TOOL_TEXT,
      input: { customer: "cus_1" },
    });
    expect(message.parts[4]).toMatchObject({
      toolMetadata: { integration: "stripe" },
      approval: {
        id: "apr_1",
        approved: false,
        reason: RESTART_APPROVAL_REASON,
        requestReason: "Refund $49.00",
        descriptor: { consequence: "Refund $49.00" },
      },
    });
  });

  it("is idempotent and can include the CLI's runs on request", () => {
    const { db } = setup();
    recoverAfterRestart(db, { now: BOOT });
    expect(recoverAfterRestart(db, { now: BOOT })).toEqual({ runs: 0, toolCalls: 0, approvals: 0 });
    expect(recoverAfterRestart(db, { now: BOOT, sources: ["cli"] }).runs).toBe(1);
    expect(getRun(db, "r_cli")?.status).toBe("failed");
  });
});

describe("closeInterruptedMessage", () => {
  it("keeps a denied response denied and fails an approved call that never finished", () => {
    const closed = closeInterruptedMessage(
      {
        metadata: undefined,
        parts: [
          {
            type: "dynamic-tool",
            toolName: "t",
            toolCallId: "a",
            state: "approval-responded",
            input: {},
            approval: { id: "x", approved: false, reason: "No" },
          },
          {
            type: "dynamic-tool",
            toolName: "t",
            toolCallId: "b",
            state: "approval-responded",
            input: {},
            approval: { id: "y", approved: true },
          },
        ],
      },
      "restart",
    );
    expect(closed.metadata).toBeUndefined();
    expect(closed.parts).toMatchObject([
      { state: "output-denied", approval: { approved: false, reason: "No" } },
      { state: "output-error", errorText: INTERRUPTED_TOOL_TEXT, approval: { approved: true } },
    ]);
  });
});
