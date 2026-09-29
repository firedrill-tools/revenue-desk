// Signals that arrive while the CLI is still loading (docs/ARCHITECTURE.md §10).
//
// src/cli/main.ts installs this right after the stdout guard, before it
// imports the rest of the CLI, which takes a moment (the agent SDK, the
// database, the integrations). Without it a Ctrl-C or SIGTERM in that moment
// meets Node's default handler and ends the process at once: no --json
// summary and no exit code 130. A signal that arrives before the run
// subscribes is kept and delivered, in order, to the first subscriber. Once
// the run has unsubscribed, a signal ends the process as Node's default
// would.
//
// This module must stay free of side-effect imports.

import type { CliSignal } from "./stop.js";

const SIGNALS: readonly CliSignal[] = ["SIGINT", "SIGTERM"];

/** The part of `process` the buffer uses; tests pass their own. */
export interface SignalTarget {
  on(signal: CliSignal, handler: () => void): unknown;
  off(signal: CliSignal, handler: () => void): unknown;
  kill(pid: number, signal: CliSignal): unknown;
  readonly pid: number;
}

export interface SignalBuffer {
  /** Subscribes to SIGINT and SIGTERM; signals kept since start are delivered first. */
  onSignal(listener: (signal: CliSignal) => void): () => void;
  /**
   * The command finished: signals kept for a run that never came are
   * dropped, and a signal while nothing listens ends the process as Node's
   * default would.
   */
  release(): void;
}

const INSTALLED = Symbol.for("revenue-desk.cli.early-signals");

type BufferHost = { [INSTALLED]?: SignalBuffer };

/**
 * Starts listening for SIGINT and SIGTERM now. Idempotent for the real
 * process: a second call returns the first buffer.
 */
export function installSignalBuffer(target: SignalTarget = process): SignalBuffer {
  const host = globalThis as BufferHost;
  if (target === process && host[INSTALLED] !== undefined) return host[INSTALLED];

  const listeners = new Set<(signal: CliSignal) => void>();
  const kept: CliSignal[] = [];
  let subscribed = false;
  const handlers = SIGNALS.map((signal) => ({ signal, handler: () => receive(signal) }));

  function receive(signal: CliSignal): void {
    if (listeners.size > 0) {
      for (const listener of [...listeners]) listener(signal);
    } else if (!subscribed) {
      kept.push(signal);
    } else {
      // Nothing listens any more: end the process as Node's default handler would.
      for (const { signal: name, handler } of handlers) target.off(name, handler);
      target.kill(target.pid, signal);
    }
  }

  for (const { signal, handler } of handlers) target.on(signal, handler);

  const buffer: SignalBuffer = {
    onSignal(listener) {
      listeners.add(listener);
      subscribed = true;
      const early = kept.splice(0);
      if (early.length > 0) {
        // After the subscriber has finished setting up.
        queueMicrotask(() => {
          for (const signal of early) if (listeners.has(listener)) listener(signal);
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
    release() {
      subscribed = true;
      kept.length = 0;
    },
  };
  if (target === process) host[INSTALLED] = buffer;
  return buffer;
}
