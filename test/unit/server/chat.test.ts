// POST /api/chat and GET /api/chat/:id/stream end to end in process: the real
// AI SDK client transport (DefaultChatTransport: SSE parsing and chunk schema
// validation) and reducer (readUIMessageStream, as in useChat) against the
// real app, a real SQLite file and a scripted agent core.

import {
  DefaultChatTransport,
  type DynamicToolUIPart,
  isDynamicToolUIPart,
  readUIMessageStream,
  type UIMessageChunk,
} from "ai";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApiErrorBody,
  ChatUIMessage,
  ConversationDetail,
  RunDetailView,
} from "../../../src/contracts/api.js";
import type { AgentEvent, RunTurn } from "../../../src/contracts/events.js";
import { getApproval } from "../../../src/db/repos/approvals.js";
import { getConversation } from "../../../src/db/repos/conversations.js";
import { getMessageRow, listMessages, toChatMessage } from "../../../src/db/repos/messages.js";
import { getRun } from "../../../src/db/repos/runs.js";
import { getToolCallByToolUseId } from "../../../src/db/repos/tool-calls.js";
import { CORE_ENDED_EARLY_TEXT } from "../../../src/server/run-registry.js";
import {
  answerScript,
  askApproval,
  chunkTypes,
  cleanupAll,
  createTestServer,
  ev,
  heldScript,
  LOOKUP_CALL,
  ORIGIN,
  REFUND_CALL,
  readSse,
  reduce,
  refundDescriptor,
  refundScript,
  type Script,
  STOP_REASON,
  type TestServer,
  userMessage,
  waitFor,
} from "./harness.js";

afterEach(cleanupAll);

function transportFor(server: TestServer) {
  return new DefaultChatTransport<ChatUIMessage>({
    api: `${ORIGIN}/api/chat`,
    fetch: server.fetch,
    prepareSendMessagesRequest: ({ id, messages }) => ({
      body: { conversationId: id, message: messages.at(-1) },
    }),
  });
}

type Turn = {
  readonly chunks: UIMessageChunk[];
  readonly snapshots: ChatUIMessage[];
  readonly final: ChatUIMessage;
};

/** Reads a chunk stream with the useChat reducer; `onApproval` runs once when a card appears. */
async function consume(
  stream: ReadableStream<UIMessageChunk>,
  onApproval?: (approvalId: string, part: DynamicToolUIPart) => Promise<void> | void,
): Promise<Turn> {
  const [forRecord, forReducer] = stream.tee();
  const chunks: UIMessageChunk[] = [];
  const recording = (async () => {
    for await (const chunk of forRecord) chunks.push(chunk);
  })();
  const snapshots: ChatUIMessage[] = [];
  let asked = false;
  for await (const snapshot of readUIMessageStream<ChatUIMessage>({ stream: forReducer })) {
    snapshots.push(snapshot);
    for (const part of snapshot.parts) {
      if (asked || onApproval === undefined || !isDynamicToolUIPart(part)) continue;
      if (part.state !== "approval-requested" || part.approval.isAutomatic === true) continue;
      asked = true;
      await onApproval(part.approval.id, part);
    }
  }
  await recording;
  const final = snapshots.at(-1);
  if (final === undefined) throw new Error("the stream produced no message");
  return { chunks, snapshots, final };
}

async function sendTurn(
  server: TestServer,
  conversationId: string,
  text: string,
  onApproval?: (approvalId: string, part: DynamicToolUIPart) => Promise<void> | void,
  messageId = `u_${Math.random().toString(36).slice(2)}`,
): Promise<Turn> {
  const stream = await transportFor(server).sendMessages({
    chatId: conversationId,
    messages: [userMessage(messageId, text)],
    trigger: "submit-message",
    messageId: undefined,
    abortSignal: undefined,
  });
  return consume(stream, onApproval);
}

async function decide(server: TestServer, approvalId: string, approved: boolean, reason?: string) {
  const response = await server.request("POST", `/api/approvals/${approvalId}`, {
    approved,
    ...(reason === undefined ? {} : { reason }),
  });
  expect(response.status).toBe(200);
}

