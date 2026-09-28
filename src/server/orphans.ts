// Runs whose process is gone (src/db/recover.ts), as the server meets them.
//
// The server recovers every orphaned run at boot. After that a CLI invocation
// can die with its run in flight (SIGKILL), leaving the run `running` and its
// conversation busy. The server recovers such runs:
//   - before it refuses a new turn of a conversation that seems busy (409);
//   - before it refuses to stop a run that it does not run itself;
//   - when the app reads conversations or runs (the rail and the Runs screen
//     poll while anything is running), at most once per interval, so a dead
//     CLI run does not show as running for ever.
// Runs of live processes (a CLI still working, another server) are never touched.

import { currentRunOwner, type RunOwner } from "../db/owner.js";
import {
  type RecoveryOptions,
  type RecoveryResult,
  recoverAfterRestart,
  recoverOrphanedRuns,
} from "../db/recover.js";
import type { DbExecutor } from "../db/repos/types.js";
import { describeError, type Redact } from "./redaction.js";

/** How often reads may trigger a sweep of the whole database. */
export const ORPHAN_SWEEP_INTERVAL_MS = 2_000;

export type OrphanSweeperOptions = {
  readonly db: DbExecutor;
  /** Whether this server is still running a run (its run registry). */
  readonly runsLocally: (runId: string) => boolean;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly redact: Redact;
  readonly intervalMs?: number;
  /** Test seams (src/db/owner.ts): this process, and what the system says about others. */
  readonly ownership?: Pick<RecoveryOptions, "self" | "probe">;
};

export class OrphanSweeper {
  readonly #options: OrphanSweeperOptions;
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(options: OrphanSweeperOptions) {
    this.#options = options;
  }

  /** The process recorded as the owner of the runs this server starts. */
  get owner(): RunOwner {
    return this.#options.ownership?.self ?? currentRunOwner();
  }

  /**
   * At boot, before anything runs: every orphaned run, and the pending
   * approvals of runs that are no longer running.
   */
  boot(): RecoveryResult {
    const { db, now, ownership } = this.#options;
    return recoverAfterRestart(db, { now: now().toISOString(), ...ownership });
  }

  /** Recovers one conversation's orphaned runs now. Returns how many were recovered. */
  conversation(conversationId: string): number {
    return this.#recover(conversationId).runs;
  }

  /** Recovers every orphaned run, unless a sweep ran within the interval. */
  sweep(): void {
    const now = this.#options.now().getTime();
    if (now - this.#lastSweep < (this.#options.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS)) return;
    this.#lastSweep = now;
    this.#recover(undefined);
  }

  #recover(conversationId: string | undefined): RecoveryResult {
    const { db, runsLocally, now, log, redact, ownership } = this.#options;
    try {
      const result = recoverOrphanedRuns(db, {
        now: now().toISOString(),
        runsLocally,
        ...(conversationId === undefined ? {} : { conversationId }),
        ...ownership,
      });
      if (result.runs > 0) {
        log(
          `Recovered ${result.runs} run(s) whose process had exited: ${result.toolCalls} tool call(s) interrupted, ${result.approvals} approval(s) expired.`,
        );
      }
      return result;
    } catch (error) {
      // A busy database only delays recovery until the next attempt.
      log(`Recovery of orphaned runs failed: ${describeError(error, redact)}`);
      return { runs: 0, toolCalls: 0, approvals: 0 };
    }
  }
}
