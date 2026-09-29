// The CLI's signal buffer (src/cli/early-signals.ts): a SIGINT or SIGTERM
// that arrives while the CLI is still loading reaches the run once it
// listens, instead of Node's default handler ending the process without a
// summary. The target is an in-memory stand-in for `process`.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installSignalBuffer, type SignalTarget } from "../../../src/cli/early-signals.js";
import type { CliSignal } from "../../../src/cli/stop.js";

function processStub() {
  const emitter = new EventEmitter();
  const killed: CliSignal[] = [];
  const target: SignalTarget = {
    pid: 4242,
    on: (signal, handler) => emitter.on(signal, handler),
    off: (signal, handler) => emitter.off(signal, handler),
    kill: (_pid, signal) => killed.push(signal),
  };
  const send = (signal: CliSignal) => emitter.emit(signal);
  const listening = () => emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM");
  return { target, send, killed, listening };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("installSignalBuffer", () => {
  it("listens from the start, so an early signal never meets Node's default", () => {
    const host = processStub();
    installSignalBuffer(host.target);
    expect(host.listening()).toBe(2);
    host.send("SIGINT");
    expect(host.killed).toEqual([]);
  });

  it("delivers signals that came while loading to the first subscriber, in order", async () => {
    const host = processStub();
    const buffer = installSignalBuffer(host.target);
    host.send("SIGINT");
    host.send("SIGTERM");
    const received: CliSignal[] = [];
    buffer.onSignal((signal) => received.push(signal));
    // After the subscriber finished setting up.
    expect(received).toEqual([]);
    await flush();
    expect(received).toEqual(["SIGINT", "SIGTERM"]);
    host.send("SIGINT");
    expect(received).toEqual(["SIGINT", "SIGTERM", "SIGINT"]);
    expect(host.killed).toEqual([]);
  });

  it("delivers a signal once: a later subscriber does not get it again", async () => {
    const host = processStub();
    const buffer = installSignalBuffer(host.target);
    host.send("SIGTERM");
    const first: CliSignal[] = [];
    const unsubscribe = buffer.onSignal((signal) => first.push(signal));
    await flush();
    unsubscribe();
    const second: CliSignal[] = [];
    buffer.onSignal((signal) => second.push(signal));
    await flush();
    expect(first).toEqual(["SIGTERM"]);
    expect(second).toEqual([]);
  });

  it("ends the process as Node would once the run stopped listening", () => {
    const host = processStub();
    const buffer = installSignalBuffer(host.target);
    const unsubscribe = buffer.onSignal(() => {
      throw new Error("unsubscribed listeners get nothing");
    });
    unsubscribe();
    host.send("SIGINT");
    expect(host.killed).toEqual(["SIGINT"]);
    // Its handlers are gone, so the re-sent signal meets Node's default.
    expect(host.listening()).toBe(0);
  });

  it("drops a kept signal when the command finished without a run", async () => {
    const host = processStub();
    const buffer = installSignalBuffer(host.target);
    host.send("SIGINT");
    buffer.release();
    const received: CliSignal[] = [];
    buffer.onSignal((signal) => received.push(signal));
    await flush();
    expect(received).toEqual([]);
    host.send("SIGTERM");
    expect(received).toEqual(["SIGTERM"]);
  });

  it("after release, a signal while nothing listens ends the process", () => {
    const host = processStub();
    const buffer = installSignalBuffer(host.target);
    buffer.release();
    host.send("SIGTERM");
    expect(host.killed).toEqual(["SIGTERM"]);
  });
});
