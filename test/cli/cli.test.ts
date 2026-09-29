/**
 * The built CLI (docs/ARCHITECTURE.md §10): `node dist/cli/main.js` as a
 * separate process, for everything it decides before a model call: help and
 * version, usage errors, configuration errors, DOTENV_PATH, conversations it
 * refuses, stopping before a run starts, stdout purity and secrets. Every
 * child gets an explicit environment without integration configuration, and
 * none of these tests reaches the model or any service.
 *
 * A run with the real model (the reply, --json, resuming a conversation,
 * SIGTERM and SIGKILL mid-run) is in test/live/cli.test.ts (`pnpm test:live`).
 *
 * Needs `pnpm build` first (pnpm verify runs it before this suite).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_EXIT_CODES, type RunSummary } from "../../src/contracts/cli.js";
import { DEFAULT_POLICY } from "../../src/contracts/integration.js";
import { databasePath, openDatabase } from "../../src/db/client.js";
import { systemProcessProbe } from "../../src/db/owner.js";
import { insertConversation } from "../../src/db/repos/conversations.js";
import { insertRun } from "../../src/db/repos/runs.js";
import { seedDatabase } from "../../src/db/seed.js";
import { REPOSITORY_ROOT } from "../support/repository.js";
import {
  BUILT_CLI,
  childEnv,
  freshStateDir,
  requireBuiltCli,
  rowCounts,
  runBuiltCli,
  UNUSED_MODEL_KEY,
} from "./support.js";

/** The CLI's promise: a signal ends the process within about 1.5 seconds. */
const SIGNAL_EXIT_LIMIT_MS = 1_500;

const stateDirs: string[] = [];

function stateDir(label: string): string {
  const dir = freshStateDir(label);
  stateDirs.push(dir);
  return dir;
}

beforeAll(() => {
  requireBuiltCli();
});

afterAll(() => {
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
});

/** stdout must be exactly one JSON document followed by one newline. */
function onlySummary(stdout: string): RunSummary {
  expect(stdout.endsWith("\n"), "stdout ends with a newline").toBe(true);
  expect(stdout.slice(0, -1)).not.toContain("\n");
  const summary = JSON.parse(stdout) as RunSummary;
  expect(summary.kind).toBe("revenue-desk.run-summary");
  return summary;
}

describe("the executable", () => {
  it("starts with a shebang, is executable and imports only the stdout guard first", () => {
    const source = readFileSync(BUILT_CLI, "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(BUILT_CLI).mode & 0o111).not.toBe(0);
    const staticImports = [...source.matchAll(/^import .* from "(.+)";$/gm)].map(
      (match) => match[1],
    );
    expect(staticImports).toEqual(["./stdout-guard.js"]);
  });

  it("runs through its shebang and prints the package version", async () => {
    const { version } = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const dir = stateDir("version");
    const result = await runBuiltCli(["--version"], { env: childEnv(dir), asExecutable: true });
    expect(result).toMatchObject({ code: 0, stdout: `${version}\n`, stderr: "" });
  });

  it("prints help on stdout and exits 0", async () => {
    const result = await runBuiltCli(["--help"], { env: childEnv(stateDir("help")) });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: revenue-desk ask \[options\] <prompt>\n/);
    expect(result.stderr).toBe("");
  });
});

