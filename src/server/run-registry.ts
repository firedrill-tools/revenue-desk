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
// period after Stop, the server finishes the run itself. A Stop (or time
// limit) does not close a run while one of its writes is executing: a
// started write is never cancelled, and its answer is the record of what
// happened, so the grace period extends until it settles (at most
// WRITE_DRAIN_MS). Shutdown does not wait: the write is then recorded as
// outcome_unknown with its idempotency key.

import { randomUUID } from "node:crypto";
import { ExecutingWrites, WRITE_DRAIN_MS } from "../agent/executing-writes.js";
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
import { RunPersistence, type RunPersistenceOptions } from "./run-persistence.js";

export const DEFAULT_STOP_GRACE_MS = 10_000;
/** After run.finished, how long the core has to end its event stream. */
export const DRAIN_GRACE_MS = 3_000;
export const CORE_ENDED_EARLY_TEXT = "The agent stopped unexpectedly before finishing the run.";
/** A run launched after shutdown began gets this long to stop itself. */
const SHUTDOWN_LATE_GRACE_MS = 1_000;
/** How often a held close checks whether the run's writes settled. */
const WRITE_HOLD_POLL_MS = 250;

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
  /** A failed call's credential problem, recorded on its connection (RunPersistence). */
  readonly connectionFromFailure?: RunPersistenceOptions["connectionFromFailure"];
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
  /** The run's writes that are executing, from its events. */
  readonly writes = new ExecutingWrites();
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
    this.forceAfter(graceMs, reason === "shutdown" ? 0 : WRITE_DRAIN_MS);
    return true;
  }

  /**
   * Closes the run after `ms` unless it finished; while a write is executing
   * the close waits for it, up to `holdForWritesMs` longer.
   * @internal
   */
  forceAfter(ms: number, holdForWritesMs = 0): void {
    if (this.#forceTimer !== undefined) return;
    const holdUntil = Date.now() + ms + holdForWritesMs;
    const fire = () => {
      if (this.writes.count > 0 && Date.now() < holdUntil) {
        this.#forceTimer = setTimeout(fire, WRITE_HOLD_POLL_MS);
        this.#forceTimer.unref();
        return;
      }
      this.#force();
    };
    this.#forceTimer = setTimeout(fire, ms);
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

  #settled = false;

  /** The run's answer is stored and its stream ended; only its core may still be closing. */
  get settled(): boolean {
    return this.#settled;
  }

  /** @internal */
  markSettled(): void {
    this.#settled = true;
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
  #closing = false;

  constructor(options: RunRegistryOptions) {
    this.#options = options;
  }

  /** Every run, a finished one still closing its connections included (the concurrency limit). */
  get size(): number {
    return this.#runs.size;
  }

  /** Shutdown has begun: no new run starts. */
  get closing(): boolean {
    return this.#closing;
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

  /**
   * The conversation's run that is still going. A run whose answer is
   * stored and whose stream ended is not, although its core may still be
   * closing connections: the conversation can be read and continued.
   */
  forConversation(conversationId: string): ActiveRun | undefined {
    for (const run of this.#runs.values()) {
      if (run.conversationId === conversationId && !run.settled) return run;
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
    // Started as shutdown began (the caller checked `closing` first): it stops at once.
    if (this.#closing) run.stop("shutdown", SHUTDOWN_LATE_GRACE_MS);
    void this.#pump(run, request).finally(() => {
      run.clearTimers();
      this.#runs.delete(run.runId);
      run.channel.close();
      resolve();
    });
    return run;
  }

  /**
   * Stops every run (server shutdown) and waits for them, at most
   * `timeoutMs`. From the first call no new run starts (`closing`).
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.#closing = true;
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
      ...(this.#options.connectionFromFailure === undefined
        ? {}
        : { connectionFromFailure: this.#options.connectionFromFailure }),
    });

    const handle = (event: AgentEvent): void => {
      run.writes.apply(event);
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
        // The answer is complete: store it and end the stream now. The core
        // may take seconds more to close its connections (HubSpot's stdio
        // server); the conversation must not wait for that.
        void persistence.end(event.status).then(() => {
          run.markSettled();
          run.channel.close();
        });
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
