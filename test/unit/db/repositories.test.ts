// Repositories over the frozen schema, on a real SQLite file (WAL, foreign keys).

import { afterEach, describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../../../src/contracts/api.js";
import type { ApprovalDescriptor } from "../../../src/contracts/events.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import type { RevenueDeskDatabase } from "../../../src/db/client.js";
import {
  approvalCountsByRun,
  countPendingApprovalsForRun,
  expireAllPendingApprovals,
  getApproval,
  insertPendingApproval,
  listApprovalsForRun,
  pendingApprovalsForConversation,
  settleApproval,
} from "../../../src/db/repos/approvals.js";
import { readConnectionRows, saveConnectionStatus } from "../../../src/db/repos/connections.js";
import {
  addConversationUsage,
  conversationPage,
  conversationSummary,
  getConversation,
  insertConversation,
  listConversations,
  nameConversationIfBlank,
  setConversationSession,
  setConversationStatus,
  updateConversation,
} from "../../../src/db/repos/conversations.js";
import {
  getMessageRow,
  insertUserMessage,
  listMessages,
  messageText,
  replaceAssistantMessage,
  upsertAssistantMessage,
} from "../../../src/db/repos/messages.js";
import { decodeCursor, encodeCursor, likeContains } from "../../../src/db/repos/pagination.js";
import { policyViews, readSavedPolicies, savePolicies } from "../../../src/db/repos/policies.js";
import {
  finishRun,
  getRun,
  insertRun,
  listRuns,
  recordRunStarted,
  recordRunUsage,
  runDetailView,
  runningRunOf,
  runPage,
} from "../../../src/db/repos/runs.js";
import { readSettings, updateSettings } from "../../../src/db/repos/settings.js";
import {
  getToolCall,
  getToolCallByToolUseId,
  insertToolCall,
  interruptToolCalls,
  listToolCalls,
  markToolCallAwaitingApproval,
  markToolCallDecided,
  markToolCallDenied,
  markToolCallFinished,
  toolCallCountsByKind,
} from "../../../src/db/repos/tool-calls.js";
import { conversations, messages, runs, toolCalls } from "../../../src/db/schema.js";
import { seedDatabase } from "../../../src/db/seed.js";
import { cleanupAll, openTestDatabase } from "./support.js";

afterEach(cleanupAll);

const T0 = "2026-09-28T10:00:00.000Z";
const T1 = "2026-09-28T10:00:01.000Z";
const T2 = "2026-09-28T10:00:02.000Z";

function seeded(): RevenueDeskDatabase {
  const database = openTestDatabase();
  seedDatabase(database.db, T0);
  return database;
}

function conversation(database: RevenueDeskDatabase, id: string, now = T0, title = "") {
  return insertConversation(database.db, { id, title, source: "ui", now });
}

function run(database: RevenueDeskDatabase, id: string, conversationId: string, startedAt = T0) {
  insertRun(database.db, {
    id,
    conversationId,
    source: "ui",
    mode: "interactive",
    model: "claude-sonnet-5",
    effort: "medium",
    userMessageId: null,
    assistantMessageId: `${id}_assistant`,
    policy: DEFAULT_POLICY,
    connections: [],
    startedAt,
  });
}

function descriptor(): ApprovalDescriptor {
  return {
    actionClass: "financial",
    integration: "stripe",
    connectionKind: "api",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    consequence: "Refund $49.00 to Kestrel Analytics",
    facts: [{ label: "Amount", value: "$49.00" }],
    expiresAt: "2026-09-28T10:15:00.000Z",
  };
}

function toolCall(
  database: RevenueDeskDatabase,
  runId: string,
  toolUseId: string,
  kind: "api" | "mcp" = "api",
) {
  insertToolCall(database.db, {
    id: `row_${toolUseId}`,
    runId,
    conversationId: "c1",
    toolUseId,
    integration: kind === "api" ? "stripe" : "hubspot",
    connectionKind: kind,
    toolName: kind === "api" ? "mcp__stripe__create_refund" : "mcp__hubspot__hubspot-list-objects",
    operation: kind === "api" ? "stripe.refunds.create" : "hubspot.objects.list",
    actionClass: kind === "api" ? "financial" : "read",
    title: "A call",
    input: { charge: "ch_1" },
    startedAt: T0,
  });
}

describe("seed", () => {
  it("writes the default settings and DEFAULT_POLICY, and nothing else", () => {
    const database = seeded();
    expect(readSettings(database.db)).toMatchObject({
      companyName: "",
      agentName: "Revenue Desk",
      internalEmailDomains: [],
      allowedSlackChannels: [],
      timezone: "UTC",
      currency: "USD",
      defaultModel: null,
      defaultEffort: null,
      updatedAt: T0,
    });
    expect(readSavedPolicies(database.db)).toEqual(DEFAULT_POLICY);
    expect(database.db.select().from(conversations).all()).toEqual([]);
    expect(database.db.select().from(runs).all()).toEqual([]);
    expect(database.db.select().from(messages).all()).toEqual([]);
    expect(database.db.select().from(toolCalls).all()).toEqual([]);
  });

  it("is idempotent and never overwrites a changed row", () => {
    const database = seeded();
    updateSettings(database.db, { companyName: "Kestrel Ops" }, T1);
    savePolicies(database.db, { financial: "deny" }, T1);
    seedDatabase(database.db, T2);
    seedDatabase(database.db, T2);
    expect(readSettings(database.db)).toMatchObject({ companyName: "Kestrel Ops", updatedAt: T1 });
    expect(readSavedPolicies(database.db).financial).toBe("deny");
  });

  it("refuses to read settings before the seed", () => {
    const database = openTestDatabase();
    expect(() => readSettings(database.db)).toThrow(/seed the database/);
  });
});

describe("settings", () => {
  it("applies a partial update and keeps the rest", () => {
    const database = seeded();
    const updated = updateSettings(
      database.db,
      {
        internalEmailDomains: ["kestrel.test"],
        allowedSlackChannels: ["#billing"],
        notifySlackChannel: "#billing",
        defaultEffort: "high",
      },
      T1,
    );
    expect(updated).toMatchObject({
      companyName: "",
      internalEmailDomains: ["kestrel.test"],
      allowedSlackChannels: ["#billing"],
      notifySlackChannel: "#billing",
      defaultEffort: "high",
      updatedAt: T1,
    });
    expect(
      updateSettings(database.db, { notifySlackChannel: null }, T2).notifySlackChannel,
    ).toBeNull();
  });
});

describe("policies", () => {
  it("reports the source of each class and locks environment classes", () => {
    const views = policyViews({ ...DEFAULT_POLICY, outbound: "auto" }, { financial: "deny" });
    expect(views.map((view) => [view.actionClass, view.mode, view.source, view.locked])).toEqual([
      ["read", "auto", "default", false],
      ["internal_write", "auto", "default", false],
      ["outbound", "auto", "saved", false],
      ["financial", "deny", "environment", true],
      ["destructive", "deny", "default", false],
    ]);
  });

  it("upserts only the given classes", () => {
    const database = seeded();
    savePolicies(database.db, { outbound: "deny" }, T1);
    expect(readSavedPolicies(database.db)).toEqual({ ...DEFAULT_POLICY, outbound: "deny" });
  });
});

describe("connections", () => {
  it("upserts one row per integration with names only", () => {
    const database = seeded();
    saveConnectionStatus(
      database.db,
      {
        integration: "stripe",
        state: "not_configured",
        detail: "Not configured.",
        endpointLabel: null,
        accountHint: null,
        missing: ["STRIPE_SECRET_KEY"],
        checkedAt: null,
      },
      T0,
    );
    saveConnectionStatus(
      database.db,
      {
        integration: "stripe",
        state: "connected",
        detail: "Stripe connected",
        endpointLabel: "api.stripe.com",
        accountHint: "acc…c6M",
        missing: [],
        checkedAt: T1,
      },
      T1,
    );
    const row = readConnectionRows(database.db).get("stripe");
    expect(row).toMatchObject({
      kind: "api",
      profile: "stripe-api",
      status: "connected",
      endpointLabel: "api.stripe.com",
      missingVars: [],
      lastCheckedAt: T1,
    });
    expect(readConnectionRows(database.db).size).toBe(1);
  });
});

describe("conversations", () => {
  it("creates, renames, archives and restores", () => {
    const database = seeded();
    conversation(database, "c1");
    nameConversationIfBlank(database.db, "c1", "Duplicate charge", T1);
    nameConversationIfBlank(database.db, "c1", "Something else", T1);
    expect(getConversation(database.db, "c1")?.title).toBe("Duplicate charge");
    expect(updateConversation(database.db, "c1", { archived: true }, T2)?.archivedAt).toBe(T2);
    expect(
      updateConversation(database.db, "c1", { archived: false, title: "Refund" }, T2),
    ).toMatchObject({
      archivedAt: null,
      title: "Refund",
    });
    expect(updateConversation(database.db, "missing", { title: "x" }, T2)).toBeUndefined();
  });

  it("lists newest first, separates archived ones and pages with a cursor", () => {
    const database = seeded();
    for (let index = 0; index < 5; index += 1) {
      conversation(database, `c${index}`, `2026-09-28T10:00:0${index}.000Z`);
    }
    updateConversation(database.db, "c0", { archived: true }, "2026-09-28T09:00:00.000Z");
    const first = listConversations(database.db, { limit: 2 });
    expect(first.rows.map((row) => row.id)).toEqual(["c4", "c3"]);
    expect(first.nextCursor).not.toBeNull();
    const cursor = decodeCursor(first.nextCursor ?? "");
    const second = listConversations(database.db, { limit: 2, cursor: cursor ?? undefined });
    expect(second.rows.map((row) => row.id)).toEqual(["c2", "c1"]);
    expect(second.nextCursor).toBeNull();
    expect(listConversations(database.db, { archived: true }).rows.map((row) => row.id)).toEqual([
      "c0",
    ]);
  });

  it("searches titles and message text, treating % and _ literally", () => {
    const database = seeded();
    conversation(database, "c1", T0, "Kestrel duplicate charge");
    conversation(database, "c2", T1, "Weekly digest");
    conversation(database, "c3", T2, "100% refund");
    insertUserMessage(database.db, {
      id: "m1",
      conversationId: "c2",
      runId: null,
      parts: [{ type: "text", text: "Include the ACME invoice_42 please" }],
      now: T1,
    });
    const ids = (q: string) => listConversations(database.db, { q }).rows.map((row) => row.id);
    expect(ids("kestrel")).toEqual(["c1"]);
    expect(ids("acme")).toEqual(["c2"]);
    expect(ids("invoice_42")).toEqual(["c2"]);
    expect(ids("100%")).toEqual(["c3"]);
    expect(ids("0%")).toEqual(["c3"]);
    expect(ids("%")).toEqual(["c3"]);
    expect(ids("the_ACME")).toEqual([]);
    expect(likeContains("a%b_c\\")).toBe("%a\\%b\\_c\\\\%");
  });

  it("summarises the running run, pending approvals and usage totals", () => {
    const database = seeded();
    conversation(database, "c1");
    run(database, "r1", "c1");
    insertPendingApproval(database.db, {
      id: "a1",
      runId: "r1",
      conversationId: "c1",
      toolUseId: "toolu_1",
      descriptor: descriptor(),
      requestedAt: T0,
      expiresAt: descriptor().expiresAt,
    });
    setConversationStatus(database.db, "c1", "awaiting_approval", T1);
    setConversationSession(database.db, "c1", "sess_1");
    addConversationUsage(database.db, "c1", { costUsd: 0.5, inputTokens: 10, outputTokens: 5 });
    addConversationUsage(database.db, "c1", { costUsd: 0.25, inputTokens: 1, outputTokens: 1 });
    const row = getConversation(database.db, "c1");
    if (row === undefined) throw new Error("missing");
    expect(row).toMatchObject({ sdkSessionId: "sess_1", inputTokens: 11, outputTokens: 6 });
    expect(conversationSummary(database.db, row)).toEqual({
      id: "c1",
      title: "",
      source: "ui",
      status: "awaiting_approval",
      activeRunId: "r1",
      pendingApprovals: 1,
      totalCostUsd: 0.75,
      createdAt: T0,
      updatedAt: T1,
      archivedAt: null,
    });
    const page = conversationPage(database.db, {});
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});

describe("messages", () => {
  const assistant = (id: string, text: string): ChatUIMessage => ({
    id,
    role: "assistant",
    metadata: { runId: "r1", model: "claude-sonnet-5" },
    parts: [{ type: "step-start" }, { type: "text", text, state: "done" }],
  });

  it("orders messages by seq and keeps the assistant's seq across updates", () => {
    const database = seeded();
    conversation(database, "c1");
    run(database, "r1", "c1");
    insertUserMessage(database.db, {
      id: "u1",
      conversationId: "c1",
      runId: "r1",
      parts: [{ type: "text", text: "Why two charges?" }],
      now: T0,
    });
    upsertAssistantMessage(database.db, {
      conversationId: "c1",
      runId: "r1",
      message: assistant("a1", "Looking"),
      now: T1,
    });
    upsertAssistantMessage(database.db, {
      conversationId: "c1",
      runId: "r1",
      message: assistant("a1", "Found it"),
      now: T2,
    });
    insertUserMessage(database.db, {
      id: "u2",
      conversationId: "c1",
      runId: null,
      parts: [{ type: "text", text: "Thanks" }],
      now: T2,
    });
    expect(listMessages(database.db, "c1").map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
    expect(getMessageRow(database.db, "a1")).toMatchObject({
      seq: 1,
      text: "Found it",
      updatedAt: T2,
    });
    expect(listMessages(database.db, "c1", { exclude: new Set(["a1"]) }).map((m) => m.id)).toEqual([
      "u1",
      "u2",
    ]);
    const [user, reply] = listMessages(database.db, "c1");
    expect(user).toEqual({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Why two charges?" }],
    });
    expect(reply?.metadata).toEqual({ runId: "r1", model: "claude-sonnet-5" });
  });

  it("refuses to overwrite a message of another conversation", () => {
    const database = seeded();
    conversation(database, "c1");
    conversation(database, "c2");
    upsertAssistantMessage(database.db, {
      conversationId: "c1",
      runId: null,
      message: assistant("a1", "x"),
      now: T0,
    });
    expect(() =>
      upsertAssistantMessage(database.db, {
        conversationId: "c2",
        runId: null,
        message: assistant("a1", "y"),
        now: T1,
      }),
    ).toThrow(/another conversation/);
  });

  it("extracts the text parts for search and replaces parts in place", () => {
    expect(
      messageText([
        { type: "reasoning", text: "hidden", state: "done" },
        { type: "text", text: "First", state: "done" },
        { type: "text", text: "Second", state: "done" },
      ]),
    ).toBe("First\n\nSecond");
    const database = seeded();
    conversation(database, "c1");
    upsertAssistantMessage(database.db, {
      conversationId: "c1",
      runId: null,
      message: assistant("a1", "x"),
      now: T0,
    });
    replaceAssistantMessage(
      database.db,
      "a1",
      { parts: [{ type: "text", text: "Closed" }], metadata: undefined },
      T1,
    );
    expect(getMessageRow(database.db, "a1")).toMatchObject({
      text: "Closed",
      metadataJson: null,
      seq: 0,
    });
  });
});

describe("runs", () => {
  it("records start, usage and the finish once", () => {
    const database = seeded();
    conversation(database, "c1");
    run(database, "r1", "c1");
    expect(runningRunOf(database.db, "c1")?.id).toBe("r1");
    recordRunStarted(database.db, "r1", {
      model: "claude-opus-5",
      effort: "high",
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
      ],
    });
    const usage = {
      costUsd: 0.1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 1,
      numTurns: 2,
      modelRequests: 3,
      durationMs: 900,
      durationApiMs: 700,
    };
    expect(recordRunUsage(database.db, "r1", usage)).toBeNull();
    expect(recordRunUsage(database.db, "r1", { ...usage, costUsd: 0.2 })).toEqual(usage);
    expect(
      finishRun(database.db, "r1", {
        status: "failed",
        finishedAt: T1,
        stopReason: null,
        terminalReason: "model_error",
        error: { code: "model_error", message: "Overloaded" },
      }),
    ).toBe(true);
    expect(
      finishRun(database.db, "r1", {
        status: "completed",
        finishedAt: T2,
        stopReason: null,
        terminalReason: null,
        error: null,
      }),
    ).toBe(false);
    expect(getRun(database.db, "r1")).toMatchObject({
      status: "failed",
      model: "claude-opus-5",
      effort: "high",
      costUsd: 0.2,
      errorCode: "model_error",
      finishedAt: T1,
    });
    expect(runningRunOf(database.db, "c1")).toBeUndefined();
  });

  it("lists with filters and pages, and builds summary and detail views", () => {
    const database = seeded();
    conversation(database, "c1");
    conversation(database, "c2");
    run(database, "r1", "c1", T0);
    run(database, "r2", "c1", T1);
    run(database, "r3", "c2", T2);
    finishRun(database.db, "r1", {
      status: "completed",
      finishedAt: T1,
      stopReason: null,
      terminalReason: "completed",
      error: null,
    });
    toolCall(database, "r2", "toolu_a", "api");
    toolCall(database, "r2", "toolu_b", "mcp");
    toolCall(database, "r2", "toolu_c", "mcp");
    insertPendingApproval(database.db, {
      id: "a1",
      runId: "r2",
      conversationId: "c1",
      toolUseId: "toolu_a",
      descriptor: descriptor(),
      requestedAt: T1,
      expiresAt: descriptor().expiresAt,
    });

    expect(listRuns(database.db).rows.map((row) => row.id)).toEqual(["r3", "r2", "r1"]);
    expect(listRuns(database.db, { conversationId: "c1" }).rows.map((row) => row.id)).toEqual([
      "r2",
      "r1",
    ]);
    expect(listRuns(database.db, { status: "completed" }).rows.map((row) => row.id)).toEqual([
      "r1",
    ]);
    expect(listRuns(database.db, { source: "cli" }).rows).toEqual([]);
    const first = listRuns(database.db, { limit: 1 });
    const second = listRuns(database.db, {
      limit: 1,
      cursor: decodeCursor(first.nextCursor ?? "") ?? undefined,
    });
    expect(second.rows.map((row) => row.id)).toEqual(["r2"]);

    const page = runPage(database.db, { conversationId: "c1" });
    expect(page.items[0]).toMatchObject({
      id: "r2",
      status: "running",
      usage: null,
      toolCallsByKind: { composio: 0, mcp: 2, api: 1 },
      approvals: { pending: 1, approved: 0, denied: 0 },
      error: null,
    });
    const row = getRun(database.db, "r2");
    if (row === undefined) throw new Error("missing");
    const detail = runDetailView(database.db, row);
    expect(detail.toolCalls.map((call) => call.toolCallId)).toEqual([
      "toolu_a",
      "toolu_b",
      "toolu_c",
    ]);
    expect(detail.approvals.map((approval) => approval.id)).toEqual(["a1"]);
    expect(detail.policy).toEqual(DEFAULT_POLICY);
    expect(detail).not.toHaveProperty("approvals.pending");
  });

  it("round-trips cursors and refuses foreign ones", () => {
    expect(decodeCursor(encodeCursor({ at: T0, id: "x" }))).toEqual({ at: T0, id: "x" });
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from('{"at":1}').toString("base64url"))).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("tool calls", () => {
  function setup() {
    const database = seeded();
    conversation(database, "c1");
    run(database, "r1", "c1");
    return database;
  }

  it("records the lifecycle of an approved call", () => {
    const database = setup();
    toolCall(database, "r1", "toolu_1");
    toolCall(database, "r1", "toolu_1");
    expect(listToolCalls(database.db, "r1")).toHaveLength(1);
    markToolCallAwaitingApproval(database.db, { runId: "r1", toolUseId: "toolu_1" }, "a1");
    expect(getToolCallByToolUseId(database.db, "toolu_1")).toMatchObject({
      status: "awaiting_approval",
      approvalId: "a1",
      decision: "pending",
    });
    markToolCallDecided(database.db, { runId: "r1", toolUseId: "toolu_1" }, "approved");
    markToolCallFinished(
      database.db,
      { runId: "r1", toolUseId: "toolu_1" },
      {
        output: { id: "re_1" },
        truncated: false,
        isError: false,
        errorCode: null,
        errorMessage: null,
        httpStatus: 200,
        upstreamTool: "POST /v1/refunds",
        idempotencyKey: "idem",
        durationMs: 12.4,
        finishedAt: T1,
      },
    );
    const [view] = listToolCalls(database.db, "r1");
    expect(view).toMatchObject({
      toolCallId: "toolu_1",
      status: "succeeded",
      decision: "approved",
      input: { charge: "ch_1" },
      output: { id: "re_1" },
      error: null,
      httpStatus: 200,
      upstreamTool: "POST /v1/refunds",
      idempotencyKey: "idem",
      durationMs: 12,
      finishedAt: T1,
    });
  });

  it("marks an unasked call auto, failures with their error, and denials", () => {
    const database = setup();
    toolCall(database, "r1", "toolu_auto");
    markToolCallFinished(
      database.db,
      { runId: "r1", toolUseId: "toolu_auto" },
      {
        output: { error: "declined" },
        truncated: true,
        isError: true,
        errorCode: "card_declined",
        errorMessage: "Your card was declined.",
        httpStatus: 402,
        upstreamTool: null,
        idempotencyKey: null,
        durationMs: 5,
        finishedAt: T1,
      },
    );
    expect(getToolCallByToolUseId(database.db, "toolu_auto")).toMatchObject({
      decision: "auto",
      status: "failed",
      truncated: true,
    });
    expect(listToolCalls(database.db, "r1")[0]?.error).toEqual({
      provider: "stripe",
      status: 402,
      code: "card_declined",
      message: "Your card was declined.",
    });

    toolCall(database, "r1", "toolu_policy");
    markToolCallDenied(
      database.db,
      { runId: "r1", toolUseId: "toolu_policy" },
      {
        decision: "policy_denied",
        reason: "Denied by policy",
        finishedAt: T1,
      },
    );
    expect(getToolCallByToolUseId(database.db, "toolu_policy")).toMatchObject({
      status: "denied",
      decision: "policy_denied",
      isError: false,
      outputJson: "Denied by policy",
      durationMs: 1000,
    });

    toolCall(database, "r1", "toolu_rejected");
    markToolCallDenied(
      database.db,
      { runId: "r1", toolUseId: "toolu_rejected" },
      {
        decision: "rejected",
        reason: "amount: required",
        finishedAt: T1,
      },
    );
    expect(getToolCallByToolUseId(database.db, "toolu_rejected")).toMatchObject({
      status: "failed",
      decision: "rejected",
      isError: true,
      errorMessage: "amount: required",
    });
  });

  it("never lets one run's events change another run's call with the same tool_use id", () => {
    const database = setup();
    run(database, "r2", "c1", T1);
    toolCall(database, "r1", "toolu_same");
    markToolCallAwaitingApproval(database.db, { runId: "r1", toolUseId: "toolu_same" }, "a1");
    insertToolCall(database.db, {
      id: "row_toolu_same_r2",
      runId: "r2",
      conversationId: "c1",
      toolUseId: "toolu_same",
      integration: "stripe",
      connectionKind: "api",
      toolName: "mcp__stripe__create_refund",
      operation: "stripe.refunds.create",
      actionClass: "financial",
      title: "A call",
      input: { charge: "ch_1" },
      startedAt: T1,
    });
    markToolCallDenied(
      database.db,
      { runId: "r2", toolUseId: "toolu_same" },
      {
        decision: "denied",
        reason: "No",
        finishedAt: T2,
      },
    );
    expect(listToolCalls(database.db, "r1")).toMatchObject([
      {
        toolCallId: "toolu_same",
        status: "awaiting_approval",
        decision: "pending",
        approvalId: "a1",
      },
    ]);
    expect(listToolCalls(database.db, "r2")).toMatchObject([
      { toolCallId: "toolu_same", status: "denied", decision: "denied", approvalId: null },
    ]);
    expect(getToolCall(database.db, { runId: "r1", toolUseId: "toolu_same" })?.status).toBe(
      "awaiting_approval",
    );
  });

  it("allows a rejected unknown tool without an integration", () => {
    const database = setup();
    insertToolCall(database.db, {
      id: "row_x",
      runId: "r1",
      conversationId: "c1",
      toolUseId: "toolu_x",
      integration: null,
      connectionKind: null,
      toolName: "mcp__nowhere__thing",
      operation: null,
      actionClass: null,
      title: "mcp__nowhere__thing",
      input: {},
      startedAt: T0,
    });
    markToolCallDenied(
      database.db,
      { runId: "r1", toolUseId: "toolu_x" },
      {
        decision: "rejected",
        reason: "Unknown tool",
        finishedAt: T1,
      },
    );
    expect(listToolCalls(database.db, "r1")[0]).toMatchObject({
      integration: null,
      decision: "rejected",
    });
    expect(toolCallCountsByKind(database.db, ["r1"]).get("r1")).toEqual({
      composio: 0,
      mcp: 0,
      api: 0,
    });
  });

  it("interrupts calls still in flight", () => {
    const database = setup();
    toolCall(database, "r1", "toolu_running");
    toolCall(database, "r1", "toolu_waiting");
    toolCall(database, "r1", "toolu_done");
    markToolCallAwaitingApproval(database.db, { runId: "r1", toolUseId: "toolu_waiting" }, "a1");
    markToolCallDenied(
      database.db,
      { runId: "r1", toolUseId: "toolu_done" },
      {
        decision: "denied",
        reason: "No",
        finishedAt: T1,
      },
    );
    expect(interruptToolCalls(database.db, "r1", T2)).toBe(2);
    expect(listToolCalls(database.db, "r1").map((call) => [call.toolCallId, call.status])).toEqual([
      ["toolu_running", "interrupted"],
      ["toolu_waiting", "interrupted"],
      ["toolu_done", "denied"],
    ]);
  });
});

describe("approvals", () => {
  it("settles a pending approval exactly once", () => {
    const database = seeded();
    conversation(database, "c1");
    run(database, "r1", "c1");
    insertPendingApproval(database.db, {
      id: "a1",
      runId: "r1",
      conversationId: "c1",
      toolUseId: "toolu_1",
      descriptor: descriptor(),
      requestedAt: T0,
      expiresAt: descriptor().expiresAt,
    });
    expect(countPendingApprovalsForRun(database.db, "r1")).toBe(1);
    expect(pendingApprovalsForConversation(database.db, "c1").map((a) => a.id)).toEqual(["a1"]);
    const settlement = {
      status: "approved" as const,
      decidedBy: "user" as const,
      reason: null,
      decidedAt: T1,
    };
    expect(settleApproval(database.db, "a1", settlement)).toBe(true);
    expect(settleApproval(database.db, "a1", { ...settlement, status: "denied" })).toBe(false);
    expect(settleApproval(database.db, "nope", settlement)).toBe(false);
    expect(getApproval(database.db, "a1")).toMatchObject({
      status: "approved",
      decidedBy: "user",
      decidedAt: T1,
    });
    expect(listApprovalsForRun(database.db, "r1")[0]).toMatchObject({
      id: "a1",
      toolCallId: "toolu_1",
      integration: "stripe",
      consequence: "Refund $49.00 to Kestrel Analytics",
      descriptor: descriptor(),
      status: "approved",
    });
    expect(pendingApprovalsForConversation(database.db, "c1")).toEqual([]);
  });

  it("counts decisions per run and expires every pending one at boot", () => {
    const database = seeded();
    conversation(database, "c1");
    run(database, "r1", "c1");
    for (const [id, status] of [
      ["a1", "approved"],
      ["a2", "denied"],
      ["a3", "cancelled"],
      ["a4", null],
    ] as const) {
      insertPendingApproval(database.db, {
        id,
        runId: "r1",
        conversationId: "c1",
        toolUseId: `toolu_${id}`,
        descriptor: descriptor(),
        requestedAt: T0,
        expiresAt: descriptor().expiresAt,
      });
      if (status !== null) {
        settleApproval(database.db, id, {
          status,
          decidedBy: status === "cancelled" ? "stop" : "user",
          reason: null,
          decidedAt: T1,
        });
      }
    }
    expect(approvalCountsByRun(database.db, ["r1"]).get("r1")).toEqual({
      pending: 1,
      approved: 1,
      denied: 2,
    });
    expect(expireAllPendingApprovals(database.db, T2, "Restarted")).toBe(1);
    expect(getApproval(database.db, "a4")).toMatchObject({
      status: "expired",
      decidedBy: "restart",
      reason: "Restarted",
      decidedAt: T2,
    });
  });
});
