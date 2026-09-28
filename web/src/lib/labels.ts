// Display vocabulary for contract enums: every label and tone the UI shows for
// an action class, connection kind, connection state, run status or approval.
//
// Alias-free and DOM-free so the Node test suite can import it.

import type {
  ApprovalStatus,
  ConversationStatus,
  ToolCallStatus,
} from "../../../src/contracts/api.js";
import type { RunStatus, ToolDecision } from "../../../src/contracts/events.js";
import type {
  ActionClass,
  ApprovalMode,
  ConnectionKind,
  ConnectionState,
} from "../../../src/contracts/integration.js";

/** The semantic colour of a status dot or label (docs/ARCHITECTURE.md §9). */
export type Tone = "neutral" | "running" | "success" | "warning" | "danger";

export type StatusLabel = { readonly label: string; readonly tone: Tone };

export const KIND_LABELS = {
  composio: "Composio",
  mcp: "MCP",
  api: "API",
} as const satisfies Record<ConnectionKind, string>;

/** Ledger order in the inspector and the Runs table. */
export const KIND_ORDER: readonly ConnectionKind[] = ["composio", "mcp", "api"];

export const ACTION_CLASS_LABELS = {
  read: "Read",
  internal_write: "Internal write",
  outbound: "Outbound",
  financial: "Financial",
  destructive: "Destructive",
} as const satisfies Record<ActionClass, string>;

export const ACTION_CLASS_DESCRIPTIONS = {
  read: "Look up emails, records, charges and invoices.",
  internal_write:
    "Drafts, labels, HubSpot notes and tasks, and Slack posts to allowlisted channels.",
  outbound: "Send email, invite external attendees, post to other Slack channels.",
  financial: "Refunds, invoices, recorded payments and subscription cancellations.",
  destructive: "Anything that deletes or voids data.",
} as const satisfies Record<ActionClass, string>;

export const APPROVAL_MODE_LABELS = {
  auto: "Auto",
  ask: "Ask",
  deny: "Deny",
} as const satisfies Record<ApprovalMode, string>;

/** Financial and destructive approvals use the danger colour on the primary action. */
export function isHighRiskClass(actionClass: ActionClass | null | undefined): boolean {
  return actionClass === "financial" || actionClass === "destructive";
}

export const CONNECTION_STATE_LABELS = {
  connected: { label: "Connected", tone: "success" },
  needs_auth: { label: "Needs sign-in", tone: "warning" },
  expired: { label: "Expired", tone: "warning" },
  not_configured: { label: "Not configured", tone: "neutral" },
  invalid: { label: "Invalid configuration", tone: "danger" },
  error: { label: "Error", tone: "danger" },
  unknown: { label: "Not checked", tone: "neutral" },
} as const satisfies Record<ConnectionState, StatusLabel>;

export const RUN_STATUS_LABELS = {
  running: { label: "Running", tone: "running" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
  timed_out: { label: "Timed out", tone: "warning" },
} as const satisfies Record<RunStatus, StatusLabel>;

export const APPROVAL_STATUS_LABELS = {
  pending: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  denied: { label: "Denied", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const satisfies Record<ApprovalStatus, StatusLabel>;

export const CONVERSATION_STATUS_LABELS = {
  idle: { label: "Idle", tone: "neutral" },
  running: { label: "Running", tone: "running" },
  awaiting_approval: { label: "Needs approval", tone: "warning" },
  error: { label: "Failed", tone: "danger" },
} as const satisfies Record<ConversationStatus, StatusLabel>;

/**
 * Every state a tool row can show. It merges the live part state, the
 * action-log status and the decision, so the chat and the Runs screen agree.
 */
export type ToolRowStatus =
  | "preparing"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "denied"
  | "blocked"
  | "rejected"
  | "timed_out"
  | "stopped"
  /** A write that ended without the system's answer: it may have been applied. */
  | "outcome_unknown";

export const TOOL_ROW_STATUS_LABELS = {
  preparing: { label: "Preparing", tone: "neutral" },
  running: { label: "Running", tone: "running" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning" },
  succeeded: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  denied: { label: "Denied", tone: "danger" },
  blocked: { label: "Blocked by policy", tone: "neutral" },
  rejected: { label: "Rejected", tone: "danger" },
  timed_out: { label: "Timed out", tone: "neutral" },
  stopped: { label: "Stopped", tone: "neutral" },
  outcome_unknown: { label: "Outcome unknown", tone: "warning" },
} as const satisfies Record<ToolRowStatus, StatusLabel>;

/** The row status of an action-log entry (GET /api/runs/:id). */
export function toolRowStatusFromLog(
  status: ToolCallStatus,
  decision: ToolDecision,
): ToolRowStatus {
  switch (decision) {
    case "policy_denied":
      return "blocked";
    case "rejected":
      return "rejected";
    case "timed_out":
      return "timed_out";
    case "stopped":
      return "stopped";
    case "denied":
      return "denied";
    default:
      break;
  }
  switch (status) {
    case "awaiting_approval":
      return "awaiting_approval";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "denied":
      return "denied";
    case "interrupted":
      return "stopped";
  }
}

/** A finished row: no spinner, no live elapsed time. */
export function isSettledStatus(status: ToolRowStatus): boolean {
  return status !== "preparing" && status !== "running" && status !== "awaiting_approval";
}
