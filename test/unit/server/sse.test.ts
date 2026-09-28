// The SSE heartbeat (src/server/sse.ts): while a run's stream is open, every
// attached client gets an SSE comment on a fixed interval, also while an
// approval waits; comments stop when the run ends or the client leaves, and
// the AI SDK's own client parses a stream that carries them.

import { DefaultChatTransport, readUIMessageStream } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../../../src/contracts/api.js";
import { SSE_HEARTBEAT, withHeartbeat } from "../../../src/server/sse.js";
import {
  cleanupAll,
  createTestServer,
  heldScript,
  ORIGIN,
  readSse,
  refundScript,
  type TestServer,
  userMessage,
  waitFor,
} from "./harness.js";

afterEach(cleanupAll);

const HEARTBEAT_MS = 20;

/** Reads a body as text as it arrives, until `until` holds for the text so far. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (text: string) => boolean,
  initial = "",
): Promise<string> {
  const decoder = new TextDecoder();
  let text = initial;
  while (!until(text)) {
    const next = await reader.read();
    if (next.done) return text;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

const count = (text: string, piece: string) => text.split(piece).length - 1;

function activeRun(server: TestServer) {
  const runId = server.core?.inputs.at(-1)?.runId ?? "";
  const run = server.services.registry.get(runId);
  if (run === undefined) throw new Error("no active run");
  return run;
}

describe("withHeartbeat", () => {
  it("adds comment events between the source's events and stops when the source ends", async () => {
    let push: (event: string) => void = () => {};
    let end: () => void = () => {};
    const source = new ReadableStream<string>({
      start(controller) {
        push = (event) => controller.enqueue(event);
        end = () => controller.close();
      },
    });
    const reader = withHeartbeat(source, HEARTBEAT_MS).getReader();
    const read: string[] = [];
    const reading = (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        read.push(next.value);
      }
    })();
    push("data: 1\n\n");
    await waitFor(() => read.filter((event) => event === SSE_HEARTBEAT).length >= 2);
    push("data: 2\n\n");
    end();
    await reading;
    expect(read[0]).toBe("data: 1\n\n");
    expect(read.at(-1)).toBe("data: 2\n\n");
    const afterEnd = read.length;
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 3));
    expect(read).toHaveLength(afterEnd);
  });

  it("stops and cancels its source when the reader goes away", async () => {
    let cancelled: unknown = null;
    const source = new ReadableStream<string>({
      cancel(reason) {
        cancelled = reason;
      },
    });
    const stream = withHeartbeat(source, HEARTBEAT_MS);
    const reader = stream.getReader();
    expect((await reader.read()).value).toBe(SSE_HEARTBEAT);
    await reader.cancel("client left");
    expect(cancelled).toBe("client left");
  });
});

describe("the run stream's heartbeat", () => {
  it("beats while an approval waits, on every attached stream, and ends with the run", async () => {
    const server = createTestServer({ script: refundScript, sseHeartbeatMs: HEARTBEAT_MS });
    const conversationId = await server.createConversation();
    const response = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Refund the duplicate"),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    // The approval card, then heartbeats while nobody decides.
    let text = await readUntil(reader, (so) => so.includes("tool-approval-request"));
    const before = count(text, SSE_HEARTBEAT);
    text = await readUntil(reader, (so) => count(so, SSE_HEARTBEAT) >= before + 2, text);

    // A second client (a reload) gets the replay and its own heartbeats.
    const second = await server.request("GET", `/api/chat/${conversationId}/stream`);
    const secondReader = second.body?.getReader();
    if (secondReader === undefined) throw new Error("no body");
    const secondText = await readUntil(secondReader, (so) => count(so, SSE_HEARTBEAT) >= 2);
    expect(secondText).toContain("tool-approval-request");

    const approvalId = activeRun(server).channel.buffered.find(
      (chunk) => chunk.type === "tool-approval-request",
    );
    if (approvalId?.type !== "tool-approval-request") throw new Error("no approval chunk");
    const decided = await server.request("POST", `/api/approvals/${approvalId.approvalId}`, {
      approved: true,
    });
    expect(decided.status).toBe(200);
    text = await readUntil(reader, () => false, text);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    await readUntil(secondReader, () => false, secondText);

    // Every event is either data or the comment; the chunks are the usual ones.
    const events = text.split("\n\n").filter((event) => event !== "");
    expect(
      events.every((event) => event.startsWith("data: ") || `${event}\n\n` === SSE_HEARTBEAT),
    ).toBe(true);
    const { chunks, done } = await readSse(new Response(text));
    expect(done).toBe(true);
    expect(chunks.at(-1)?.type).toBe("finish");
  });

  it("is parsed by the AI SDK's client transport and reducer", async () => {
    const held = heldScript();
    const server = createTestServer({ script: held.script, sseHeartbeatMs: HEARTBEAT_MS });
    const conversationId = await server.createConversation();
    const transport = new DefaultChatTransport<ChatUIMessage>({
      api: `${ORIGIN}/api/chat`,
      fetch: server.fetch,
      prepareSendMessagesRequest: ({ id, messages }) => ({
        body: { conversationId: id, message: messages.at(-1) },
      }),
    });
    const stream = await transport.sendMessages({
      chatId: conversationId,
      messages: [userMessage("u1", "Wait")],
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
    });
    // Let several heartbeats through before the run ends.
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 5));
    held.release();
    let final: ChatUIMessage | undefined;
    for await (const snapshot of readUIMessageStream<ChatUIMessage>({ stream })) final = snapshot;
    expect(final?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "Done waiting.",
    ]);
  });
});
