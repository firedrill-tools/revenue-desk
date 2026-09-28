// Which process owns a running run (docs/ARCHITECTURE.md §7, §8).
//
// The server and each CLI invocation write the same database. A run row
// records its owner: the process id and when that process started. When the
// owner is gone (a CLI killed with SIGKILL, a server that crashed), the row
// would stay `running` for ever and block its conversation, so recovery
// (src/db/recover.ts) fails it.
//
// The start time guards against a reused pid: after an owner dies the system
// can give its pid to an unrelated process, which must not keep the run
// "alive". The recorded time is this process's start (performance.timeOrigin,
// milliseconds); another process's start is read from `ps -o lstart=`
// (seconds), so the two are compared with a small tolerance.

import { spawnSync } from "node:child_process";

export type RunOwner = {
  readonly pid: number;
  /** ISO time the owning process started. */
  readonly startedAt: string;
};

/** How far a process's start as `ps` reports it may be from the recorded start. */
export const OWNER_START_TOLERANCE_MS = 3_000;

let self: RunOwner | undefined;

/** This process as the owner of the runs it starts. */
export function currentRunOwner(): RunOwner {
  self ??= {
    pid: process.pid,
    startedAt: new Date(Math.floor(performance.timeOrigin)).toISOString(),
  };
  return self;
}

/** What the operating system says about another process. */
export interface ProcessProbe {
  /** Whether a process with this id exists (one of another user counts). */
  exists(pid: number): boolean;
  /** When it started, or null when that cannot be read. */
  startedAt(pid: number): Date | null;
}

export const systemProcessProbe: ProcessProbe = {
  exists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  startedAt(pid) {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 2_000,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const text = result.stdout.trim();
    if (text === "") return null;
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  },
};

/**
 * - self: this process owns the run (only the caller knows whether it is
 *   still running it);
 * - alive: another process that is still running owns it;
 * - gone: the owner exited, its pid now belongs to another process, or the
 *   row predates owners (migration 0002).
 */
export type OwnerState = "self" | "alive" | "gone";

export function ownerState(
  owner: { readonly pid: number | null; readonly startedAt: string | null },
  options: { readonly self?: RunOwner; readonly probe?: ProcessProbe } = {},
): OwnerState {
  const me = options.self ?? currentRunOwner();
  const probe = options.probe ?? systemProcessProbe;
  const { pid, startedAt } = owner;
  if (pid === null || startedAt === null) return "gone";
  if (pid === me.pid) return startedAt === me.startedAt ? "self" : "gone";
  if (!Number.isSafeInteger(pid) || pid <= 0) return "gone";
  if (!probe.exists(pid)) return "gone";
  const recorded = Date.parse(startedAt);
  const actual = probe.startedAt(pid);
  // Without a start time to compare, a live pid is taken at its word.
  if (actual === null || Number.isNaN(recorded)) return "alive";
  return Math.abs(actual.getTime() - recorded) <= OWNER_START_TOLERANCE_MS ? "alive" : "gone";
}
