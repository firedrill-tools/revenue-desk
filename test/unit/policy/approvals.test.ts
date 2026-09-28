import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDescriptor, ApprovalRequest } from "../../../src/contracts/events.js";
import {
  approvalWaiters,
  CLOSED_REASON,
  createApprovalGate,
  MAX_DECISION_REASON_LENGTH,
  STOP_REASON,
  timeoutReason,
  USER_DENIAL_REASON,
} from "../../../src/policy/approvals.js";
import { MemoryApprovalStore } from "../../helpers/approval-store.js";

const T0 = new Date("2026-09-28T12:00:00.000Z");
const TIMEOUT_MS = 15 * 60_000;
let counter = 0;

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  counter += 1;
  const descriptor: ApprovalDescriptor = {
    consequence: "Refund $49.00 to Kestrel Analytics",
    facts: [{ label: "Charge", value: "ch_2" }],
    amount: { amountMinor: 4900, currency: "USD" },
    actionClass: "financial",
    integration: "stripe",
    connectionKind: "api",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    expiresAt: new Date(T0.getTime() + TIMEOUT_MS).toISOString(),
  };
  return {
    approvalId: `appr_${counter}`,
    runId: "run_1",
    conversationId: "conv_1",
    toolCallId: `toolu_${counter}`,
    descriptor,
    ...overrides,
  };
}

