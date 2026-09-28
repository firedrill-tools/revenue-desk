// The CLI's view of its process: streams, stdin, environment and signals.
// src/cli/process.ts implements it over `process`; tests pass their own.

import type { EnvironmentRecord } from "./ports.js";
import type { OutputStream } from "./stdout-guard.js";
import type { CliSignal } from "./stop.js";

export interface CliIo {
  /** The guarded stdout: the only writer that reaches file descriptor 1. */
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  /** All of stdin as UTF-8, for `ask -`. */
  readStdin(): Promise<string>;
  /** A snapshot of process.env; never mutated. */
  readonly environment: EnvironmentRecord;
  readonly cwd: string;
  /** Subscribes to SIGINT and SIGTERM; returns the unsubscribe function. */
  onSignal(listener: (signal: CliSignal) => void): () => void;
}