function activeRunDone(server: TestServer): Promise<void> {
  const runs =
    server.core?.inputs.map((input) => server.services.registry.get(input.runId)?.done) ?? [];
  return Promise.all(runs).then(() => undefined);
}

function persistedAssistant(server: TestServer, runId: string): ChatUIMessage {
  const run = getRun(server.services.db, runId);
  const row = run?.assistantMessageId
    ? getMessageRow(server.services.db, run.assistantMessageId)
    : undefined;
  if (row === undefined) throw new Error("no persisted assistant message");
  return toChatMessage(row);
}

const S1_HEAD = [
  "start",
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
];

describe("POST /api/chat: the refund turn", () => {
  it("streams the S1 sequence, holds the approval on the server and persists what the client renders", async () => {
    const server = createTestServer({
      script: refundScript,
      integrations: { configuration: { stripe: "configured" } },
    });
    const conversationId = await server.createConversation();

    const turn = await sendTurn(
      server,
      conversationId,
      "Refund Kestrel's duplicate charge, please.",
      async (approvalId) => {
        const runId = server.core?.inputs[0]?.runId ?? "";
        // Persisted with its request: a reloaded page can show the card.
        const pending = persistedAssistant(server, runId);
        expect(pending.parts.find(isDynamicToolUIPart)?.state).toBe("approval-requested");
        expect(getApproval(server.services.db, approvalId)).toMatchObject({
          status: "pending",
        });
        expect(getConversation(server.services.db, conversationId)?.status).toBe(
          "awaiting_approval",
        );
        expect(getToolCallByToolUseId(server.services.db, REFUND_CALL.id)).toMatchObject({
          status: "awaiting_approval",
          approvalId: "apr_refund_1",
        });
        // The detail leaves the in-flight message to the stream's replay, and
        // lists the pending approval so the page can decide it.
        const detail = (await (
          await server.request("GET", `/api/conversations/${conversationId}`)
        ).json()) as ConversationDetail;
        expect(detail.messages.map((message) => message.role)).toEqual(["user"]);
        expect(detail.pendingApprovals.map((approval) => approval.id)).toEqual(["apr_refund_1"]);
        expect(detail.conversation).toMatchObject({
          status: "awaiting_approval",
          activeRunId: runId,
          pendingApprovals: 1,
        });
        await decide(server, approvalId, true);
      },
    );

    // The chunk order proven by S1 (plus the notice and transient chunks).
    expect(
      chunkTypes(turn.chunks).filter(
        (type) => type !== "data-notice" && type !== "data-status" && type !== "data-progress",
      ),
    ).toEqual([
      ...S1_HEAD,
      "tool-output-available",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "data-usage",
      "message-metadata",
      "finish",
    ]);
    const tool = turn.final.parts.find(isDynamicToolUIPart);
    expect(tool).toMatchObject({
      state: "output-available",
      toolName: REFUND_CALL.toolName,
      title: REFUND_CALL.title,
      toolMetadata: REFUND_CALL.tool,
      input: REFUND_CALL.input,
      output: { id: "re_1", status: "succeeded", amount: 4900 },
      approval: {
        id: "apr_refund_1",
        approved: true,
        requestReason: "Refund $49.00 to Kestrel Analytics",
      },
    });

    await activeRunDone(server);
    const input = server.core?.inputs[0];
    if (input === undefined) throw new Error("the core did not run");
    // Reducer equality: the persisted message is exactly what the client rendered.
    const persisted = persistedAssistant(server, input.runId);
    expect(persisted).toEqual({
      id: turn.final.id,
      role: "assistant",
      metadata: turn.final.metadata,
      parts: turn.final.parts,
    });
    expect(turn.final.metadata).toMatchObject({
      runId: input.runId,
      status: "completed",
      usage: { costUsd: 0.0123 },
    });

    const { db } = server.services;
    expect(getRun(db, input.runId)).toMatchObject({
      status: "completed",
      source: "ui",
      mode: "interactive",
      costUsd: 0.0123,
      numTurns: 2,
      terminalReason: "completed",
      userMessageId: expect.any(String),
      assistantMessageId: turn.final.id,
    });
    expect(getToolCallByToolUseId(db, REFUND_CALL.id)).toMatchObject({
      status: "succeeded",
      decision: "approved",
      integration: "stripe",
      connectionKind: "api",
      operation: "stripe.refunds.create",
      actionClass: "financial",
      outputJson: { id: "re_1", status: "succeeded", amount: 4900 },
      httpStatus: 200,
      upstreamTool: "POST /v1/refunds",
      idempotencyKey: "idem_1",
    });
    expect(getApproval(db, "apr_refund_1")).toMatchObject({
      status: "approved",
      decidedBy: "user",
      reason: null,
    });
    expect(getConversation(db, conversationId)).toMatchObject({
      status: "idle",
      title: "Refund Kestrel's duplicate charge, please.",
      sdkSessionId: "sess_refund",
      totalCostUsd: 0.0123,
      inputTokens: 1200,
      outputTokens: 340,
    });

    // Once the run is over, the conversation lists the message the client saw.
    const detail = (await (
      await server.request("GET", `/api/conversations/${conversationId}`)
    ).json()) as ConversationDetail;
    expect(detail.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1]).toEqual(persisted);
    expect(detail.pendingApprovals).toEqual([]);

    const run = (await (
      await server.request("GET", `/api/runs/${input.runId}`)
    ).json()) as RunDetailView;
    expect(run).toMatchObject({
      status: "completed",
      toolCallsByKind: { composio: 0, mcp: 0, api: 1 },
      toolCalls: [expect.objectContaining({ toolCallId: REFUND_CALL.id, decision: "approved" })],
      approvals: [expect.objectContaining({ id: "apr_refund_1", status: "approved" })],
    });
  });

  it("records a denial with the user's reason", async () => {
    const server = createTestServer({ script: refundScript });
    const conversationId = await server.createConversation();
    const turn = await sendTurn(server, conversationId, "Refund it", (approvalId) =>
      decide(server, approvalId, false, "Wrong customer"),
    );
    expect(chunkTypes(turn.chunks)).toEqual(
      expect.arrayContaining(["tool-approval-response", "tool-output-denied"]),
    );
    expect(turn.final.parts.find(isDynamicToolUIPart)).toMatchObject({
      state: "output-denied",
      approval: { approved: false, reason: "Wrong customer" },
    });
    await activeRunDone(server);
    const { db } = server.services;
    expect(getApproval(db, "apr_refund_1")).toMatchObject({
      status: "denied",
      decidedBy: "user",
      reason: "Wrong customer",
    });
    expect(getToolCallByToolUseId(db, REFUND_CALL.id)).toMatchObject({
      status: "denied",
      decision: "denied",
    });
    const runId = server.core?.inputs[0]?.runId ?? "";
    expect(persistedAssistant(server, runId).parts).toEqual(turn.final.parts);
  });

  it("times an approval out and records it as expired", async () => {
    const script: Script = async function* (input) {
      yield ev.started(input);
      yield { type: "step.start" };
      yield* ev.toolInput(REFUND_CALL);
      yield { type: "step.finish" };
      const outcome = yield* askApproval(input, REFUND_CALL.id, "apr_short", refundDescriptor(30));
      yield {
        type: "tool.denied",
        toolCallId: REFUND_CALL.id,
        decision: "timed_out",
        reason: outcome.reason ?? "",
      };
      yield ev.finished("completed");
    };
    const server = createTestServer({ script });
    const conversationId = await server.createConversation();
    const turn = await sendTurn(server, conversationId, "Refund it");
    expect(turn.final.parts.find(isDynamicToolUIPart)).toMatchObject({
      state: "output-denied",
      approval: { approved: false },
    });
    await activeRunDone(server);
    expect(getApproval(server.services.db, "apr_short")).toMatchObject({
      status: "expired",
      decidedBy: "timeout",
    });
    expect(getToolCallByToolUseId(server.services.db, REFUND_CALL.id)).toMatchObject({
      decision: "timed_out",
    });
    expect(
      (await server.request("POST", "/api/approvals/apr_short", { approved: true })).status,
    ).toBe(409);
  });

  it("maps policy denials and rejected calls, and records them in the action log", async () => {
    const script: Script = async function* (input) {
      yield ev.started(input);
      yield { type: "step.start" };
      yield* ev.toolInput(REFUND_CALL);
      yield* ev.toolInput({
        ...LOOKUP_CALL,
        id: "toolu_bad",
        toolName: "mcp__nowhere__x",
        title: "mcp__nowhere__x",
        tool: null,
      });
      yield { type: "step.finish" };
      yield {
        type: "tool.denied",
        toolCallId: REFUND_CALL.id,
        decision: "policy_denied",
        reason: "Financial actions are denied.",
      };
      yield {
        type: "tool.denied",
        toolCallId: "toolu_bad",
        decision: "rejected",
        reason: "Unknown tool.",
      };
      yield ev.finished("completed");
    };
    const server = createTestServer({
      script,
      runtime: { policyOverrides: { financial: "deny" } },
    });
    const conversationId = await server.createConversation();
    const turn = await sendTurn(server, conversationId, "Refund it");
    const parts = turn.final.parts.filter(isDynamicToolUIPart);
    expect(parts.map((part) => part.state)).toEqual(["output-denied", "output-error"]);
    expect(parts[0]?.approval).toMatchObject({
      isAutomatic: true,
      approved: false,
      reason: "Financial actions are denied.",
    });
    await activeRunDone(server);
    const { db } = server.services;
    expect(getToolCallByToolUseId(db, REFUND_CALL.id)).toMatchObject({
      status: "denied",
      decision: "policy_denied",
    });
    expect(getToolCallByToolUseId(db, "toolu_bad")).toMatchObject({
      status: "failed",
      decision: "rejected",
      integration: null,
      isError: true,
    });
    expect(server.core?.inputs[0]?.policy.financial).toBe("deny");
  });
});

