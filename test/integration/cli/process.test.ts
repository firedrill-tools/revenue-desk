/**
 * `revenue-desk` as a real process: stdout purity, exit codes, stdin,
 * DOTENV_PATH and signals. src/cli/main.ts is spawned for what needs no
 * agent (help, version, usage); support/fake-cli.ts, which starts the same
 * way with the fake services, for runs. Each child gets an explicit
 * environment, never this process's, so no real key can reach it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../../../src/contracts/cli.js";
import { REPLY_TEXT, type Scenario, WAITING_MARKER } from "./support/fake-services.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAIN = join(ROOT, "src/cli/main.ts");
const FAKE_CLI = join(ROOT, "test/integration/cli/support/fake-cli.ts");
const API_KEY = `sk-ant-process-test-${"k".repeat(24)}`;
/** The CLI's promise: a signal ends the process within about 1.5 seconds. */
const SIGNAL_EXIT_LIMIT_MS = 1_500;
const TEST_TIMEOUT_MS = 20_000;

type Finished = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitedAt: number;
};

type Running = {
  readonly child: ChildProcess;
  readonly finished: Promise<Finished>;
  /** Resolves once stderr contains `text`. */
  stderrContains(text: string): Promise<void>;
};

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "revenue-desk-cli-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function launch(
  entry: string,
  args: readonly string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Running {
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: { text: string; resolve: () => void }[] = [];
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    for (const waiter of waiters.filter((candidate) => stderr.includes(candidate.text))) {
      waiter.resolve();
    }
  });
  child.stdin?.end(options.stdin ?? "");
  const finished = new Promise<Finished>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr, exitedAt: performance.now() }),
    );
  });
  return {
    child,
    finished,
    stderrContains: (text) =>
      new Promise<void>((resolve, reject) => {
        if (stderr.includes(text)) return resolve();
        waiters.push({ text, resolve });
        void finished.then(() =>
          reject(new Error(`exited before stderr showed "${text}":\n${stderr}`)),
        );
      }),
  };
}

function fakeRun(
  scenario: Scenario,
  args: readonly string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Running {
  return launch(FAKE_CLI, ["ask", "--state-dir", stateDir, ...args], {
    ...options,
    env: {
      ANTHROPIC_API_KEY: API_KEY,
      FAKE_SCENARIO: scenario,
      FAKE_RECORD_LOG: join(stateDir, "recorded.jsonl"),
      ...options.env,
    },
  });
}

/** stdout must be exactly one JSON document followed by one newline. */
function onlySummary(stdout: string): RunSummary {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.slice(0, -1)).not.toContain("\n");
  const summary = JSON.parse(stdout) as RunSummary;
  expect(summary.kind).toBe("revenue-desk.run-summary");
  return summary;
}