describe("the approval gate", () => {
  let store: MemoryApprovalStore;
  let now: Date;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    now = T0;
    store = new MemoryApprovalStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    approvalWaiters().clear();
  });

  const gate = () => createApprovalGate({ store, now: () => now });

  it("persists the pending row and registers the waiter before open() resolves", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, new AbortController().signal);
    expect(store.rows.get(entry.approvalId)).toMatchObject({
      status: "pending",
      requestedAt: T0.toISOString(),
      expiresAt: entry.descriptor.expiresAt,
      toolCallId: entry.toolCallId,
    });
    expect(approvals.pendingIds()).toContain(entry.approvalId);
    expect(approvalWaiters().has(entry.approvalId)).toBe(true);
    expect(pending.decision).toBeInstanceOf(Promise);
  });

  it("settles once when the user approves, recording who decided", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, new AbortController().signal);
    now = new Date(T0.getTime() + 5_000);
    expect(approvals.decide(entry.approvalId, { approved: true, reason: "  looks right " })).toBe(
      "accepted",
    );
    await expect(pending.decision).resolves.toEqual({
      approved: true,
      decidedBy: "user",
      reason: "looks right",
    });
    expect(store.rows.get(entry.approvalId)?.settlement).toEqual({
      status: "approved",
      decidedBy: "user",
      reason: "looks right",
      decidedAt: now.toISOString(),
    });
    expect(approvals.decide(entry.approvalId, { approved: false })).toBe("already_decided");
    expect(approvals.pendingIds()).not.toContain(entry.approvalId);
  });

  it("records a denial by the user as decided by the user, never as approved", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, new AbortController().signal);
    expect(approvals.decide(entry.approvalId, { approved: false })).toBe("accepted");
    await expect(pending.decision).resolves.toEqual({
      approved: false,
      decidedBy: "user",
      reason: USER_DENIAL_REASON,
    });
    expect(store.rows.get(entry.approvalId)).toMatchObject({
      status: "denied",
      settlement: { decidedBy: "user", reason: null },
    });
  });

  it("clips a long reason", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, new AbortController().signal);
    approvals.decide(entry.approvalId, { approved: false, reason: "x".repeat(900) });
    const outcome = await pending.decision;
    expect(outcome.reason).toHaveLength(MAX_DECISION_REASON_LENGTH);
  });

  it("answers 404 for an unknown id and 409 for a row that is no longer waiting", () => {
    const approvals = gate();
    expect(approvals.decide("appr_missing", { approved: true })).toBe("not_found");
    store.rows.set("appr_old", {
      ...request({ approvalId: "appr_old" }),
      requestedAt: T0.toISOString(),
      expiresAt: T0.toISOString(),
      status: "expired",
      settlement: null,
    });
    expect(approvals.decide("appr_old", { approved: true })).toBe("already_decided");
  });

  it("denies as timed out at expiresAt and records it as expired", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, new AbortController().signal);
    let settled = false;
    void pending.decision.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    now = new Date(T0.getTime() + TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending.decision).resolves.toEqual({
      approved: false,
      decidedBy: "timeout",
      reason: timeoutReason(TIMEOUT_MS),
    });
    expect(timeoutReason(TIMEOUT_MS)).toBe(
      "Not approved within 15 minutes; the action was not run.",
    );
    expect(store.rows.get(entry.approvalId)).toMatchObject({
      status: "expired",
      settlement: { decidedBy: "timeout" },
    });
    expect(approvals.decide(entry.approvalId, { approved: true })).toBe("already_decided");
  });

  it("denies as stopped when the run's signal aborts, and records it as cancelled", async () => {
    const approvals = gate();
    const entry = request();
    const stop = new AbortController();
    const pending = await approvals.open(entry, stop.signal);
    stop.abort("user");
    await expect(pending.decision).resolves.toEqual({
      approved: false,
      decidedBy: "stop",
      reason: STOP_REASON,
    });
    expect(store.rows.get(entry.approvalId)).toMatchObject({
      status: "cancelled",
      settlement: { decidedBy: "stop", reason: STOP_REASON },
    });
    // The timer is gone too: nothing settles twice.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(store.rows.get(entry.approvalId)?.settlement?.decidedBy).toBe("stop");
  });

  it("settles at once when the signal was already aborted", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, AbortSignal.abort("shutdown"));
    await expect(pending.decision).resolves.toMatchObject({ decidedBy: "stop" });
    expect(store.rows.get(entry.approvalId)?.status).toBe("cancelled");
  });

  it("refuses the approval when the pending row cannot be written", async () => {
    store.failInsert = true;
    const entry = request();
    await expect(gate().open(entry, new AbortController().signal)).rejects.toThrow(
      "database is locked",
    );
    expect(approvalWaiters().has(entry.approvalId)).toBe(false);
  });

  it("fails closed when the row was closed behind the waiter's back", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, new AbortController().signal);
    const row = store.rows.get(entry.approvalId);
    if (row !== undefined) row.status = "expired";
    expect(approvals.decide(entry.approvalId, { approved: true })).toBe("already_decided");
    await expect(pending.decision).resolves.toEqual({
      approved: false,
      decidedBy: "user",
      reason: CLOSED_REASON,
    });
  });

  it("keeps the waiter when recording the user's decision fails, so it can be retried", async () => {
    const approvals = gate();
    const entry = request();
    const pending = await approvals.open(entry, new AbortController().signal);
    const settle = vi.spyOn(store, "settle").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => approvals.decide(entry.approvalId, { approved: true })).toThrow("disk full");
    expect(approvals.decide(entry.approvalId, { approved: true })).toBe("accepted");
    await expect(pending.decision).resolves.toMatchObject({ approved: true });
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("still settles a timeout or stop when the store fails, and reports the failure", async () => {
    const errors: unknown[] = [];
    const approvals = createApprovalGate({
      store,
      now: () => now,
      onError: (error) => errors.push(error),
    });
    vi.spyOn(store, "settle").mockImplementation(() => {
      throw new Error("disk full");
    });
    const stop = new AbortController();
    const pending = await approvals.open(request(), stop.signal);
    stop.abort("user");
    await expect(pending.decision).resolves.toMatchObject({ approved: false, decidedBy: "stop" });
    expect(errors).toHaveLength(1);
  });

  it("reaches a waiter through any gate instance (the registry lives on globalThis)", async () => {
    const entry = request();
    const pending = await gate().open(entry, new AbortController().signal);
    expect(gate().decide(entry.approvalId, { approved: true })).toBe("accepted");
    await expect(pending.decision).resolves.toMatchObject({ approved: true });
  });

  it("refuses a descriptor without a valid expiry and a duplicate id", async () => {
    const approvals = gate();
    const bad = request();
    await expect(
      approvals.open(
        { ...bad, descriptor: { ...bad.descriptor, expiresAt: "soon" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(RangeError);
    const entry = request();
    await approvals.open(entry, new AbortController().signal);
    await expect(approvals.open(entry, new AbortController().signal)).rejects.toThrow(
      "already waiting",
    );
  });
});
