// Spike S1: a server-held approval inside one AI SDK v7 UI message stream.
//
// The chat request goes through the real client transport (createChatTransport,
// so DefaultChatTransport's SSE parser and chunk schema validation) into the
// Hono app in process, and the chunks are reduced with readUIMessageStream,
// which runs the same processUIMessageStream reducer useChat uses.

import {
  type DynamicToolUIPart,
  isDynamicToolUIPart,
  readUIMessageStream,
  type UIMessageChunk,
} from "ai";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import {
  ApprovalWaiters,
  type ChatUIMessage,
  SPIKE_APPROVAL_DESCRIPTOR,
  SPIKE_TOOL_INPUT,
  SPIKE_TOOL_METADATA,
  SPIKE_TOOL_NAME,
  SPIKE_TOOL_OUTPUT,
  SPIKE_TOOL_TITLE,
  type SpikeRoutesOptions,
} from "../../src/server/ui-stream.js";
import { createChatTransport, submitApprovalDecision } from "../../web/src/lib/chat.js";

const ORIGIN = "http://revenue-desk.test";

type RunEnd = Parameters<NonNullable<SpikeRoutesOptions["onRunEnd"]>>[0];

function setup(spike: Omit<SpikeRoutesOptions, "onRunEnd"> = {}) {
  let resolveEnd: (event: RunEnd) => void = () => {};
  const runEnd = new Promise<RunEnd>((resolve) => {
    resolveEnd = resolve;
  });
  const waiters = spike.waiters ?? new ApprovalWaiters();
  const app = createApp({
    version: "0.0.0-test",
    spike: { chunkDelayMs: 0, ...spike, waiters, onRunEnd: (event) => resolveEnd(event) },
  });
  const fetchViaApp: typeof globalThis.fetch = async (input, init) =>
    app.request(input instanceof Request ? input : String(input), init);
  return { app, waiters, runEnd, fetchViaApp };
}

const USER_MESSAGE: ChatUIMessage = {
  id: "msg_user_1",
  role: "user",
  parts: [{ type: "text", text: "Refund the duplicate charge." }],
};

type Decide = (approvalId: string) => Promise<void> | void;

/** Runs one chat turn; `decide` is called once when the tool part asks for approval. */
async function runTurn(
  fetchViaApp: typeof globalThis.fetch,
  decide: Decide | undefined,
  abortSignal?: AbortSignal,
) {
  const transport = createChatTransport<ChatUIMessage>({
    api: `${ORIGIN}/api/spike/chat`,
    fetch: fetchViaApp,
  });
  const chunks = await transport.sendMessages({
    chatId: "conv_test",
    messages: [USER_MESSAGE],
    trigger: "submit-message",
    messageId: undefined,
    abortSignal,
  });
  const [forRecord, forReducer] = chunks.tee();

  const recorded: UIMessageChunk[] = [];
  const recording = (async () => {
    for await (const chunk of forRecord) recorded.push(chunk);
  })();

  const snapshots: ChatUIMessage[] = [];
  let decided = false;
  for await (const snapshot of readUIMessageStream<ChatUIMessage>({
    stream: forReducer,
    terminateOnError: true,
  })) {
    snapshots.push(snapshot);
    const tool = snapshot.parts.find(isDynamicToolUIPart);
    if (!decided && decide && tool?.state === "approval-requested") {
      decided = true;
      await decide(tool.approval.id);
    }
  }
  await recording;

  const final = snapshots.at(-1);
  if (!final) throw new Error("The stream produced no message");
  return { recorded, snapshots, final };
}

/** Chunk types in order, with consecutive repeats (deltas) collapsed. */
function chunkTypes(chunks: UIMessageChunk[]): string[] {
  return chunks.map((chunk) => chunk.type).filter((type, i, all) => type !== all[i - 1]);
}

/** The tool part's state after each reducer write, with repeats collapsed. */
function toolStates(snapshots: ChatUIMessage[]): string[] {
  return snapshots
    .map((snapshot) => snapshot.parts.find(isDynamicToolUIPart)?.state)
    .filter((state): state is DynamicToolUIPart["state"] => state !== undefined)
    .filter((state, i, all) => state !== all[i - 1]);
}

function toolPart(message: ChatUIMessage): DynamicToolUIPart {
  const part = message.parts.find(isDynamicToolUIPart);
  if (!part) throw new Error("No dynamic tool part in the message");
  return part;
}

