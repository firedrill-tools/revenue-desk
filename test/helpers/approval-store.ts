/** An in-memory ApprovalStore with the approvals table's rules (pending exactly when undecided). */
import type {
  ApprovalSettlement,
  ApprovalStore,
  PendingApprovalRecord,
} from "../../src/policy/approvals.js";

export type StoredApproval = PendingApprovalRecord & {
  status: "pending" | ApprovalSettlement["status"];
  settlement: ApprovalSettlement | null;
};

export class MemoryApprovalStore implements ApprovalStore {
  readonly rows = new Map<string, StoredApproval>();
  failInsert = false;

  insertPending(record: PendingApprovalRecord): void {
    if (this.failInsert) throw new Error("database is locked");
    if (this.rows.has(record.approvalId)) throw new Error("UNIQUE constraint failed");
    this.rows.set(record.approvalId, { ...record, status: "pending", settlement: null });
  }

  settle(approvalId: string, settlement: ApprovalSettlement): boolean {
    const row = this.rows.get(approvalId);
    if (row === undefined || row.status !== "pending") return false;
    row.status = settlement.status;
    row.settlement = settlement;
    return true;
  }

  exists(approvalId: string): boolean {
    return this.rows.has(approvalId);
  }
}
