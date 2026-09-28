// The server's active runs (docs/ARCHITECTURE.md §6, §7). A run lives here
// from POST /api/chat until its last chunk is persisted, independent of any
// HTTP connection: clients subscribe to its RunChannel and may come and go.
//
// For each AgentEvent of the core, in order:
//   1. the recorder writes the action log (tool_calls, runs, conversation);
//   2. the mapper turns it into UI message chunks;
//   3. each chunk goes to the channel (replay buffer and subscribers) and to
//      the server-side reducer, which persists the assistant message at every
//      step end, after every approval request and at the end.
//
// The registry guarantees that every run ends exactly once: if the core
// throws, returns without run.finished, or does not stop within the grace
// period after Stop, the server finishes the run itself.

import { randomUUID } from "node:crypto";
import { MAX_CONCURRENT_RUNS } from "../contracts/api.js";
import type {
  AgentEvent,
  FinishedRunStatus,
  RunStopReason,
  RunTurn,
  RunTurnInput,
} from "../contracts/events.js";
import type { DbExecutor } from "../db/repos/types.js";
import { describeError, type Redact } from "./redaction.js";
import { RunChannel } from "./run-channel.js";
import { RunPersistence } from "./run-persistence.js";

export const DEFAULT_STOP_GRACE_MS = 10_000;
/** After run.finished, how long the core has to end its event stream. */
export const DRAIN_GRACE_MS = 3_000;
export const CORE_ENDED_EARLY_TEXT = "The agent stopped unexpectedly before finishing the run.";

export type RunRegistryOptions = {
  readonly db: DbExecutor;
  readonly runTurn: RunTurn;
  readonly redact: Redact;
  readonly now: () => Date;
  /** One line per event worth an operator's attention; already redacted. */
  readonly log: (line: string) => void;
  readonly maxConcurrentRuns?: number;
  /** After Stop, how long the core has to finish before the server closes the run. */
  readonly stopGraceMs?: number;
  readonly newId?: () => string;
};

export type LaunchRequest = {
  readonly runId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly model: string;
  readonly effort: RunTurnInput["model"]["effort"];
  /** Builds the core's input around the run's signal. */
  readonly input: (signal: AbortSignal) => RunTurnInput;
};

const FORCED = Symbol("forced");

