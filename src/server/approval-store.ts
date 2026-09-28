// The approvals table behind the approval gate (docs/ARCHITECTURE.md §7).
//
// The gate itself (waiters, timeout, stop) is src/policy/approvals.ts; it
// reaches SQLite only through this ApprovalStore, and records every
// settlement here before the core learns of it.

import type { ApprovalDescriptor } from "../contracts/events.js";
import { getApproval, insertPendingApproval, settleApproval } from "../db/repos/approvals.js";
import type { DbExecutor } from "../db/repos/types.js";
import type { ApprovalStore } from "../policy/approvals.js";
import { type Redact, redactJson } from "./redaction.js";

export function createApprovalStore(db: DbExecutor, redact: Redact): ApprovalStore {
  return {
    insertPending(record) {
      insertPendingApproval(db, {
        id: record.approvalId,
        runId: record.runId,
        conversationId: record.conversationId,
        toolUseId: record.toolCallId,
        // The descriptor is stored and shown; its facts come from tool input.
        descriptor: redactJson(record.descriptor, redact) as ApprovalDescriptor,
        requestedAt: record.requestedAt,
        expiresAt: record.expiresAt,
      });
    },
    settle(approvalId, settlement) {
      return settleApproval(db, approvalId, settlement);
    },
    exists(approvalId) {
      return getApproval(db, approvalId) !== undefined;
    },
  };
}