const HEAD = [
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
const TAIL = ["start-step", "text-start", "text-delta", "text-end", "finish-step", "finish"];

describe("spike S1: approval held on the server inside one UI message stream", () => {
  it("approve: approval-requested, then approval-responded, then output-available", async () => {
    const { fetchViaApp, runEnd, waiters } = setup();
    const { recorded, snapshots, final } = await runTurn(fetchViaApp, (approvalId) =>
      submitApprovalDecision("/api/spike/approvals", { approvalId, approved: true }, fetchViaApp),
    );

    expect(chunkTypes(recorded)).toEqual([...HEAD, "tool-output-available", ...TAIL]);
    expect(toolStates(snapshots)).toEqual([
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
    ]);

    // The approval-requested snapshot carries the descriptor and request reason.
    const requested = snapshots
      .map((snapshot) => snapshot.parts.find(isDynamicToolUIPart))
      .find((part) => part?.state === "approval-requested");
    expect(requested?.approval).toEqual({
      id: expect.stringMatching(/^apr_/),
      descriptor: SPIKE_APPROVAL_DESCRIPTOR,
      requestReason: SPIKE_APPROVAL_DESCRIPTOR.consequence,
    });

    const tool = toolPart(final);
    expect(tool).toMatchObject({
      type: "dynamic-tool",
      toolName: SPIKE_TOOL_NAME,
      title: SPIKE_TOOL_TITLE,
      toolMetadata: SPIKE_TOOL_METADATA,
      state: "output-available",
      input: SPIKE_TOOL_INPUT,
      output: SPIKE_TOOL_OUTPUT,
      approval: {
        approved: true,
        descriptor: SPIKE_APPROVAL_DESCRIPTOR,
        requestReason: SPIKE_APPROVAL_DESCRIPTOR.consequence,
      },
    });
    expect(tool.approval?.reason).toBeUndefined();

    expect(final.metadata).toEqual({ runId: expect.stringMatching(/^run_/), model: "scripted" });
    expect(final.parts.map((part) => part.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "dynamic-tool",
      "step-start",
      "text",
    ]);
    expect(final.parts.at(-1)).toMatchObject({
      type: "text",
      state: "done",
      text: expect.stringContaining("Refunded $49.00 to Kestrel Analytics"),
    });

    // The server-side reduction (what gets persisted) matches what the client rendered.
    const end = await runEnd;
    expect(end.outcome).toEqual({ status: "completed" });
    expect(end.isAborted).toBe(false);
    expect(end.finishReason).toBe("stop");
    expect(end.responseMessage.id).toBe(final.id);
    expect(end.responseMessage.parts).toEqual(final.parts);
    expect(waiters.pendingCount).toBe(0);
  });

  it("deny: approval-responded with approved:false, then output-denied", async () => {
    const { fetchViaApp, runEnd } = setup();
    const { recorded, snapshots, final } = await runTurn(fetchViaApp, (approvalId) =>
      submitApprovalDecision(
        "/api/spike/approvals",
        { approvalId, approved: false, reason: "Wrong customer" },
        fetchViaApp,
      ),
    );

    expect(chunkTypes(recorded)).toEqual([...HEAD, "tool-output-denied", ...TAIL]);
    expect(toolStates(snapshots)).toEqual([
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-denied",
    ]);
    const tool = toolPart(final);
    expect(tool.state).toBe("output-denied");
    expect(tool.output).toBeUndefined();
    expect(tool.approval).toMatchObject({ approved: false, reason: "Wrong customer" });
    expect(final.parts.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("I did not refund the charge"),
    });
    expect((await runEnd).outcome).toEqual({ status: "completed" });
  });

  it("timeout: the server denies an unanswered approval and a late decision gets 409", async () => {
    const { fetchViaApp } = setup({ approvalTimeoutMs: 20 });
    const { final } = await runTurn(fetchViaApp, undefined);

    const tool = toolPart(final);
    expect(tool.state).toBe("output-denied");
    expect(tool.approval).toMatchObject({ approved: false, reason: "No decision within 20 ms." });
    expect(final.parts.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("no decision arrived in time"),
    });

    const late = await fetchViaApp(`${ORIGIN}/api/spike/approvals/${tool.approval?.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({
      error: { code: "already_decided", message: "This approval was already decided." },
    });
  });

  it("stop: aborting the request denies the pending approval and ends the run as aborted", async () => {
    const { fetchViaApp, runEnd, waiters } = setup();
    const controller = new AbortController();
    const { final } = await runTurn(fetchViaApp, () => controller.abort(), controller.signal);

    expect(waiters.pendingCount).toBe(0);
    const end = await runEnd;
    expect(end.outcome).toEqual({ status: "aborted" });
    expect(end.isAborted).toBe(true);
    expect(toolPart(end.responseMessage)).toMatchObject({
      state: "output-denied",
      approval: { approved: false, reason: "The run was stopped." },
    });
    // Nothing is written after the abort chunk.
    expect(final.parts.map((part) => part.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "dynamic-tool",
    ]);
  });
});

describe("spike S1 HTTP contract", () => {
  async function post(app: Hono, path: string, init: RequestInit = {}) {
    return app.request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...init,
    });
  }

  it("streams SSE with the UI message stream headers and ends with [DONE]", async () => {
    const { app } = setup({ approvalTimeoutMs: 1 });
    const response = await post(app, "/api/spike/chat", {
      body: JSON.stringify({ conversationId: "conv_1", message: USER_MESSAGE }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

    const events = (await response.text()).split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    for (const event of events.slice(0, -1)) {
      expect(event.startsWith("data: ")).toBe(true);
      expect(JSON.parse(event.slice("data: ".length))).toHaveProperty("type");
    }
  });

  it("rejects a malformed chat request with 400", async () => {
    const { app } = setup();
    const response = await post(app, "/api/spike/chat", {
      body: JSON.stringify({ messages: [USER_MESSAGE] }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown approval and 400 for a malformed decision", async () => {
    const { app } = setup();
    const unknown = await post(app, "/api/spike/approvals/apr_missing", {
      body: JSON.stringify({ approved: true }),
    });
    expect(unknown.status).toBe(404);

    const malformed = await post(app, "/api/spike/approvals/apr_missing", {
      body: JSON.stringify({ approved: "yes" }),
    });
    expect(malformed.status).toBe(400);
  });

  it("refuses non-JSON bodies (415) and cross-origin requests (403)", async () => {
    const { app } = setup();
    const form = await post(app, "/api/spike/approvals/apr_x", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "approved=true",
    });
    expect(form.status).toBe(415);

    const foreign = await post(app, "/api/spike/approvals/apr_x", {
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:4320",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ approved: true }),
    });
    expect(foreign.status).toBe(403);

    const sameOrigin = await post(app, "/api/spike/approvals/apr_x", {
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:4320",
        origin: "http://127.0.0.1:4320",
      },
      body: JSON.stringify({ approved: true }),
    });
    expect(sameOrigin.status).toBe(404);
  });
});

describe("ApprovalWaiters", () => {
  it("settles once: the first of decide, timeout or abort wins", async () => {
    const waiters = new ApprovalWaiters();
    const pending = waiters.wait("apr_1", { timeoutMs: 60_000 });
    expect(waiters.pendingCount).toBe(1);
    expect(waiters.decide("apr_1", { approved: true })).toBe("accepted");
    expect(waiters.decide("apr_1", { approved: false })).toBe("already_decided");
    await expect(pending).resolves.toEqual({ approved: true, decidedBy: "user" });
    expect(waiters.pendingCount).toBe(0);
    await expect(waiters.wait("apr_1", { timeoutMs: 1 })).rejects.toThrow(/already registered/);
  });

  it("denies with decidedBy 'stop' when the signal is already aborted", async () => {
    const waiters = new ApprovalWaiters();
    await expect(
      waiters.wait("apr_2", { timeoutMs: 60_000, signal: AbortSignal.abort() }),
    ).resolves.toEqual({ approved: false, reason: "The run was stopped.", decidedBy: "stop" });
  });

  it("forgets the oldest settled ids beyond its limit", async () => {
    const waiters = new ApprovalWaiters({ settledLimit: 1 });
    const first = waiters.wait("apr_a", { timeoutMs: 60_000 });
    waiters.decide("apr_a", { approved: true });
    await first;
    const second = waiters.wait("apr_b", { timeoutMs: 60_000 });
    waiters.decide("apr_b", { approved: true });
    await second;
    expect(waiters.decide("apr_a", { approved: true })).toBe("unknown");
    expect(waiters.decide("apr_b", { approved: true })).toBe("already_decided");
  });
});
