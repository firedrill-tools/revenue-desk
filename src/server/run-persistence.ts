// Everything one run writes, from its AgentEvents (docs/ARCHITECTURE.md §6,
// §8), shared by the server's run registry and the CLI so that a CLI run is
// stored exactly like an app run and renders in the app:
//
//   record(event)  the action log: runs row, tool_calls, usage, SDK session,
//                  conversation status (run-recorder.ts)
//   map(event)     the UI message chunks of the assistant message
//                  (ui-stream.ts), also fed to the server-side reducer, which
//                  persists the message at every step end, after every
//                  non-automatic approval request and at the end
//   end(status)    closes the message once the run finished
//
// The caller decides what a failing record() means: the server logs it and
// keeps streaming; the CLI fails the run.

import { randomUUID } from "node:crypto";
import type { UIMessageStreamOutcome } from "ai";
import type { ChatMessageMetadata, ChatUIMessage } from "../contracts/api.js";
import type { AgentEvent, FinishedRunStatus } from "../contracts/events.js";
import { upsertAssistantMessage } from "../db/repos/messages.js";
import type { DbExecutor } from "../db/repos/types.js";
import { ServerMessageReducer } from "./message-reducer.js";
import { describeError, type Redact } from "./redaction.js";
import { RunRecorder, type RunRecorderOptions } from "./run-recorder.js";
import { type ChatUIChunk, UIStreamMapper } from "./ui-stream.js";

export type RunPersistenceOptions = {
  readonly db: DbExecutor;
  readonly runId: string;
  readonly conversationId: string;
  /** The assistant message id (the stream's `start` chunk). */
  readonly assistantMessageId: string;
  /** Metadata for a message whose run ends before run.started. */
  readonly fallbackMetadata: ChatMessageMetadata;
  readonly redact: Redact;
  readonly now: () => Date;
  /** Operator lines (already redacted): dropped events, a message that could not be stored. */
  readonly log: (line: string) => void;
  readonly newId?: () => string;
  /** How a failed call's credential problem is recorded on its connection (RunRecorder). */
  readonly connectionFromFailure?: RunRecorderOptions["connectionFromFailure"];
};

export class RunPersistence {
  readonly #recorder: RunRecorder;
  readonly #mapper: UIStreamMapper;
  readonly #reducer: ServerMessageReducer;

  constructor(options: RunPersistenceOptions) {
    const { db, runId, conversationId, redact, now, log } = options;
    this.#recorder = new RunRecorder({
      db,
      runId,
      conversationId,
      redact,
      now,
      newId: options.newId ?? randomUUID,
      ...(options.connectionFromFailure === undefined
        ? {}
        : { connectionFromFailure: options.connectionFromFailure }),
    });
    this.#mapper = new UIStreamMapper({
      messageId: options.assistantMessageId,
      fallbackMetadata: options.fallbackMetadata,
      redact,
      onAnomaly: (message) => log(`run ${runId}: dropped an out-of-order event (${message})`),
    });
    const persist = (message: ChatUIMessage) => {
      upsertAssistantMessage(db, {
        conversationId,
        runId,
        message,
        now: now().toISOString(),
      });
    };
    this.#reducer = new ServerMessageReducer({
      onSnapshot: persist,
      onEnd: persist,
      onError: (error) =>
        log(`run ${runId}: the message could not be recorded: ${describeError(error, redact)}`),
    });
  }

  /** The mapper has seen run.finished; later events are ignored. */
  get finished(): boolean {
    return this.#mapper.finished;
  }

  /** Writes the action log for one event. Throws when the database refuses it. */
  record(event: AgentEvent): void {
    this.#recorder.apply(event);
  }

  /** The event's UI chunks, already applied to the stored assistant message. */
  map(event: AgentEvent): readonly ChatUIChunk[] {
    const chunks = this.#mapper.map(event);
    for (const chunk of chunks) {
      this.#reducer.write(chunk);
      // The pending approval card is persisted with its request.
      if (chunk.type === "tool-approval-request" && chunk.isAutomatic !== true) {
        this.#reducer.snapshot();
      }
    }
    return chunks;
  }

  /** Ends the assistant message; resolves once it is stored. */
  end(status: FinishedRunStatus | null): Promise<void> {
    return this.#reducer.end(outcomeOf(status));
  }
}

function outcomeOf(status: FinishedRunStatus | null): UIMessageStreamOutcome {
  switch (status) {
    case "completed":
      return { status: "completed" };
    case "cancelled":
    case "timed_out":
      return { status: "aborted" };
    default:
      return { status: "failed" };
  }
}
