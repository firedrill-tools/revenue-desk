// Runs the CLI in this Node process: real streams, stdin, environment and
// signals, then exits with the outcome's code once the output is flushed.
// Imported by src/cli/main.ts only after the stdout guard is installed.

import { randomUUID } from "node:crypto";
import { CLI_EXIT_CODES, CLI_NAME } from "../contracts/cli.js";
import { runCli } from "./cli.js";
import { installSignalBuffer } from "./early-signals.js";
import type { CliIo } from "./io.js";
import type { AskServices } from "./ports.js";
import { createServices } from "./services.js";
import { type OutputStream, stderrStream } from "./stdout-guard.js";
import { packageVersion } from "./version.js";

/** How long a stopped run may take to finish itself; the process exits within about 1.5 s. */
export const STOP_GRACE_MS = 1_000;
/** How long the core may take to close its connections after the run finished. */
export const CLEANUP_MS = 250;

export type ProcessOptions = {
  /** Replaces the production composition root (tests only). */
  readonly loadServices?: () => Promise<AskServices>;
};

export async function runCliProcess(
  stdout: OutputStream,
  options: ProcessOptions = {},
): Promise<never> {
  const stderr = stderrStream();
  const io: CliIo = {
    stdout,
    stderr,
    readStdin,
    environment: { ...process.env },
    cwd: process.cwd(),
    // main.ts installed the buffer before loading this module, so a signal
    // that came while it loaded reaches the run.
    onSignal: (listener) => installSignalBuffer().onSignal(listener),
  };
  let code: number;
  try {
    code = await runCli(process.argv.slice(2), {
      io,
      version: packageVersion(),
      loadServices: options.loadServices ?? createServices,
      stopGraceMs: STOP_GRACE_MS,
      cleanupMs: CLEANUP_MS,
      now: () => new Date(),
      newId: randomUUID,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${CLI_NAME}: internal error: ${message}\n`);
    code = CLI_EXIT_CODES.failed;
  }
  // From here a signal ends the process at once, even while the output drains.
  installSignalBuffer().release();
  await Promise.all([stdout.flush(), stderr.flush()]);
  // No work continues after the output is written: open handles of the run
  // (model streams, MCP children) must not keep the process alive.
  process.exit(code);
}

async function readStdin(): Promise<string> {
  // A string decoder keeps multi-byte characters intact across chunks.
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}
