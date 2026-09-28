// Recovery of runs whose owner process is gone: they end failed, their
// approvals expire, their messages close; runs of live processes (a CLI
// still working, another server) are left alone.

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../../../src/contracts/api.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import type { RunOwner } from "../../../src/db/owner.js";
import {
  closeInterruptedMessage,
  INTERRUPTED_TOOL_TEXT,
  ORPHANED_RUN_MESSAGES,
  RESTART_APPROVAL_REASON,
  recoverAfterRestart,
  recoverOrphanedRuns,
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
import { finishRun, getRun, insertRun } from "../../../src/db/repos/runs.js";
import {
  getToolCallByToolUseId,
  insertToolCall,
  markToolCallAwaitingApproval,
} from "../../../src/db/repos/tool-calls.js";
import { seedDatabase } from "../../../src/db/seed.js";
import { cleanupAll, openTestDatabase, probeOf, refundDescriptor } from "./support.js";

afterEach(cleanupAll);

const T0 = "2026-09-28T10:00:00.000Z";
const BOOT = "2026-09-28T11:00:00.000Z";

/** This process (the booting server). */
const SELF: RunOwner = { pid: 1000, startedAt: "2026-09-28T10:59:59.000Z" };
/** The server's previous life: its pid is gone. */
const OLD_SERVER: RunOwner = { pid: 2000, startedAt: "2026-09-28T09:00:00.000Z" };
/** A CLI invocation still running. */
const LIVE_CLI: RunOwner = { pid: 3000, startedAt: "2026-09-28T09:59:30.000Z" };

/** The CLI (pid 3000) is still running; the old server (pid 2000) is gone. */
const CLI_ALIVE = probeOf({ [LIVE_CLI.pid]: "2026-09-28T09:59:30.000Z" });
const NOTHING_ALIVE = probeOf({});

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
  for (const [id, conversationId, source, owner] of [
    ["r_ui", "c_ui", "ui", OLD_SERVER],
    ["r_cli", "c_cli", "cli", LIVE_CLI],
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
      owner,
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
  markToolCallAwaitingApproval(db, { runId: "r_ui", toolUseId: "toolu_refund" }, "apr_1");
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

const boot = { now: BOOT, self: SELF, probe: CLI_ALIVE };

describe("recoverAfterRestart", () => {
  it("fails the runs of the server's previous life and expires their approvals", () => {
    const { db } = setup();
    expect(recoverAfterRestart(db, boot)).toEqual({ runs: 1, toolCalls: 1, approvals: 1 });

    expect(getRun(db, "r_ui")).toMatchObject({
      status: "failed",
      errorCode: "server_restart",
      errorMessage: ORPHANED_RUN_MESSAGES.ui,
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

    // The CLI's run belongs to a process that is still running.
    expect(getRun(db, "r_cli")?.status).toBe("running");
    expect(getConversation(db, "c_cli")?.status).toBe("running");
  });

  it("closes the persisted message so no card or spinner is left open", () => {
    const { db } = setup();
    recoverAfterRestart(db, boot);
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

  it("is idempotent, and fails the CLI's run once its process is gone", () => {
    const { db } = setup();
    recoverAfterRestart(db, boot);
    expect(recoverAfterRestart(db, boot)).toEqual({ runs: 0, toolCalls: 0, approvals: 0 });
    expect(recoverAfterRestart(db, { ...boot, probe: NOTHING_ALIVE }).runs).toBe(1);
    expect(getRun(db, "r_cli")).toMatchObject({
      status: "failed",
      errorCode: "server_restart",
      errorMessage: ORPHANED_RUN_MESSAGES.cli,
    });
    expect(getConversation(db, "c_cli")?.status).toBe("error");
  });

  it("treats a reused pid as gone: the process under it started at another time", () => {
    const { db } = setup();
    const reused = probeOf({ [LIVE_CLI.pid]: "2026-09-28T10:30:00.000Z" });
    expect(recoverAfterRestart(db, { ...boot, probe: reused }).runs).toBe(2);
    expect(getRun(db, "r_cli")?.status).toBe("failed");
  });

  it("accepts the start time ps reports, which has whole seconds", () => {
    const { db } = setup();
    const truncated = probeOf({ [LIVE_CLI.pid]: "2026-09-28T09:59:29.000Z" });
    recoverAfterRestart(db, { ...boot, probe: truncated });
    expect(getRun(db, "r_cli")?.status).toBe("running");
  });

  it("recovers a running row written before owners were recorded", () => {
    const { db } = setup();
    db.run(sql`UPDATE runs SET owner_pid = NULL, owner_started_at = NULL WHERE id = 'r_cli'`);
    expect(recoverAfterRestart(db, boot).runs).toBe(2);
    expect(getRun(db, "r_cli")?.status).toBe("failed");
  });

  it("keeps a live server's pending approval and expires one whose run is over", () => {
    const { db } = setup();
    // r_ui now belongs to another server that is still running.
    db.run(
      sql`UPDATE runs SET owner_pid = ${LIVE_CLI.pid}, owner_started_at = ${LIVE_CLI.startedAt} WHERE id = 'r_ui'`,
    );
    insertRun(db, {
      id: "r_done",
      conversationId: "c_ui",
      source: "ui",
      mode: "interactive",
      model: "claude-sonnet-5",
      effort: "medium",
      userMessageId: null,
      assistantMessageId: null,
      policy: DEFAULT_POLICY,
      connections: [],
      startedAt: T0,
      owner: OLD_SERVER,
    });
    finishRun(db, "r_done", {
      status: "completed",
      finishedAt: T0,
      stopReason: null,
      terminalReason: "completed",
      error: null,
    });
    insertPendingApproval(db, {
      id: "apr_dangling",
      runId: "r_done",
      conversationId: "c_ui",
      toolUseId: "toolu_other",
      descriptor: refundDescriptor(),
      requestedAt: T0,
      expiresAt: refundDescriptor().expiresAt,
    });
    expect(recoverAfterRestart(db, boot)).toEqual({ runs: 0, toolCalls: 0, approvals: 1 });
    expect(getApproval(db, "apr_1")?.status).toBe("pending");
    expect(getApproval(db, "apr_dangling")).toMatchObject({
      status: "expired",
      decidedBy: "restart",
    });
  });
});

describe("recoverOrphanedRuns", () => {
  it("keeps a run this process still runs and recovers one it no longer runs", () => {
    const { db } = setup();
    db.run(
      sql`UPDATE runs SET owner_pid = ${SELF.pid}, owner_started_at = ${SELF.startedAt} WHERE id = 'r_ui'`,
    );
    const options = { now: BOOT, self: SELF, probe: CLI_ALIVE };
    expect(recoverOrphanedRuns(db, { ...options, runsLocally: (id) => id === "r_ui" }).runs).toBe(
      0,
    );
    expect(getRun(db, "r_ui")?.status).toBe("running");
    expect(recoverOrphanedRuns(db, { ...options, runsLocally: () => false }).runs).toBe(1);
    expect(getRun(db, "r_ui")?.status).toBe("failed");
  });

  it("touches only the conversation it is given", () => {
    const { db } = setup();
    const options = { now: BOOT, self: SELF, probe: NOTHING_ALIVE };
    expect(recoverOrphanedRuns(db, { ...options, conversationId: "c_cli" }).runs).toBe(1);
    expect(getRun(db, "r_cli")?.status).toBe("failed");
    expect(getRun(db, "r_ui")?.status).toBe("running");
    // The approval of the untouched run stays pending.
    expect(getApproval(db, "apr_1")?.status).toBe("pending");
  });

  it("leaves the conversation busy while another of its runs is still going", () => {
    const { db } = setup();
    insertRun(db, {
      id: "r_cli_2",
      conversationId: "c_cli",
      source: "cli",
      mode: "headless",
      model: "claude-sonnet-5",
      effort: "medium",
      userMessageId: null,
      assistantMessageId: null,
      policy: DEFAULT_POLICY,
      connections: [],
      startedAt: BOOT,
      owner: OLD_SERVER,
    });
    // r_cli_2's owner is gone, r_cli's (the live CLI) is not.
    expect(recoverOrphanedRuns(db, { now: BOOT, self: SELF, probe: CLI_ALIVE }).runs).toBe(2);
    expect(getRun(db, "r_cli_2")?.status).toBe("failed");
    expect(getConversation(db, "c_cli")?.status).toBe("running");
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
