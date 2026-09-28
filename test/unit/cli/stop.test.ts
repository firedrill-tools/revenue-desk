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
