// A run's UI message stream as an HTTP response (docs/ARCHITECTURE.md §6),
// with a heartbeat.
//
// The body is what createUIMessageStreamResponse sends (the AI SDK's SSE
// framing, its headers, the [DONE] terminator), plus an SSE comment line
// every 15 seconds while the stream is open. A run can wait up to 15 minutes
// for an approval without sending anything; proxies with an idle timeout
// would otherwise cut the connection. Comment lines carry no data: the AI
// SDK's event-stream parser, EventSource and our own readers skip them.
// The heartbeat stops when the run's stream ends or the client goes away.

import { JsonToSseTransformStream, UI_MESSAGE_STREAM_HEADERS } from "ai";
import type { ChatUIChunk } from "./ui-stream.js";

export const SSE_HEARTBEAT_MS = 15_000;
/** One SSE comment line, a complete event of its own. */
export const SSE_HEARTBEAT = ": heartbeat\n\n";
/** The AI SDK's terminator; nothing follows it. */
const SSE_DONE = "data: [DONE]\n\n";

/** The response for a run's chunk stream (POST /api/chat, GET /api/chat/:id/stream). */
export function runStreamResponse(
  chunks: ReadableStream<ChatUIChunk>,
  options: { readonly heartbeatMs?: number } = {},
): Response {
  const events = chunks.pipeThrough(new JsonToSseTransformStream());
  const body = withHeartbeat(events, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  return new Response(body.pipeThrough(new TextEncoderStream()), {
    headers: UI_MESSAGE_STREAM_HEADERS,
  });
}

/**
 * `events` (complete SSE events) with SSE_HEARTBEAT added every `intervalMs`
 * between them, until the [DONE] terminator, the end of `events`, a failure
 * or the reader cancelling.
 */
export function withHeartbeat(
  events: ReadableStream<string>,
  intervalMs: number,
): ReadableStream<string> {
  const reader = events.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return new ReadableStream<string>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(SSE_HEARTBEAT);
        } catch {
          // The stream closed between two ticks.
          stop();
        }
      }, intervalMs);
      timer.unref?.();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          stop();
          controller.close();
          return;
        }
        if (next.value === SSE_DONE) stop();
        controller.enqueue(next.value);
      } catch (error) {
        stop();
        controller.error(error);
      }
    },
    async cancel(reason) {
      stop();
      await reader.cancel(reason);
    },
  });
}