export class ActiveRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly channel = new RunChannel();
  readonly controller = new AbortController();
  /** Resolves once the run is finished, persisted and removed from the registry. */
  readonly done: Promise<void>;

  readonly #force: () => void;
  readonly #forced: Promise<typeof FORCED>;
  #forceTimer: NodeJS.Timeout | undefined;
  #finishedStatus: FinishedRunStatus | null = null;

  constructor(request: LaunchRequest, done: Promise<void>) {
    this.runId = request.runId;
    this.conversationId = request.conversationId;
    this.assistantMessageId = request.assistantMessageId;
    this.done = done;
    const forced = Promise.withResolvers<typeof FORCED>();
    this.#forced = forced.promise;
    this.#force = () => forced.resolve(FORCED);
  }

  /** The run has sent run.finished (it may still be persisting). */
  get finished(): boolean {
    return this.#finishedStatus !== null;
  }

  /**
   * Aborts the core's signal with `reason`. The core interrupts, settles its
   * pending approvals as stopped and finishes; after `graceMs` the server
   * closes the run itself. False when the run already finished.
   */
  stop(reason: RunStopReason, graceMs: number): boolean {
    if (this.finished) return false;
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.forceAfter(graceMs);
    return true;
  }

  /** @internal */
  forceAfter(ms: number): void {
    if (this.#forceTimer !== undefined) return;
    this.#forceTimer = setTimeout(this.#force, ms);
    this.#forceTimer.unref();
  }

  /** @internal */
  get forced(): Promise<typeof FORCED> {
    return this.#forced;
  }

  /** @internal */
  markFinished(status: FinishedRunStatus): void {
    this.#finishedStatus ??= status;
  }

  /** @internal */
  get finishedStatus(): FinishedRunStatus | null {
    return this.#finishedStatus;
  }

  /** @internal */
  clearTimers(): void {
    if (this.#forceTimer !== undefined) clearTimeout(this.#forceTimer);
  }
}

export class RunRegistry {
  readonly #options: RunRegistryOptions;
  readonly #runs = new Map<string, ActiveRun>();

  constructor(options: RunRegistryOptions) {
    this.#options = options;
  }

  get size(): number {
    return this.#runs.size;
  }

  get maxConcurrentRuns(): number {
    return this.#options.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS;
  }

  get stopGraceMs(): number {
    return this.#options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  get(runId: string): ActiveRun | undefined {
    return this.#runs.get(runId);
  }

  forConversation(conversationId: string): ActiveRun | undefined {
    for (const run of this.#runs.values()) {
      if (run.conversationId === conversationId) return run;
    }
    return undefined;
  }

  /**
   * Registers and starts a run. The caller has checked the limits and
   * written the run row; nothing here awaits before the run is registered.
   */
  launch(request: LaunchRequest): ActiveRun {
    const { promise, resolve } = Promise.withResolvers<void>();
    const run = new ActiveRun(request, promise);
    this.#runs.set(run.runId, run);
    void this.#pump(run, request).finally(() => {
      run.clearTimers();
      this.#runs.delete(run.runId);
      run.channel.close();
      resolve();
    });
    return run;
  }

  /** Stops every run (server shutdown) and waits for them, at most `timeoutMs`. */
  async shutdown(timeoutMs: number): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const run of runs) run.stop("shutdown", Math.max(0, timeoutMs - 500));
    await Promise.race([
      Promise.all(runs.map((run) => run.done)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  async #pump(run: ActiveRun, request: LaunchRequest): Promise<void> {
    const { db, redact, now, log } = this.#options;
    const persistence = new RunPersistence({
      db,
      runId: run.runId,
      conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId,
      fallbackMetadata: { runId: run.runId, model: request.model, effort: request.effort },
      redact,
      now,
      log,
      newId: this.#options.newId ?? randomUUID,
    });

    const handle = (event: AgentEvent): void => {
      if (persistence.finished) {
        log(`run ${run.runId}: ignored ${event.type} after run.finished`);
        return;
      }
      try {
        persistence.record(event);
      } catch (error) {
        log(`run ${run.runId}: could not record ${event.type}: ${describeError(error, redact)}`);
      }
      for (const chunk of persistence.map(event)) run.channel.publish(chunk);
      if (event.type === "run.finished") {
        run.markFinished(event.status);
        run.forceAfter(DRAIN_GRACE_MS);
      }
    };

    let failure: unknown;
    let forced = false;
    try {
      const events = this.#options.runTurn(request.input(run.controller.signal));
      const iterator = events[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), run.forced]);
        if (next === FORCED) {
          forced = true;
          iterator.return?.().catch(() => {});
          break;
        }
        if (next.done === true) break;
        handle(next.value);
      }
    } catch (error) {
      failure = error;
    }

    if (!persistence.finished) {
      const signal = run.controller.signal;
      const stopReason = signal.aborted ? stopReasonOf(signal.reason) : null;
      if (failure !== undefined) {
        log(`run ${run.runId}: the agent core failed: ${describeError(failure, redact)}`);
      } else if (forced) {
        log(`run ${run.runId}: the agent core did not stop in time; closed by the server`);
      }
      handle({
        type: "run.finished",
        status:
          stopReason === null ? "failed" : stopReason === "timeout" ? "timed_out" : "cancelled",
        finishedAt: now().toISOString(),
        stopReason,
        terminalReason: null,
        reply: null,
        error: stopReason === null ? { code: "internal", message: CORE_ENDED_EARLY_TEXT } : null,
      });
    } else if (forced) {
      log(`run ${run.runId}: the agent core kept its event stream open after run.finished`);
    }

    // Any approval still waiting settles through the run's signal (as stopped).
    if (!run.controller.signal.aborted) run.controller.abort("shutdown");
    await persistence.end(run.finishedStatus);
  }
}

function stopReasonOf(reason: unknown): RunStopReason {
  return reason === "timeout" || reason === "shutdown" ? reason : "user";
}
