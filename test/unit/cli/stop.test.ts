import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_STOP_REASON, StopController } from "../../../src/cli/stop.js";

describe("StopController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function tracked(stopper: StopController) {
    const state = { forced: false };
    void stopper.forced.then(() => {
      state.forced = true;
    });
    return state;
  }

  it("maps SIGINT to user and SIGTERM to shutdown", () => {
    expect(SIGNAL_STOP_REASON).toEqual({ SIGINT: "user", SIGTERM: "shutdown" });
  });

  it("aborts with the first reason and forces after the grace period", async () => {
    const stopper = new StopController({ graceMs: 1_000 });
    const state = tracked(stopper);
    stopper.stop({ reason: "user", cause: "SIGINT" });
    expect(stopper.signal.aborted).toBe(true);
    expect(stopper.signal.reason).toBe("user");
    expect(stopper.request).toEqual({ reason: "user", cause: "SIGINT" });

    await vi.advanceTimersByTimeAsync(999);
    expect(state.forced).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.forced).toBe(true);
    stopper.dispose();
  });

  it("forces at once on a second request and keeps the first reason", async () => {
    const stopper = new StopController({ graceMs: 1_000 });
    const state = tracked(stopper);
    stopper.stop({ reason: "shutdown", cause: "SIGTERM" });
    stopper.stop({ reason: "user", cause: "SIGINT" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.forced).toBe(true);
    expect(stopper.signal.reason).toBe("shutdown");
    stopper.dispose();
  });

  it("waits for an executing write after the grace period, up to the hold's limit", async () => {
    const stopper = new StopController({ graceMs: 1_000 });
    const state = tracked(stopper);
    let writing = true;
    const notices: string[] = [];
    stopper.holdWhile(
      () => writing,
      60_000,
      () => notices.push("waiting"),
    );
    stopper.stop({ reason: "user", cause: "SIGINT" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.forced).toBe(false);
    expect(notices).toEqual(["waiting"]);
    // The write settled: the stop completes.
    writing = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(state.forced).toBe(true);
    stopper.dispose();

    // A write that never settles is given up at the limit.
    const stuck = new StopController({ graceMs: 1_000 });
    const stuckState = tracked(stuck);
    stuck.holdWhile(() => true, 60_000);
    stuck.stop({ reason: "timeout", cause: "the time limit" });
    await vi.advanceTimersByTimeAsync(60_500);
    expect(stuckState.forced).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stuckState.forced).toBe(true);
    stuck.dispose();
  });

  it("a second request skips the wait for a write", async () => {
    const stopper = new StopController({ graceMs: 1_000 });
    const state = tracked(stopper);
    stopper.holdWhile(() => true, 60_000);
    stopper.stop({ reason: "user", cause: "SIGINT" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.forced).toBe(false);
    stopper.stop({ reason: "user", cause: "SIGINT" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.forced).toBe(true);
    stopper.dispose();
  });

  it("stops with reason timeout when the time limit passes", async () => {
    const stopper = new StopController({ graceMs: 1_000 });
    stopper.limitTo(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stopper.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopper.signal.reason).toBe("timeout");
    expect(stopper.request?.cause).toBe("the 5000 ms time limit");
    stopper.dispose();
  });

  it("refuses a time limit Node's timers cannot hold, and keeps the largest one waiting", async () => {
    const stopper = new StopController({ graceMs: 1_000 });
    expect(() => stopper.limitTo(3_000_000_000)).toThrow(RangeError);
    expect(() => stopper.limitTo(0)).toThrow(RangeError);
    stopper.limitTo(2_147_483_647);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopper.signal.aborted).toBe(false);
    stopper.dispose();
  });

  it("a signal before the time limit cancels the limit", async () => {
    const stopper = new StopController({ graceMs: 100 });
    stopper.limitTo(5_000);
    stopper.stop({ reason: "user", cause: "SIGINT" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopper.signal.reason).toBe("user");
    stopper.dispose();
  });

  it("dispose() clears every timer, including the keep-alive handle", () => {
    const stopper = new StopController({ graceMs: 1_000 });
    stopper.limitTo(5_000);
    expect(vi.getTimerCount()).toBe(2);
    stopper.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
