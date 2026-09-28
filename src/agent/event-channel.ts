// A single-consumer async queue: producers push synchronously (the SDK
// message loop, canUseTool, the PreToolUse hook, the gateway observer) and
// the caller of runTurn pulls AgentEvents in order.

export class EventChannel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;
  #iterating = false;

  /** Queues a value; ignored after close(). */
  push(value: T): void {
    if (this.#closed) return;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value, done: false });
    } else {
      this.#items.push(value);
    }
  }

  /** Ends the stream once the queued values are consumed. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterating) throw new Error("EventChannel supports a single consumer.");
    this.#iterating = true;
    return {
      next: () => {
        if (this.#items.length > 0) {
          return Promise.resolve({ value: this.#items.shift() as T, done: false });
        }
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
