/**
 * CLI end-to-end support: spawn the built CLI (dist/cli/main.js) with an
 * explicit environment that points at the local fakes and the scripted
 * model, and prepare isolated state directories.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "../../src/db/client.js";
import { updateSettings } from "../../src/db/repos/settings.js";
import { seedDatabase } from "../../src/db/seed.js";
import type { Fakes } from "../support/fakes/index.js";
import { REPOSITORY_ROOT } from "../support/harness.js";

export const BUILT_CLI = join(REPOSITORY_ROOT, "dist/cli/main.js");

/** Fails (never skips) when the CLI was not built. */
export function requireBuiltCli(): void {
  if (!existsSync(BUILT_CLI)) {
    throw new Error(`${BUILT_CLI} does not exist: run pnpm build before pnpm test:e2e-cli.`);
  }
}

export function freshStateDir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `revenue-desk-cli-${label}-`)));
}

/**
 * The state directory as a person would have it after setting up the
 * workspace in Settings: seeded, with the fixture company's settings (Slack
 * allowlist, internal domains, time zone).
 */
export function prepareWorkspace(stateDir: string, fakes: Fakes): void {
  mkdirSync(stateDir, { recursive: true });
  const database = openDatabase({ path: databasePath(stateDir) });
  try {
    const now = new Date().toISOString();
    seedDatabase(database.db, now);
    updateSettings(database.db, fakes.fixtures.company.workspaceSettings, now);
  } finally {
    database.close();
  }
}

export type CliResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** From spawn to exit. */
  readonly durationMs: number;
  /** From the stop signal to exit, when one was sent. */
  readonly afterSignalMs: number | null;
};

export type CliOptions = {
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  /** Run the file itself (its shebang and executable bit) instead of `node <file>`. */
  readonly asExecutable?: boolean;
  /** Sends this signal once `when` resolves. */
  readonly stop?: { readonly signal: NodeJS.Signals; readonly when: () => Promise<void> };
  readonly timeoutMs?: number;
};

/** Runs the built CLI to completion and captures everything it wrote. */
export function runBuiltCli(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const started = performance.now();
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
  child.stdin?.end(options.stdin ?? "");
  let signalledAt: number | null = null;
  if (options.stop !== undefined) {
    const { signal, when } = options.stop;
    void when().then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        signalledAt = performance.now();
        child.kill(signal);
      }
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`The CLI did not exit within ${options.timeoutMs ?? 60_000} ms:\n${stderr}`),
      );
    }, options.timeoutMs ?? 60_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const ended = performance.now();
      // Let the pipes drain.
      setImmediate(() =>
        resolve({
          code,
          signal,
          stdout,
          stderr,
          durationMs: ended - started,
          afterSignalMs: signalledAt === null ? null : ended - signalledAt,
        }),
      );
    });
  });
}

export type CliRunRecord = {
  readonly id: string;
  readonly conversation_id: string;
  readonly source: string;
  readonly mode: string;
  readonly status: string;
  readonly stop_reason: string | null;
  readonly error_code: string | null;
};

export type CliToolCallRecord = {
  readonly tool_use_id: string;
  readonly connection_kind: string | null;
  readonly operation: string | null;
  readonly decision: string;
  readonly status: string;
};

/** Every run in a state directory, with its tool calls and the conversation's messages. */
export function readState(stateDir: string): {
  readonly runs: readonly CliRunRecord[];
  readonly toolCalls: readonly CliToolCallRecord[];
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  readonly conversations: readonly {
    readonly id: string;
    readonly source: string;
    readonly status: string;
  }[];
} {
  const sqlite = new Database(databasePath(stateDir), { readonly: true, fileMustExist: true });
  try {
    return {
      runs: sqlite.prepare("SELECT * FROM runs ORDER BY started_at").all() as CliRunRecord[],
      toolCalls: sqlite
        .prepare("SELECT * FROM tool_calls ORDER BY started_at, tool_use_id")
        .all() as CliToolCallRecord[],
      messages: sqlite
        .prepare("SELECT role, text FROM messages ORDER BY conversation_id, seq")
        .all() as { role: string; text: string }[],
      conversations: sqlite.prepare("SELECT id, source, status FROM conversations").all() as {
        id: string;
        source: string;
        status: string;
      }[],
    };
  } finally {
    sqlite.close();
  }
}

/** Resolves once `condition` holds, polling; fails after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