describe("runs outlive their HTTP connections", () => {
  it("replays the active run to a reconnecting client, keeps running after a disconnect, then streams live", async () => {
    const server = createTestServer({ script: refundScript });
    const conversationId = await server.createConversation();
    const transport = transportFor(server);

    // First client: reads until the approval card appears, then disconnects.
    const first = await transport.sendMessages({
      chatId: conversationId,
      messages: [userMessage("u1", "Refund it")],
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
    });
    const firstReader = first.getReader();
    const firstChunks: UIMessageChunk[] = [];
    while (!firstChunks.some((chunk) => chunk.type === "tool-approval-request")) {
      const { done, value } = await firstReader.read();
      if (done) throw new Error("the stream ended before the approval");
      firstChunks.push(value);
    }
    await firstReader.cancel();

    // A reconnect (useChat resume) replays from the start of the message.
    const resumed = await transport.reconnectToStream({ chatId: conversationId });
    if (resumed === null) throw new Error("expected an active run to resume");
    const runId = server.core?.inputs[0]?.runId ?? "";
    const turn = consume(resumed, async (approvalId, part) => {
      // The replayed card equals the one the first client saw.
      const beforeDisconnect = await reduce(firstChunks);
      expect(part).toEqual(beforeDisconnect?.parts.find(isDynamicToolUIPart));
      expect(server.services.registry.get(runId)?.channel.subscriberCount).toBe(1);
      await decide(server, approvalId, true);
    });
    const { final } = await turn;
    expect(final.parts.find(isDynamicToolUIPart)?.state).toBe("output-available");
    expect(final.metadata?.status).toBe("completed");

    await activeRunDone(server);
    expect(getRun(server.services.db, runId)?.status).toBe("completed");
    expect(persistedAssistant(server, runId)).toEqual({
      id: final.id,
      role: "assistant",
      metadata: final.metadata,
      parts: final.parts,
    });
  });

  it("answers 204 when the conversation has no active run", async () => {
    const server = createTestServer();
    const conversationId = await server.createConversation();
    const idle = await server.request("GET", `/api/chat/${conversationId}/stream`);
    expect(idle.status).toBe(204);
    expect(await idle.text()).toBe("");
    expect((await server.request("GET", "/api/chat/unknown/stream")).status).toBe(204);
    await sendTurn(server, conversationId, "Hello");
    await activeRunDone(server);
    expect((await server.request("GET", `/api/chat/${conversationId}/stream`)).status).toBe(204);
    expect(await transportFor(server).reconnectToStream({ chatId: conversationId })).toBeNull();
  });

  it("serves the UI message stream headers and ends with [DONE]", async () => {
    const server = createTestServer();
    const conversationId = await server.createConversation();
    const response = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Hello"),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const { chunks, done } = await readSse(response);
    expect(done).toBe(true);
    expect(chunks[0]).toMatchObject({
      type: "start",
      messageMetadata: { model: "claude-sonnet-5" },
    });
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });
});

