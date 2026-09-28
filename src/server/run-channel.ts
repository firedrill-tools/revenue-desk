// The chunk feed of one run (docs/ARCHITECTURE.md §6): a replay buffer from
// the start of the assistant message plus fan-out to every connected client.
// A run outlives its HTTP connections: cancelling a subscriber (a client
// disconnect) only detaches it.
//
// Transient chunks (status, progress) go to live subscribers only; replaying
// them would show stale state. Consecutive deltas of one part are coalesced
// in the buffer, which keeps a replay short and reduces to the same message.

import { type ChatUIChunk, isTransientChunk } from "./ui-stream.js";

type Subscriber = {
  push(chunk: ChatUIChunk): void;
  close(): void;
};

export class RunChannel {
  readonly #buffer: ChatUIChunk[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** The buffered (replayable) chunks so far. */
  get buffered(): readonly ChatUIChunk[] {
    return this.#buffer;
  }

  publish(chunk: ChatUIChunk): void {
    if (this.#closed) return;
    if (!isTransientChunk(chunk)) this.#append(chunk);
    for (const subscriber of this.#subscribers) subscriber.push(chunk);
  }

  /** The buffered chunks, then live ones until the run ends. */
  subscribe(): ReadableStream<ChatUIChunk> {
    let subscriber: Subscriber | undefined;
    return new ReadableStream<ChatUIChunk>({
      start: (controller) => {
        for (const chunk of this.#buffer) controller.enqueue(chunk);
        if (this.#closed) {
          controller.close();
          return;
        }
        const current: Subscriber = {
          push: (chunk) => {
            try {
              controller.enqueue(chunk);
            } catch {
              this.#subscribers.delete(current);
            }
          },
          close: () => {
            try {
              controller.close();
            } catch {
              // Already cancelled by the client.
            }
          },
        };
        subscriber = current;
        this.#subscribers.add(current);
      },
      cancel: () => {
        if (subscriber !== undefined) this.#subscribers.delete(subscriber);
      },
    });
  }

  /** Ends every subscriber's stream; later publishes are ignored. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) subscriber.close();
    this.#subscribers.clear();
  }

  #append(chunk: ChatUIChunk): void {
    const last = this.#buffer.at(-1);
    const merged = last === undefined ? undefined : coalesce(last, chunk);
    if (merged === undefined) this.#buffer.push(chunk);
    else this.#buffer[this.#buffer.length - 1] = merged;
  }
}

/** One chunk equal to `a` then `b`, or undefined when they cannot merge. New objects only. */
function coalesce(a: ChatUIChunk, b: ChatUIChunk): ChatUIChunk | undefined {
  if (a.type === "text-delta" && b.type === "text-delta" && a.id === b.id) {
    return { type: "text-delta", id: a.id, delta: a.delta + b.delta };
  }
  if (a.type === "reasoning-delta" && b.type === "reasoning-delta" && a.id === b.id) {
    return { type: "reasoning-delta", id: a.id, delta: a.delta + b.delta };
  }
  if (
    a.type === "tool-input-delta" &&
    b.type === "tool-input-delta" &&
    a.toolCallId === b.toolCallId
  ) {
    return {
      type: "tool-input-delta",
      toolCallId: a.toolCallId,
      inputTextDelta: a.inputTextDelta + b.inputTextDelta,
    };
  }
  return undefined;
}
