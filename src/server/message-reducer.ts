// The server-side reduction of a run's chunks into its assistant message,
// with the AI SDK's own reducer (the one useChat runs), so what the server
// persists equals what the client renders (spike S1).
//
// createUIMessageStream runs the reducer when it has onStepEnd/onEnd and
// awaits onStepEnd at every finish-step with a snapshot of the message. The
// reducer here is private to the server: its input is every chunk the run
// streams, plus a synthetic finish-step where the server wants an extra
// snapshot (after an approval request). finish-step does not change a
// message, so the reduction stays equal to the client's.

import { createUIMessageStream, type UIMessageStreamOutcome } from "ai";
import type { ChatUIMessage } from "../contracts/api.js";
import type { ChatUIChunk } from "./ui-stream.js";

export type MessageReducerHooks = {
  /** A snapshot at a step end or an explicit snapshot point. */
  readonly onSnapshot: (message: ChatUIMessage) => void;
  /** The final message, once, when the run's chunks end. */
  readonly onEnd: (message: ChatUIMessage, outcome: UIMessageStreamOutcome) => void;
  /** A chunk the reducer refused, or a failing hook. Persistence stops at the last snapshot. */
  readonly onError: (error: unknown) => void;
};

type Writer = {
  write(chunk: ChatUIChunk): void;
  setOutcome(outcome: UIMessageStreamOutcome): void;
};

export class ServerMessageReducer {
  readonly #writer: Writer;
  readonly #finish: () => void;
  readonly #drained: Promise<void>;
  #ended = false;

  constructor(hooks: MessageReducerHooks) {
    const { promise, resolve } = Promise.withResolvers<void>();
    let captured: Writer | undefined;
    const stream = createUIMessageStream<ChatUIMessage>({
      execute: ({ writer }) => {
        captured = writer;
        return promise;
      },
      onError: (error) => {
        hooks.onError(error);
        return "The server could not record this message.";
      },
      onStepEnd: ({ responseMessage }) => guard(hooks, () => hooks.onSnapshot(responseMessage)),
      onEnd: ({ responseMessage, outcome }) =>
        guard(hooks, () => hooks.onEnd(responseMessage, outcome)),
    });
    if (captured === undefined) throw new Error("createUIMessageStream did not run execute");
    this.#writer = captured;
    this.#finish = resolve;
    this.#drained = drain(stream).catch((error: unknown) => hooks.onError(error));
  }

  write(chunk: ChatUIChunk): void {
    if (!this.#ended) this.#writer.write(chunk);
  }

  /** Persists the message as it stands after the chunks written so far. */
  snapshot(): void {
    if (!this.#ended) this.#writer.write({ type: "finish-step" });
  }

  /** Ends the message; resolves once onEnd ran (or the reducer failed). */
  end(outcome: UIMessageStreamOutcome): Promise<void> {
    if (!this.#ended) {
      this.#ended = true;
      this.#writer.setOutcome(outcome);
      this.#finish();
    }
    return this.#drained;
  }
}

function guard(hooks: MessageReducerHooks, action: () => void): void {
  try {
    action();
  } catch (error) {
    hooks.onError(error);
  }
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}