describe("POST /api/runs/:id/stop", () => {
  it("stops a run waiting for approval: approval cancelled, call stopped, stream aborted", async () => {
    const server = createTestServer({ script: refundScript });
    const conversationId = await server.createConversation();
    let runId = "";
    const turn = await sendTurn(server, conversationId, "Refund it", async () => {
      runId = server.core?.inputs[0]?.runId ?? "";
      const stop = await server.request("POST", `/api/runs/${runId}/stop`);
      expect(stop.status).toBe(202);
    });
    expect(turn.chunks.at(-1)).toEqual({ type: "abort", reason: "user" });
    expect(turn.final.parts.find(isDynamicToolUIPart)).toMatchObject({
      state: "output-denied",
      approval: { approved: false, reason: STOP_REASON },
    });
    expect(turn.final.metadata?.status).toBe("cancelled");

    await activeRunDone(server);
    const { db } = server.services;
    expect(getRun(db, runId)).toMatchObject({ status: "cancelled", stopReason: "user" });
    expect(getApproval(db, "apr_refund_1")).toMatchObject({
      status: "cancelled",
      decidedBy: "stop",
    });
    expect(getToolCallByToolUseId(db, REFUND_CALL.id)).toMatchObject({
      status: "denied",
      decision: "stopped",
    });
    expect(getConversation(db, conversationId)?.status).toBe("idle");
    expect(server.core?.inputs[0]?.signal.reason).toBe("user");
    expect(persistedAssistant(server, runId).parts).toEqual(turn.final.parts);
  });

  it("closes a run whose core ignores Stop after the grace period", async () => {
    const stubborn: RunTurn = async function* (input) {
      yield ev.started(input);
      yield { type: "step.start" };
      yield* ev.text("t1", "Working");
      await new Promise(() => {});
    };
    const server = createTestServer({ runTurn: stubborn, stopGraceMs: 30 });
    const conversationId = await server.createConversation();
    const response = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Go"),
    });
    const run = server.services.registry.forConversation(conversationId);
    if (run === undefined) throw new Error("no active run");
    await waitFor(() => run.channel.buffered.some((chunk) => chunk.type === "text-end"));
    expect((await server.request("POST", `/api/runs/${run.runId}/stop`)).status).toBe(202);
    const { chunks } = await readSse(response);
    expect(chunks.at(-1)).toEqual({ type: "abort", reason: "user" });
    await run.done;
    expect(getRun(server.services.db, run.runId)).toMatchObject({
      status: "cancelled",
      stopReason: "user",
    });
    expect(server.logs.join("\n")).toMatch(/did not stop in time/);
    expect(server.services.registry.size).toBe(0);
  });
});

