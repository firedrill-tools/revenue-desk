// The run's chunk feed (replay buffer and fan-out) and the server-side
// reducer that persists the assistant message.

import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../../../src/contracts/api.js";
import type { AgentEvent } from "../../../src/contracts/events.js";
import { ServerMessageReducer } from "../../../src/server/message-reducer.js";
import { RunChannel } from "../../../src/server/run-channel.js";
import { type ChatUIChunk, UIStreamMapper } from "../../../src/server/ui-stream.js";
import { ev, REFUND_CALL, reduce, refundDescriptor, testRedact } from "./harness.js";

async function collect(stream: ReadableStream<ChatUIChunk>): Promise<ChatUIChunk[]> {
  const chunks: ChatUIChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function refundChunks(): ChatUIChunk[] {
  const mapper = new UIStreamMapper({
    messageId: "msg_1",
    fallbackMetadata: { runId: "run_1", model: "m" },
    redact: testRedact,
  });
  const events: AgentEvent[] = [
    {
      type: "run.started",
      runId: "run_1",
      conversationId: "c1",
      source: "ui",
      mode: "interactive",
      model: "m",
      effort: "medium",
      startedAt: "2026-09-28T10:00:00.000Z",
      connections: [],
    },
    { type: "status", status: { phase: "requesting" } },
    { type: "step.start" },
    ...ev.reasoning("r1", "Check the duplicate charge first."),
    ...ev.text("t1", "I will refund the duplicate once you approve it."),
    ...ev.toolInput(REFUND_CALL),
    { type: "step.finish" },
    {
      type: "approval.requested",
      approvalId: "apr_1",
      toolCallId: REFUND_CALL.id,
      descriptor: refundDescriptor(),
    },
    {
      type: "approval.resolved",
      approvalId: "apr_1",
      toolCallId: REFUND_CALL.id,
      approved: true,
      decidedBy: "user",
      reason: null,
    },
    { type: "tool.progress", toolCallId: REFUND_CALL.id, elapsedMs: 10 },
    ev.output(REFUND_CALL.id, { id: "re_1" }),
    { type: "step.start" },
    ...ev.text("t2", "Refunded the duplicate charge."),
    { type: "step.finish" },
    ev.finished("completed"),
  ];
  return events.flatMap((event) => mapper.map(event));
}

describe("RunChannel", () => {
  it("replays from the start of the message to a late subscriber, then streams live", async () => {
    const chunks = refundChunks();
    const channel = new RunChannel();
    const early = collect(channel.subscribe());
    const middle = 20;
    for (const chunk of chunks.slice(0, middle)) channel.publish(chunk);
    const late = collect(channel.subscribe());
    for (const chunk of chunks.slice(middle)) channel.publish(chunk);
    channel.close();

    const earlyChunks = await early;
    const lateChunks = await late;
    expect(earlyChunks).toEqual(chunks);
    // The replay coalesces deltas and leaves out transient chunks, and reduces
    // to exactly the same message.
    expect(lateChunks.length).toBeLessThan(chunks.length);
    expect(await reduce(lateChunks)).toEqual(await reduce(earlyChunks));
    expect(channel.buffered.some((chunk) => chunk.type === "data-status")).toBe(false);
  });

  it("coalesces only adjacent deltas of the same part, without mutating published chunks", () => {
    const channel = new RunChannel();
    const first: ChatUIChunk = { type: "text-delta", id: "a", delta: "Hel" };
    channel.publish({ type: "text-start", id: "a" });
    channel.publish(first);
    channel.publish({ type: "text-delta", id: "a", delta: "lo" });
    channel.publish({ type: "text-start", id: "b" });
    channel.publish({ type: "text-delta", id: "b", delta: "x" });
    channel.publish({ type: "text-delta", id: "a", delta: "!" });
    expect(channel.buffered).toEqual([
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "x" },
      { type: "text-delta", id: "a", delta: "!" },
    ]);
    expect(first).toEqual({ type: "text-delta", id: "a", delta: "Hel" });
  });

  it("detaches a cancelled subscriber and keeps feeding the others", async () => {
    const channel = new RunChannel();
    const leaving = channel.subscribe().getReader();
    const staying = collect(channel.subscribe());
    channel.publish({ type: "start", messageId: "m" });
    expect(await leaving.read()).toEqual({ done: false, value: { type: "start", messageId: "m" } });
    await leaving.cancel();
    expect(channel.subscriberCount).toBe(1);
    channel.publish({ type: "start-step" });
    channel.close();
    expect(await staying).toEqual([{ type: "start", messageId: "m" }, { type: "start-step" }]);
  });

  it("gives a subscriber after close the whole buffer and ends it", async () => {
    const channel = new RunChannel();
    channel.publish({ type: "start", messageId: "m" });
    channel.close();
    channel.publish({ type: "start-step" });
    expect(await collect(channel.subscribe())).toEqual([{ type: "start", messageId: "m" }]);
    expect(channel.closed).toBe(true);
  });
});

describe("ServerMessageReducer", () => {
  it("snapshots at step ends and on request, and ends with the client's message", async () => {
    const chunks = refundChunks();
    const snapshots: ChatUIMessage[] = [];
    let final: ChatUIMessage | undefined;
    const errors: unknown[] = [];
    const reducer = new ServerMessageReducer({
      onSnapshot: (message) => snapshots.push(message),
      onEnd: (message, outcome) => {
        final = message;
        expect(outcome).toEqual({ status: "completed" });
      },
      onError: (error) => errors.push(error),
    });
    for (const chunk of chunks) {
      reducer.write(chunk);
      if (chunk.type === "tool-approval-request") reducer.snapshot();
    }
    await reducer.end({ status: "completed" });

    expect(errors).toEqual([]);
    // finish-step (step 1), the approval request, finish-step (step 2).
    expect(snapshots).toHaveLength(3);
    const [stepEnd, approval] = snapshots;
    const toolState = (message: ChatUIMessage | undefined) =>
      message?.parts.find((part) => part.type === "dynamic-tool")?.state;
    expect(toolState(stepEnd)).toBe("input-available");
    expect(toolState(approval)).toBe("approval-requested");
    expect(final).toEqual(await reduce(chunks));
    expect(final?.id).toBe("msg_1");
  });

  it("reports a chunk the reducer refuses and still resolves end()", async () => {
    const errors: unknown[] = [];
    const reducer = new ServerMessageReducer({
      onSnapshot: () => {},
      onEnd: () => {},
      onError: (error) => errors.push(error),
    });
    reducer.write({ type: "start", messageId: "m" });
    reducer.write({ type: "tool-output-available", toolCallId: "ghost", output: {} });
    await reducer.end({ status: "completed" });
    expect(errors.length).toBeGreaterThan(0);
    reducer.write({ type: "start-step" });
    await reducer.end({ status: "completed" });
  });

  it("reports a failing hook without breaking the stream", async () => {
    const errors: unknown[] = [];
    let ended = false;
    const reducer = new ServerMessageReducer({
      onSnapshot: () => {
        throw new Error("disk full");
      },
      onEnd: () => {
        ended = true;
      },
      onError: (error) => errors.push(error),
    });
    reducer.write({ type: "start", messageId: "m" });
    reducer.write({ type: "start-step" });
    reducer.write({ type: "finish-step" });
    await reducer.end({ status: "completed" });
    expect(ended).toBe(true);
    expect(errors).toEqual([expect.objectContaining({ message: "disk full" })]);
  });
});
