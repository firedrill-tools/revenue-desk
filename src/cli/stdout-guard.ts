// Keeps stdout for the CLI's own output (docs/ARCHITECTURE.md §10).
//
// Installed by src/cli/main.ts before any module with side effects is
// imported. Afterwards every `process.stdout.write` and every `console.*`
// call goes to stderr, so a library that logs (a version banner, a debug
// line) can never corrupt `--json` output. Only the writer returned here
// reaches file descriptor 1.
//
// This module must stay free of side-effect imports.

import { Console } from "node:console";

export interface OutputStream {
  write(text: string): void;
  /** Resolves once everything written so far has been handed to the OS. */
  flush(): Promise<void>;
  readonly isTTY: boolean;
}

const CONSOLE_METHODS = [
  "assert",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "warn",
] as const satisfies readonly (keyof Console)[];

const INSTALLED = Symbol.for("revenue-desk.cli.stdout-guard");

type GuardHost = { [INSTALLED]?: OutputStream };

/**
 * Redirects stdout and the global console to stderr and returns the only
 * writer that still reaches stdout. Idempotent: a second call returns the
 * first writer.
 */
export function installStdoutGuard(): OutputStream {
  const host = globalThis as GuardHost;
  const installed = host[INSTALLED];
  if (installed !== undefined) return installed;

  const { stdout, stderr } = process;
  const writeStdout = stdout.write.bind(stdout);
  stdout.write = stderr.write.bind(stderr);

  const errorConsole = new Console({ stdout: stderr, stderr });
  for (const name of CONSOLE_METHODS) {
    Object.defineProperty(console, name, {
      value: errorConsole[name].bind(errorConsole),
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // A closed pipe (`revenue-desk ask … | head -1`) must not crash the run.
  stdout.on("error", ignoreBrokenPipe);
  stderr.on("error", ignoreBrokenPipe);

  const guarded = writerFor((text, done) => writeStdout(text, done), stdout.isTTY === true);
  host[INSTALLED] = guarded;
  return guarded;
}

/** A writer for stderr with the same flush semantics. */
export function stderrStream(): OutputStream {
  const { stderr } = process;
  return writerFor((text, done) => stderr.write(text, done), stderr.isTTY === true);
}

function writerFor(write: (text: string, done: () => void) => void, isTTY: boolean): OutputStream {
  let drained: Promise<void> = Promise.resolve();
  return {
    isTTY,
    write(text) {
      if (text === "") return;
      // Callbacks run in write order, so the last one settles after all earlier writes.
      drained = new Promise((resolve) => write(text, () => resolve()));
    },
    flush: () => drained,
  };
}

function ignoreBrokenPipe(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") return;
  throw error;
}