describe("limits", () => {
  it("allows one active run per conversation (409) and four at once (429)", async () => {
    const held = heldScript();
    const server = createTestServer({ script: held.script });
    const conversations = await Promise.all([1, 2, 3, 4, 5].map(() => server.createConversation()));
    const responses: Response[] = [];
    for (const [index, conversationId] of conversations.slice(0, 4).entries()) {
      const response = await server.request("POST", "/api/chat", {
        conversationId,
        message: userMessage(`u${index}`, "Wait"),
      });
      expect(response.status).toBe(200);
      responses.push(response);
    }
    const again = await server.request("POST", "/api/chat", {
      conversationId: conversations[0],
      message: userMessage("u_again", "Again"),
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ApiErrorBody).error.code).toBe("run_active");
    const fifth = await server.request("POST", "/api/chat", {
      conversationId: conversations[4],
      message: userMessage("u_fifth", "Fifth"),
    });
    expect(fifth.status).toBe(429);
    expect(((await fifth.json()) as ApiErrorBody).error.code).toBe("too_many_runs");
    // The refused requests wrote nothing.
    expect(getMessageRow(server.services.db, "u_again")).toBeUndefined();
    expect(getMessageRow(server.services.db, "u_fifth")).toBeUndefined();

    held.release();
    await Promise.all(responses.map((response) => response.text()));
    await activeRunDone(server);
    expect(server.services.registry.size).toBe(0);
    const later = await server.request("POST", "/api/chat", {
      conversationId: conversations[4],
      message: userMessage("u_later", "Now"),
    });
    expect(later.status).toBe(200);
    await later.text();
  });

  it("refuses a turn on a conversation another process is running (the CLI)", async () => {
    const server = createTestServer();
    const conversationId = await server.createConversation();
    const first = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Hi"),
    });
    await first.text();
    await activeRunDone(server);
    server.database.sqlite
      .prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE conversation_id = ?")
      .run(conversationId);
    const response = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u2", "Hi"),
    });
    expect(response.status).toBe(409);
  });
});

