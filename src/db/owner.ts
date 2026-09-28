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
// "alive". Both sides of the comparison come from the same measurement,
// `ps -o lstart=` (seconds): a process's start is when its pid was forked,
// which for a server or CLI started through `sh -c '…; exec node …'` or a
// container entrypoint can be seconds before Node itself initialised, so
// Node's own clock (performance.timeOrigin) is only a fallback when ps
// cannot be read. ps runs by absolute path with a minimal environment: it
// never inherits this process's secrets, and PATH cannot swap it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export type RunOwner = {
  readonly pid: number;
  /** ISO time the owning process started. */
  readonly startedAt: string;
};

/** How far a process's start as `ps` reports it may be from the recorded start. */
export const OWNER_START_TOLERANCE_MS = 3_000;

/** What the operating system says about another process. */
export interface ProcessProbe {
  /** Whether a process with this id exists (one of another user counts). */
  exists(pid: number): boolean;
  /** When it started, or null when that cannot be read. */
  startedAt(pid: number): Date | null;
}

/** The part of spawnSync the probe uses (tests pass their own). */
export type SpawnSync = (
  command: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly env: Readonly<Record<string, string>>;
    readonly timeout: number;
  },
) => { readonly status: number | null; readonly stdout: string | Buffer | null };

/** ps by absolute path: /bin/ps (macOS, most Linux), else /usr/bin/ps. */
export function psPath(exists: (path: string) => boolean = existsSync): string {
  return exists("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
}

/** The only environment ps gets: no secrets, a fixed PATH, a parseable date format. */
export const PS_ENV: Readonly<Record<string, string>> = { LC_ALL: "C", PATH: "/usr/bin:/bin" };

export function createProcessProbe(
  spawn: SpawnSync = spawnSync as unknown as SpawnSync,
  command: string = psPath(),
): ProcessProbe {
  return {
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
      let result: ReturnType<SpawnSync>;
      try {
        result = spawn(command, ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          env: PS_ENV,
          timeout: 2_000,
        });
      } catch {
        return null;
      }
      if (result.status !== 0 || typeof result.stdout !== "string") return null;
      const text = result.stdout.trim();
      if (text === "") return null;
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? null : new Date(parsed);
    },
  };
}

export const systemProcessProbe: ProcessProbe = createProcessProbe();

/**
 * This process as an owner, with its start measured as another process
 * would measure it (ps), falling back to Node's own start.
 */
export function ownerOf(
  pid: number,
  probe: Pick<ProcessProbe, "startedAt">,
  nodeStart: number = performance.timeOrigin,
): RunOwner {
  const measured = probe.startedAt(pid);
  return {
    pid,
    startedAt: (measured ?? new Date(Math.floor(nodeStart))).toISOString(),
  };
}

let self: RunOwner | undefined;

/** This process as the owner of the runs it starts. */
export function currentRunOwner(): RunOwner {
  self ??= ownerOf(process.pid, systemProcessProbe);
  return self;
}

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
