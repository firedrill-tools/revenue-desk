// Approvals (docs/ARCHITECTURE.md §7, §8). The approval gate inserts the
// pending row before the core emits approval.requested; every decision
// (user, timeout, stop, restart) settles it exactly once.

import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { ApprovalStatus, ApprovalView } from "../../contracts/api.js";
import type { ApprovalDescriptor } from "../../contracts/events.js";
import { type ApprovalRow, approvals } from "../schema.js";
import type { DbExecutor, IsoTime } from "./types.js";

export type NewApproval = {
  readonly id: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly toolUseId: string;
  readonly descriptor: ApprovalDescriptor;
  readonly requestedAt: IsoTime;
  readonly expiresAt: IsoTime;
};

export function insertPendingApproval(db: DbExecutor, approval: NewApproval): void {
  const { descriptor } = approval;
  db.insert(approvals)
    .values({
      id: approval.id,
      runId: approval.runId,
      conversationId: approval.conversationId,
      toolUseId: approval.toolUseId,
      integration: descriptor.integration,
      actionClass: descriptor.actionClass,
      operation: descriptor.operation,
      consequence: descriptor.consequence,
      descriptorJson: descriptor,
      status: "pending",
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
    })
    .run();
}

export type ApprovalSettlement = {
  readonly status: Exclude<ApprovalStatus, "pending">;
  readonly decidedBy: NonNullable<ApprovalRow["decidedBy"]>;
  readonly reason: string | null;
  readonly decidedAt: IsoTime;
};

/** Settles a pending approval. False when it was not pending (already settled or unknown). */
export function settleApproval(
  db: DbExecutor,
  id: string,
  settlement: ApprovalSettlement,
): boolean {
  const result = db
    .update(approvals)
    .set({
      status: settlement.status,
      decidedBy: settlement.decidedBy,
      reason: settlement.reason,
      decidedAt: settlement.decidedAt,
    })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .run();
  return result.changes === 1;
}

export function getApproval(db: DbExecutor, id: string): ApprovalRow | undefined {
  return db.select().from(approvals).where(eq(approvals.id, id)).get();
}

export function toApprovalView(row: ApprovalRow): ApprovalView {
  return {
    id: row.id,
    runId: row.runId,
    conversationId: row.conversationId,
    toolCallId: row.toolUseId,
    integration: row.integration,
    actionClass: row.actionClass,
    operation: row.operation,
    consequence: row.consequence,
    descriptor: row.descriptorJson,
    status: row.status,
    decidedBy: row.decidedBy,
    reason: row.reason,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
  };
}

export function listApprovalsForRun(db: DbExecutor, runId: string): ApprovalView[] {
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.runId, runId))
    .orderBy(asc(approvals.requestedAt), asc(sql`rowid`))
    .all()
    .map(toApprovalView);
}

export function pendingApprovalsForConversation(
  db: DbExecutor,
  conversationId: string,
): ApprovalView[] {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.conversationId, conversationId), eq(approvals.status, "pending")))
    .orderBy(asc(approvals.requestedAt), asc(sql`rowid`))
    .all()
    .map(toApprovalView);
}

export function countPendingApprovalsForRun(db: DbExecutor, runId: string): number {
  const row = db
    .select({ pending: count() })
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")))
    .get();
  return row?.pending ?? 0;
}

export type ApprovalCounts = {
  readonly pending: number;
  readonly approved: number;
  /** Everything decided without approval: denied, expired and cancelled. */
  readonly denied: number;
};

export function approvalCountsByRun(
  db: DbExecutor,
  runIds: readonly string[],
): ReadonlyMap<string, ApprovalCounts> {
  const counts = new Map<string, { pending: number; approved: number; denied: number }>();
  for (const runId of runIds) counts.set(runId, { pending: 0, approved: 0, denied: 0 });
  if (runIds.length === 0) return counts;
  for (const group of db
    .select({ runId: approvals.runId, status: approvals.status, approvals: count() })
    .from(approvals)
    .where(inArray(approvals.runId, [...runIds]))
    .groupBy(approvals.runId, approvals.status)
    .all()) {
    const entry = counts.get(group.runId);
    if (entry === undefined) continue;
    if (group.status === "pending") entry.pending += group.approvals;
    else if (group.status === "approved") entry.approved += group.approvals;
    else entry.denied += group.approvals;
  }
  return counts;
}

/** Boot recovery: nothing in this process waits for them any more. */
export function expireAllPendingApprovals(db: DbExecutor, now: IsoTime, reason: string): number {
  return db
    .update(approvals)
    .set({ status: "expired", decidedBy: "restart", reason, decidedAt: now })
    .where(eq(approvals.status, "pending"))
    .run().changes;
}