describe("request validation", () => {
  it.each([
    [
      "an unknown conversation",
      { conversationId: "missing", message: userMessage("u1", "Hi") },
      404,
    ],
    [
      "a non-text part",
      {
        conversationId: "$",
        message: { id: "u1", role: "user", parts: [{ type: "file", url: "x" }] },
      },
      400,
    ],
    [
      "an assistant message",
      {
        conversationId: "$",
        message: { id: "u1", role: "assistant", parts: [{ type: "text", text: "x" }] },
      },
      400,
    ],
    ["no parts", { conversationId: "$", message: { id: "u1", role: "user", parts: [] } }, 400],
    ["only whitespace", { conversationId: "$", message: userMessage("u1", "   ") }, 400],
    ["a bad message id", { conversationId: "$", message: userMessage("../u1", "Hi") }, 400],
    ["no message", { conversationId: "$" }, 400],
  ])("refuses %s", async (_label, body, status) => {
    const server = createTestServer();
    const conversationId = await server.createConversation();
    const response = await server.request(
      "POST",
      "/api/chat",
      JSON.parse(JSON.stringify(body).replace('"$"', JSON.stringify(conversationId))),
    );
    expect(response.status).toBe(status);
    expect(server.core?.inputs).toEqual([]);
  });

  it("refuses a message id that was already sent", async () => {
    const server = createTestServer();
    const conversationId = await server.createConversation();
    await (
      await server.request("POST", "/api/chat", {
        conversationId,
        message: userMessage("u1", "Hi"),
      })
    ).text();
    await activeRunDone(server);
    const again = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Hi"),
    });
    expect(again.status).toBe(400);
  });
});