describe("usage errors (exit 2, nothing on stdout, nothing recorded)", () => {
  it.each([
    ["no prompt", ["ask", "--json"], "'ask' needs a prompt"],
    ["an unknown flag", ["ask", "--nope", "x"], "--nope"],
    ["a turn limit of 0", ["ask", "--json", "--max-turns", "0", "x"], "--max-turns"],
    ["a policy that is not JSON", ["ask", "--policy", "{", "x"], "--policy"],
  ])("%s", async (_label, args, message) => {
    const dir = stateDir("usage");
    const result = await runBuiltCli(args, {
      env: childEnv(dir, { ANTHROPIC_API_KEY: UNUSED_MODEL_KEY }),
    });
    expect(result.code).toBe(CLI_EXIT_CODES.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(rowCounts(dir)).toBeNull();
  });

  it("refuses an empty prompt on stdin", async () => {
    const dir = stateDir("empty-stdin");
    const result = await runBuiltCli(["ask", "--json", "-"], {
      env: childEnv(dir, { ANTHROPIC_API_KEY: UNUSED_MODEL_KEY }),
      stdin: "  \n",
    });
    expect(result.code).toBe(CLI_EXIT_CODES.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("The prompt is empty.");
  });
});

describe("configuration errors (exit 3, before the database is opened)", () => {
  it("without ANTHROPIC_API_KEY: says so, and --json prints exactly one summary", async () => {
    const dir = stateDir("no-key");
    const result = await runBuiltCli(["ask", "--json", "Which invoices are overdue?"], {
      env: childEnv(dir),
    });
    expect(result.code).toBe(CLI_EXIT_CODES.config);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    const summary = onlySummary(result.stdout);
    expect(summary).toMatchObject({
      status: "failed",
      mode: "headless",
      error: { code: "config_missing" },
      toolCalls: [],
    });
    // The ids it had reserved exist nowhere: nothing was written.
    expect(summary.runId).toMatch(/\S/);
    expect(summary.conversationId).toMatch(/\S/);
    expect(existsSync(databasePath(dir))).toBe(false);
  });

  it("names a refused variable without echoing its value or the key", async () => {
    const dir = stateDir("refused");
    const result = await runBuiltCli(["ask", "x"], {
      env: childEnv(dir, {
        ANTHROPIC_API_KEY: UNUSED_MODEL_KEY,
        AGENT_EFFORT: "extreme",
        AGENT_POLICY: '{"refunds":"auto"}',
      }),
    });
    expect(result.code).toBe(CLI_EXIT_CODES.config);
    expect(result.stderr).toContain("AGENT_EFFORT");
    expect(result.stderr).toContain("AGENT_POLICY");
    expect(result.stdout + result.stderr).not.toContain("extreme");
    expect(result.stdout + result.stderr).not.toContain(UNUSED_MODEL_KEY);
    expect(existsSync(databasePath(dir))).toBe(false);
  });

  it("refuses a DOTENV_PATH it cannot read and names only the path", async () => {
    const dir = stateDir("dotenv-missing");
    const file = join(dir, "missing.env");
    const result = await runBuiltCli(["ask", "x"], { env: childEnv(dir, { DOTENV_PATH: file }) });
    expect(result.code).toBe(CLI_EXIT_CODES.config);
    expect(result.stderr).toContain(`DOTENV_PATH names ${file}, which could not be read (ENOENT).`);
  });

  it("never prints a configured secret, a refused Stripe live key included", async () => {
    const dir = stateDir("live-stripe");
    const liveKey = `sk_live_${"9".repeat(24)}`;
    const result = await runBuiltCli(["ask", "--conversation", "unknown", "x"], {
      env: childEnv(dir, { ANTHROPIC_API_KEY: UNUSED_MODEL_KEY, STRIPE_SECRET_KEY: liveKey }),
    });
    // The unknown conversation is refused first; nothing in the output carries a key.
    expect(result.code).toBe(CLI_EXIT_CODES.usage);
    expect(result.stdout + result.stderr).not.toContain(liveKey);
    expect(result.stdout + result.stderr).not.toContain(UNUSED_MODEL_KEY);
  });
});

describe("conversations it refuses (exit 2, no run)", () => {
  it("an unknown --conversation, with the key loaded from the DOTENV_PATH file", async () => {
    const dir = stateDir("unknown-conversation");
    const file = join(dir, "outside.env");
    writeFileSync(file, `ANTHROPIC_API_KEY=${UNUSED_MODEL_KEY}\n`, { mode: 0o600 });
    const result = await runBuiltCli(["ask", "--json", "--conversation", "conv_nope", "x"], {
      env: childEnv(dir, { DOTENV_PATH: file }),
    });
    // Exit 2, not 3: the key came from the file.
    expect(result.code).toBe(CLI_EXIT_CODES.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`No conversation conv_nope in ${dir}.`);
    expect(rowCounts(dir)).toEqual({ conversations: 0, runs: 0 });
  });

  it("a conversation whose run belongs to another live process", async () => {
    const dir = stateDir("busy");
    // Another process (the app's server, say) runs the conversation and is alive.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    try {
      const pid = other.pid;
      if (pid === undefined) throw new Error("no child pid");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const startedAt = systemProcessProbe.startedAt(pid)?.toISOString();
      if (startedAt === undefined) throw new Error("ps could not read the child");
      const database = openDatabase({ path: databasePath(dir) });
      try {
        seedDatabase(database.db, startedAt);
        insertConversation(database.db, { id: "c1", title: "Busy", source: "ui", now: startedAt });
        insertRun(database.db, {
          id: "r_app",
          conversationId: "c1",
          source: "ui",
          mode: "interactive",
          model: "claude-sonnet-5",
          effort: "medium",
          userMessageId: null,
          assistantMessageId: null,
          policy: DEFAULT_POLICY,
          connections: [],
          startedAt,
          owner: { pid, startedAt },
        });
      } finally {
        database.close();
      }
      const result = await runBuiltCli(["ask", "--conversation", "c1", "x"], {
        env: childEnv(dir, { ANTHROPIC_API_KEY: UNUSED_MODEL_KEY }),
      });
      expect(result.code).toBe(CLI_EXIT_CODES.usage);
      expect(result.stderr).toContain("already has an active run");
      expect(rowCounts(dir)).toEqual({ conversations: 1, runs: 1 });
    } finally {
      other.kill("SIGKILL");
    }
  });
});

describe("stopping before a run starts", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s while the prompt is still being read: cancelled, exit 130 within 1.5 s",
    async (signal) => {
      const dir = stateDir("stop");
      const result = await runBuiltCli(["ask", "--json", "-"], {
        env: childEnv(dir, { ANTHROPIC_API_KEY: UNUSED_MODEL_KEY }),
        stdin: { open: true },
        stop: { signal, afterMs: 500 },
      });
      expect(result.code).toBe(CLI_EXIT_CODES.cancelled);
      expect(result.afterSignalMs).not.toBeNull();
      expect(result.afterSignalMs ?? Number.POSITIVE_INFINITY).toBeLessThan(SIGNAL_EXIT_LIMIT_MS);
      expect(onlySummary(result.stdout)).toMatchObject({
        status: "cancelled",
        error: { code: "cancelled" },
      });
      expect(rowCounts(dir)).toBeNull();
    },
  );

  it("--timeout-ms while the prompt is still being read: timed out, exit 124", async () => {
    const dir = stateDir("timeout");
    const result = await runBuiltCli(["ask", "--json", "--timeout-ms", "300", "-"], {
      env: childEnv(dir, { ANTHROPIC_API_KEY: UNUSED_MODEL_KEY }),
      stdin: { open: true },
    });
    expect(result.code).toBe(CLI_EXIT_CODES.timedOut);
    expect(onlySummary(result.stdout)).toMatchObject({
      status: "timed_out",
      error: { code: "timeout" },
    });
  });
});