function recordedTypes(): { type: string; status?: string; error?: { message: string } }[] {
  return readFileSync(join(stateDir, "recorded.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
}

describe("src/cli/main.ts", () => {
  it("starts with a shebang and imports only the stdout guard before running", () => {
    const source = readFileSync(MAIN, "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const staticImports = [...source.matchAll(/^import .* from "(.+)";$/gm)].map(
      (match) => match[1],
    );
    expect(staticImports).toEqual(["./stdout-guard.js"]);
    expect(source.indexOf("installStdoutGuard()")).toBeLessThan(source.indexOf("await import("));
  });

  it(
    "prints help on stdout and exits 0",
    async () => {
      const result = await launch(MAIN, ["--help"]).finished;
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^Usage: revenue-desk ask \[options\] <prompt>\n/);
      expect(result.stderr).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "prints the package version",
    async () => {
      const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        version: string;
      };
      const result = await launch(MAIN, ["--version"]).finished;
      expect(result).toMatchObject({ code: 0, stdout: `${version}\n` });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 2 on a usage error with nothing on stdout",
    async () => {
      const result = await launch(MAIN, ["ask", "--json"]).finished;
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("'ask' needs a prompt");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("stdout purity", () => {
  it(
    "prints exactly one RunSummary with --json while modules log to stdout",
    async () => {
      const result = await fakeRun("noisy", ["--json", "Why was Kestrel charged twice?"]).finished;
      expect(result.code).toBe(0);
      const summary = onlySummary(result.stdout);
      expect(summary).toMatchObject({ status: "completed", reply: REPLY_TEXT, mode: "headless" });
      // The noise went to stderr instead.
      expect(result.stderr).toContain("noisy module: console.log at import");
      expect(result.stderr).toContain("noisy module: process.stdout.write at import");
      expect(result.stderr).toContain("noisy: console.log during the run");
      expect(result.stderr).toContain("noisy: process.stdout.write");
      expect(result.stderr).toContain("console.dir");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "prints only the reply on stdout without --json",
    async () => {
      const result = await fakeRun("noisy", ["Why was Kestrel charged twice?"]).finished;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${REPLY_TEXT}\n`);
      expect(result.stderr).toContain("Done in 2.4 s");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads the prompt from stdin",
    async () => {
      const result = await fakeRun("reply", ["--json", "-"], {
        stdin: "Why was Kestrel charged twice?\n",
      }).finished;
      expect(result.code).toBe(0);
      expect(onlySummary(result.stdout).status).toBe("completed");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("exit codes", () => {
  it(
    "is 1 for a failed run, with the summary",
    async () => {
      const result = await fakeRun("model-error", ["--json", "x"]).finished;
      expect(result.code).toBe(1);
      expect(onlySummary(result.stdout).error?.code).toBe("model_error");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is 3 without ANTHROPIC_API_KEY, with the summary",
    async () => {
      const result = await fakeRun("reply", ["--json", "x"], { env: { ANTHROPIC_API_KEY: "" } })
        .finished;
      expect(result.code).toBe(3);
      expect(onlySummary(result.stdout).error?.code).toBe("config_missing");
      expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is 2 for a usage error, without a summary",
    async () => {
      const result = await fakeRun("reply", ["--json", "--max-turns", "0", "x"]).finished;
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is 124 when --timeout-ms passes",
    async () => {
      const result = await fakeRun("wait-for-stop", ["--json", "--timeout-ms", "300", "x"])
        .finished;
      expect(result.code).toBe(124);
      expect(onlySummary(result.stdout).status).toBe("timed_out");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("DOTENV_PATH and secrets", () => {
  it(
    "loads ANTHROPIC_API_KEY from the DOTENV_PATH file",
    async () => {
      const file = join(stateDir, "outside.env");
      writeFileSync(file, `ANTHROPIC_API_KEY=${API_KEY}\n`);
      const result = await fakeRun("reply", ["--json", "x"], {
        env: { ANTHROPIC_API_KEY: "", DOTENV_PATH: file },
      }).finished;
      expect(result.code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 3 when the DOTENV_PATH file is missing and names only the path",
    async () => {
      const file = join(stateDir, "missing.env");
      const result = await fakeRun("reply", ["x"], { env: { DOTENV_PATH: file } }).finished;
      expect(result.code).toBe(3);
      expect(result.stderr).toContain(
        `DOTENV_PATH names ${file}, which could not be read (ENOENT).`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never prints the key, even when an error message contains it",
    async () => {
      const result = await fakeRun("throw", ["--json", "x"]).finished;
      expect(result.code).toBe(1);
      expect(onlySummary(result.stdout).error?.message).toBe(
        "The agent failed: upstream rejected key [redacted]",
      );
      expect(result.stdout + result.stderr).not.toContain(API_KEY);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("signals", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s stops the run: summary cancelled, exit 130 within 1.5 s",
    async (signal) => {
      const run = fakeRun("wait-for-stop", ["--json", "x"]);
      await run.stderrContains(WAITING_MARKER);
      const sentAt = performance.now();
      run.child.kill(signal);
      const result = await run.finished;
      expect(result.code).toBe(130);
      expect(result.exitedAt - sentAt).toBeLessThan(SIGNAL_EXIT_LIMIT_MS);
      expect(onlySummary(result.stdout)).toMatchObject({
        status: "cancelled",
        error: { code: "cancelled" },
      });
      expect(recordedTypes().at(-1)).toMatchObject({ type: "run.finished", status: "cancelled" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 130 within 1.5 s even when the agent ignores the stop",
    async () => {
      const run = fakeRun("ignore-stop", ["--json", "x"]);
      await run.stderrContains(WAITING_MARKER);
      const sentAt = performance.now();
      run.child.kill("SIGTERM");
      const result = await run.finished;
      expect(result.code).toBe(130);
      expect(result.exitedAt - sentAt).toBeLessThan(SIGNAL_EXIT_LIMIT_MS);
      expect(onlySummary(result.stdout).error).toEqual({
        code: "cancelled",
        message: "Stopped by SIGTERM; the agent did not confirm the stop in time.",
      });
      expect(recordedTypes().at(-1)).toMatchObject({ type: "run.finished", status: "cancelled" });
    },
    TEST_TIMEOUT_MS,
  );
});