describe("the agent core's input and its failures", () => {
  it("passes the settings, policy, plans and the previous SDK session to the core", async () => {
    const server = createTestServer({
      script: refundScript,
      integrations: {
        configuration: { stripe: "configured", google_calendar: "configured" },
        probes: {
          google_calendar: {
            state: "needs_auth",
            detail: "Google Calendar is not connected",
            accountHint: null,
          },
        },
      },
    });
    await server.services.connections.checkAll();
    await server.request("PATCH", "/api/settings", {
      defaultModel: "claude-opus-5",
      companyName: "Kestrel Ops",
    });
    const conversationId = await server.createConversation();
    const first = await sendTurn(server, conversationId, "Refund it", (approvalId) =>
      decide(server, approvalId, true),
    );
    expect(
      first.final.parts
        .filter((part) => part.type === "data-notice")
        .map((part) => part.data.integration),
    ).toEqual(["gmail", "google_calendar", "hubspot", "quickbooks", "slack"]);
    await activeRunDone(server);
    await sendTurn(server, conversationId, "And the second one?", (approvalId) =>
      decide(server, approvalId, false),
    );
    await activeRunDone(server);

    const [one, two] = server.core?.inputs ?? [];
    expect(one).toMatchObject({
      mode: "interactive",
      source: "ui",
      prompt: "Refund it",
      resumeSessionId: null,
      businessDate: "2026-09-28",
      model: {
        model: "claude-opus-5",
        effort: "medium",
        thinkingDisplay: "summarized",
        maxTurns: 30,
      },
      settings: { companyName: "Kestrel Ops" },
      policy: { read: "auto", outbound: "ask", financial: "ask", destructive: "deny" },
    });
    expect(one?.connections.map((plan) => [plan.integration, plan.status])).toEqual([
      ["gmail", "unavailable"],
      ["google_calendar", "unavailable"],
      ["hubspot", "unavailable"],
      ["stripe", "available"],
      ["quickbooks", "unavailable"],
      ["slack", "unavailable"],
    ]);
    expect(two?.resumeSessionId).toBe("sess_refund");
    expect(listMessages(server.services.db, conversationId).map((message) => message.role)).toEqual(
      ["user", "assistant", "user", "assistant"],
    );
    const run = getRun(server.services.db, one?.runId ?? "");
    expect(
      run?.connectionsSnapshot.find((connection) => connection.integration === "google_calendar"),
    ).toMatchObject({
      availability: "unavailable",
      state: "needs_auth",
    });
  });

  it("fails the run when the core throws, with a sanitised error chunk", async () => {
    const throwing: RunTurn = async function* () {
      yield* [] as AgentEvent[];
      throw new Error("boom with Bearer abc.def");
    };
    const server = createTestServer({ runTurn: throwing });
    const conversationId = await server.createConversation();
    const response = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Hi"),
    });
    const { chunks, done } = await readSse(response);
    expect(done).toBe(true);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["start", "message-metadata", "error"]);
    expect(chunks.at(-1)).toEqual({ type: "error", errorText: CORE_ENDED_EARLY_TEXT });
    await waitFor(() => server.services.registry.size === 0);
    const runId = (chunks[0] as { messageMetadata: { runId: string } }).messageMetadata.runId;
    expect(getRun(server.services.db, runId)).toMatchObject({
      status: "failed",
      errorCode: "internal",
    });
    expect(getConversation(server.services.db, conversationId)?.status).toBe("error");
    expect(server.logs.join("\n")).toContain("Bearer [redacted]");
    expect(server.logs.join("\n")).not.toContain("abc.def");
    expect(persistedAssistant(server, runId).metadata?.status).toBe("failed");
  });

  it("fails the run when the core ends without run.finished", async () => {
    const early: RunTurn = async function* (input) {
      yield ev.started(input);
      yield { type: "step.start" };
      yield* ev.text("t1", "Partial");
    };
    const server = createTestServer({ runTurn: early });
    const conversationId = await server.createConversation();
    const turn = await sendTurn(server, conversationId, "Hi");
    expect(turn.chunks.at(-1)).toEqual({ type: "error", errorText: CORE_ENDED_EARLY_TEXT });
    // The open text part was closed before the error.
    expect(turn.final.parts.find((part) => part.type === "text")).toMatchObject({
      text: "Partial",
      state: "done",
    });
    expect(turn.final.metadata?.status).toBe("failed");
    await waitFor(() => server.services.registry.size === 0);
    const run = server.database.sqlite.prepare("SELECT status, error_code FROM runs").get();
    expect(run).toEqual({ status: "failed", error_code: "internal" });
  });

  it("reports a model failure the core finished with", async () => {
    const failing: Script = async function* (input) {
      yield ev.started(input);
      yield ev.finished("failed", {
        error: { code: "model_error", message: "The model is unavailable." },
      });
    };
    const server = createTestServer({ script: failing });
    const conversationId = await server.createConversation();
    const response = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Hi"),
    });
    const { chunks } = await readSse(response);
    expect(chunks.at(-1)).toEqual({ type: "error", errorText: "The model is unavailable." });
    await activeRunDone(server);
    const runId = server.core?.inputs[0]?.runId ?? "";
    expect(getRun(server.services.db, runId)).toMatchObject({
      status: "failed",
      errorCode: "model_error",
      errorMessage: "The model is unavailable.",
    });
  });

  it("names a conversation after its first message", async () => {
    const server = createTestServer({ script: answerScript });
    const conversationId = await server.createConversation();
    await sendTurn(
      server,
      conversationId,
      `\n\n  ${"Why was Kestrel charged twice ".repeat(4)}\nsecond line`,
    );
    await activeRunDone(server);
    const title = getConversation(server.services.db, conversationId)?.title ?? "";
    expect([...title]).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Why was Kestrel charged twice")).toBe(true);
  });
});
