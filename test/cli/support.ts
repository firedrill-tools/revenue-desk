/**
 * Support for the built CLI suite: spawn dist/cli/main.js with an explicit
 * environment (never this process's, so no real key can reach it) and a
 * fresh state directory, and read what it wrote.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "../../src/db/client.js";
import { REPOSITORY_ROOT } from "../support/repository.js";

export const BUILT_CLI = join(REPOSITORY_ROOT, "dist/cli/main.js");

/** A value shaped like a model key. The suite never gets as far as a model call. */
export const UNUSED_MODEL_KEY = `sk-ant-cli-suite-${"0".repeat(24)}`;

/** Fails (never skips) when the CLI was not built. */
export function requireBuiltCli(): void {
  if (!existsSync(BUILT_CLI)) {
    throw new Error(`${BUILT_CLI} does not exist: run pnpm build before pnpm test:cli.`);
  }
}

export function freshStateDir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `revenue-desk-cli-${label}-`)));
}

/** The minimal environment of a child: a PATH, a HOME and the given variables. */
export function childEnv(
  stateDir: string,
  vars: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: stateDir,
    TMPDIR: tmpdir(),
    AGENT_STATE_DIR: stateDir,
    ...vars,
  };
}

export type CliResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** From the stop signal to exit, when one was sent. */
  readonly afterSignalMs: number | null;
};

export type CliOptions = {
  readonly env: Readonly<Record<string, string>>;
  /** Written to stdin, which is then closed; `open` leaves stdin open. */
  readonly stdin?: string | { readonly open: true };
  /** Run the file itself (its shebang and executable bit) instead of `node <file>`. */
  readonly asExecutable?: boolean;
  /** Sends this signal after `afterMs`. */
  readonly stop?: { readonly signal: NodeJS.Signals; readonly afterMs: number };
  readonly timeoutMs?: number;
};

/** Runs the built CLI to completion and captures everything it wrote. */
export function runBuiltCli(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const child: ChildProcess = options.asExecutable
    ? spawn(BUILT_CLI, args, { cwd: REPOSITORY_ROOT, env: options.env, stdio: "pipe" })
    : spawn(process.execPath, [BUILT_CLI, ...args], {
        cwd: REPOSITORY_ROOT,
        env: options.env,
        stdio: "pipe",
      });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (piece: string) => {
    stdout += piece;
  });
  child.stderr?.setEncoding("utf8").on("data", (piece: string) => {
    stderr += piece;
  });
  if (typeof options.stdin === "string" || options.stdin === undefined) {
    child.stdin?.end(options.stdin ?? "");
  }
  let signalledAt: number | null = null;
  if (options.stop !== undefined) {
    const { signal, afterMs } = options.stop;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        signalledAt = performance.now();
        child.kill(signal);
      }
    }, afterMs);
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The CLI did not exit within ${timeoutMs} ms:\n${stderr}`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const ended = performance.now();
      child.stdin?.destroy();
      // Let the pipes drain.
      setImmediate(() =>
        resolve({
          code,
          signal,
          stdout,
          stderr,
          afterSignalMs: signalledAt === null ? null : ended - signalledAt,
        }),
      );
    });
  });
}

/** Row counts of the tables a run writes, or null when there is no database. */
export function rowCounts(
  stateDir: string,
): { readonly conversations: number; readonly runs: number } | null {
  const path = databasePath(stateDir);
  if (!existsSync(path)) return null;
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const count = (table: string) =>
      (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { conversations: count("conversations"), runs: count("runs") };
  } finally {
    sqlite.close();
  }
}
