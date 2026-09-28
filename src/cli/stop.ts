// Stopping a CLI run: SIGINT, SIGTERM and --timeout-ms (docs/ARCHITECTURE.md §10).
//
// The first stop request aborts the run's AbortSignal with its RunStopReason,
// so the core interrupts the SDK and finishes the run itself. The run then
// has `graceMs` to deliver its run.finished; after that (or at once on a
// second request) `forced` resolves and the CLI finishes without it, so the
// process exits within about 1.5 seconds of a signal. The exception is a
// write that is executing (holdWhile): a started refund or invoice is never
// cancelled, and exiting would drop its answer, so the CLI waits for it, at
// most the hold's limit, unless a second request says not to.

import type { RunStopReason } from "../contracts/events.js";

export type CliSignal = "SIGINT" | "SIGTERM";

/** SIGINT is the person at the terminal; SIGTERM is a supervisor shutting the process down. */
export const SIGNAL_STOP_REASON = {
  SIGINT: "user",
  SIGTERM: "shutdown",
} as const satisfies Record<CliSignal, RunStopReason>;

export type StopRequest = {
  readonly reason: RunStopReason;
  /** What caused it, for messages: "SIGINT", "the 5000 ms time limit". */
  readonly cause: string;
};

/** The longest delay a Node timer holds. */
const MAX_TIMER_MS = 2_147_483_647;

/** How often a held stop checks whether the write settled. */
const HOLD_POLL_MS = 100;

export class StopController {
  readonly #controller = new AbortController();
  readonly #graceMs: number;
  readonly #forced = Promise.withResolvers<void>();
  #request: StopRequest | null = null;
  readonly #timers = new Set<NodeJS.Timeout>();
  #hold: {
    readonly active: () => boolean;
    readonly maxMs: number;
    readonly onHold: () => void;
  } | null = null;
  // Signal listeners do not keep Node's event loop alive. Without this handle
  // a run that awaits something without an open handle would end the process
  // (exit 13, "unsettled top-level await") instead of waiting for its signal.
  readonly #keepAlive = setInterval(() => undefined, 2 ** 30);

  constructor(options: { readonly graceMs: number }) {
    this.#graceMs = options.graceMs;
  }

  /** Aborted with the RunStopReason of the first request. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get request(): StopRequest | null {
    return this.#request;
  }

  /** Resolves when the CLI should stop waiting for the run. Never rejects. */
  get forced(): Promise<void> {
    return this.#forced.promise;
  }

  /**
   * Stops the run after `ms` milliseconds with reason "timeout". Node fires
   * a timer longer than 2^31-1 ms at once, so a longer limit is refused.
   */
  limitTo(ms: number): void {
    if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMER_MS) {
      throw new RangeError(`A time limit must be between 1 and ${MAX_TIMER_MS} ms.`);
    }
    this.#schedule(() => this.stop({ reason: "timeout", cause: `the ${ms} ms time limit` }), ms);
  }

  /**
   * After the grace period, keeps waiting while `active()` holds, at most
   * `maxMs` longer; `onHold` runs once when the wait starts.
   */
  holdWhile(active: () => boolean, maxMs: number, onHold: () => void = () => {}): void {
    this.#hold = { active, maxMs, onHold };
  }

  stop(request: StopRequest): void {
    if (this.#request !== null) {
      this.#forced.resolve();
      return;
    }
    this.#request = request;
    this.#clearTimers();
    this.#controller.abort(request.reason);
    this.#schedule(() => this.#forceUnlessHeld(Date.now()), this.#graceMs);
  }

  #forceUnlessHeld(since: number, announced = false): void {
    const hold = this.#hold;
    if (hold === null || !hold.active() || Date.now() - since >= hold.maxMs) {
      this.#forced.resolve();
      return;
    }
    if (!announced) hold.onHold();
    this.#schedule(() => this.#forceUnlessHeld(since, true), HOLD_POLL_MS);
  }

  dispose(): void {
    this.#clearTimers();
    clearInterval(this.#keepAlive);
  }

  // Timers stay referenced: a run that hangs without any open handle must
  // still reach its time limit and its forced finish. dispose() clears them.
  #schedule(callback: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      callback();
    }, ms);
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}
