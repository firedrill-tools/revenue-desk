// Approval waiters (docs/ARCHITECTURE.md §7): the ApprovalGate the agent core
// calls for an `ask` decision, and the decide() entry point behind
// POST /api/approvals/:id.
//
// open() persists the pending row through the injected ApprovalStore (W3
// implements it over SQLite), registers a waiter, and resolves. The waiter
// settles exactly once: by the user (decide), by the timeout (the
// descriptor's expiresAt), or by the run's signal (Stop). Every settlement is
// recorded through the store before the core learns of it.
//
// Waiters live in a Map on globalThis, keyed by approval id, so a decision
// reaches its waiter even when a bundler or watcher loaded this module twice.

import type {
  ApprovalDecider,
  ApprovalGate,
  ApprovalOutcome,
  ApprovalRequest,
  PendingApproval,
} from "../contracts/events.js";

export type ApprovalStatusAfterDecision = "approved" | "denied" | "expired" | "cancelled";

/** How a pending approval was settled, as the approvals row records it. */
export type ApprovalSettlement = {
  readonly status: ApprovalStatusAfterDecision;
  readonly decidedBy: ApprovalDecider;
  /** The user's reason, or the system's explanation for a timeout or stop. */
  readonly reason: string | null;
  readonly decidedAt: string;
};

export type PendingApprovalRecord = ApprovalRequest & {
  readonly requestedAt: string;
  readonly expiresAt: string;
};

/**
 * Persistence for approvals (W3: the approvals table). Synchronous, like
 * better-sqlite3, so a decision is recorded atomically with its settlement.
 */
export interface ApprovalStore {
  /** Inserts the pending row. Throwing refuses the approval (the call is not run). */
  insertPending(record: PendingApprovalRecord): void;
  /** Settles a pending row; returns false when the row was not pending any more. */
  settle(approvalId: string, settlement: ApprovalSettlement): boolean;
  /** Whether a row with this id exists in any status (tells 404 from 409). */
  exists(approvalId: string): boolean;
}

export type ApprovalDecision = {
  readonly approved: boolean;
  /** Up to 500 characters; shown to the model when denying. */
  readonly reason?: string | null;
};

/** The HTTP outcome of a decision: 202 accepted, 404, or 409 already_decided. */
export type DecideResult = "accepted" | "not_found" | "already_decided";

export interface ApprovalGateController extends ApprovalGate {
  decide(approvalId: string, decision: ApprovalDecision): DecideResult;
  /** Ids of approvals waiting in this process. */
  pendingIds(): string[];
}

export const MAX_DECISION_REASON_LENGTH = 500;

export const USER_DENIAL_REASON = "Declined by the user.";
export const STOP_REASON = "The run was stopped before this action was approved.";
export const CLOSED_REASON = "This approval was already closed.";

export function timeoutReason(waitedMs: number): string {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000));
  return `Not approved within ${minutes} minute${minutes === 1 ? "" : "s"}; the action was not run.`;
}

type SettleRequest =
  | { readonly by: "user"; readonly approved: boolean; readonly reason: string | null }
  | { readonly by: "timeout" }
  | { readonly by: "stop" };

interface Waiter {
  readonly approvalId: string;
  readonly runId: string;
  /** Returns the HTTP-facing result; settles at most once. */
  settle(request: SettleRequest): DecideResult;
}

const REGISTRY_KEY = Symbol.for("revenue-desk.approval-waiters");

type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: Map<string, Waiter> };

/** The process-wide waiter map (approval id to waiter). */
export function approvalWaiters(): Map<string, Waiter> {
  const holder = globalThis as GlobalWithRegistry;
  holder[REGISTRY_KEY] ??= new Map<string, Waiter>();
  return holder[REGISTRY_KEY];
}

export type ApprovalGateOptions = {
  readonly store: ApprovalStore;
  readonly now?: () => Date;
  /** Store failures while settling by timeout or stop (the waiter still settles, denied). */
  readonly onError?: (error: unknown, context: { readonly approvalId: string }) => void;
};

function clip(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  const trimmed = reason.trim();
  if (trimmed === "") return null;
  return [...trimmed].slice(0, MAX_DECISION_REASON_LENGTH).join("");
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGateController {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const waiters = approvalWaiters();

  const open = async (request: ApprovalRequest, signal: AbortSignal): Promise<PendingApproval> => {
    const requestedAt = now();
    const expiresAt = request.descriptor.expiresAt;
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) throw new RangeError("The approval has no valid expiresAt.");
    if (waiters.has(request.approvalId)) throw new Error("The approval id is already waiting.");

    store.insertPending({ ...request, requestedAt: requestedAt.toISOString(), expiresAt });

    let resolveDecision: (outcome: ApprovalOutcome) => void = () => {};
    const decision = new Promise<ApprovalOutcome>((resolve) => {
      resolveDecision = resolve;
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => waiter.settle({ by: "stop" });

    const finish = (outcome: ApprovalOutcome) => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      waiters.delete(request.approvalId);
      resolveDecision(outcome);
    };

    const persistQuietly = (settlement: ApprovalSettlement) => {
      try {
        store.settle(request.approvalId, settlement);
      } catch (error) {
        options.onError?.(error, { approvalId: request.approvalId });
      }
    };

    const waiter: Waiter = {
      approvalId: request.approvalId,
      runId: request.runId,
      settle(settle) {
        if (settled) return "already_decided";
        const decidedAt = now().toISOString();
        if (settle.by === "user") {
          // Throws on a store failure: nothing settles and the caller sees an error.
          const recorded = store.settle(request.approvalId, {
            status: settle.approved ? "approved" : "denied",
            decidedBy: "user",
            reason: settle.reason,
            decidedAt,
          });
          if (!recorded) {
            finish({ approved: false, decidedBy: "user", reason: CLOSED_REASON });
            return "already_decided";
          }
          finish(
            settle.approved
              ? { approved: true, decidedBy: "user", reason: settle.reason }
              : { approved: false, decidedBy: "user", reason: settle.reason ?? USER_DENIAL_REASON },
          );
          return "accepted";
        }
        if (settle.by === "timeout") {
          const reason = timeoutReason(expiresAtMs - requestedAt.getTime());
          persistQuietly({ status: "expired", decidedBy: "timeout", reason, decidedAt });
          finish({ approved: false, decidedBy: "timeout", reason });
          return "accepted";
        }
        persistQuietly({ status: "cancelled", decidedBy: "stop", reason: STOP_REASON, decidedAt });
        finish({ approved: false, decidedBy: "stop", reason: STOP_REASON });
        return "accepted";
      },
    };

    waiters.set(request.approvalId, waiter);
    if (signal.aborted) {
      waiter.settle({ by: "stop" });
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => waiter.settle({ by: "timeout" }),
        Math.max(0, expiresAtMs - requestedAt.getTime()),
      );
      timer.unref();
    }
    return { decision };
  };

  const decide = (approvalId: string, decision: ApprovalDecision): DecideResult => {
    const waiter = waiters.get(approvalId);
    if (waiter === undefined) return store.exists(approvalId) ? "already_decided" : "not_found";
    return waiter.settle({
      by: "user",
      approved: decision.approved,
      reason: clip(decision.reason),
    });
  };

  return {
    open,
    decide,
    pendingIds: () => [...waiters.keys()],
  };
}
