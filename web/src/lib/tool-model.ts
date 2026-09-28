// One view model for a tool call, built either from a live chat part
// (DynamicToolUIPart with the contract's toolMetadata and approval descriptor)
// or from an action-log row (ToolCallView), so the chat thread, the inspector
// and the Runs detail render the same row.
//
// Stream values arrive as unknown JSON, so everything read from a part is
// checked before it is shown.
//
// Alias-free and DOM-free so the Node test suite can import it.

import type { DynamicToolUIPart } from "ai";
import type { ApprovalView, ChatUIMessage, ToolCallView } from "../../../src/contracts/api.js";
import type { ApprovalDescriptor, ToolMetadata } from "../../../src/contracts/events.js";
import {
  ACTION_CLASSES,
  type ActionClass,
  type ApprovalFact,
  CONNECTION_KINDS,
  type ConnectionKind,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationId,
  type OperationName,
} from "../../../src/contracts/integration.js";
import {
  isSettledStatus,
  type StatusLabel,
  type Tone,
  type ToolRowStatus,
  toolRowStatusFromLog,
} from "./labels.js";

// ---------------------------------------------------------------------------
// Reading contract payloads off parts
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function readOperation(record: Record<string, unknown>): OperationName | undefined {
  const value = readString(record, "operation");
  if (value === undefined) return undefined;
  const integration = value.slice(0, value.indexOf("."));
  return oneOf(INTEGRATION_IDS, integration) ? (value as OperationName) : undefined;
}

/** toolMetadata from tool-input-start / tool-input-available; null when absent or malformed. */
export function readToolMetadata(value: unknown): ToolMetadata | null {
  if (!isRecord(value)) return null;
  const integration = oneOf(INTEGRATION_IDS, value.integration);
  const connectionKind = oneOf(CONNECTION_KINDS, value.connectionKind);
  const actionClass = oneOf(ACTION_CLASSES, value.actionClass);
  const operation = readOperation(value);
  if (!integration || !connectionKind || !actionClass || !operation) return null;
  return { integration, connectionKind, actionClass, operation };
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item !== "");
  return items.length > 0 ? items : undefined;
}

/** What an approval card shows; tolerant of a partial descriptor. */
export type ApprovalFacts = {
  readonly consequence: string;
  readonly title: string | null;
  readonly actionClass: ActionClass | null;
  readonly integration: IntegrationId | null;
  readonly facts: readonly ApprovalFact[];
  readonly recipients: readonly string[];
  readonly recordIds: readonly string[];
  readonly expiresAt: string | null;
};

export function readApprovalFacts(descriptor: unknown, fallbackReason?: string): ApprovalFacts {
  const record = isRecord(descriptor) ? descriptor : {};
  const facts = Array.isArray(record.facts)
    ? record.facts.flatMap((fact: unknown) => {
        if (!isRecord(fact)) return [];
        const label = readString(fact, "label");
        const value = readString(fact, "value");
        return label && value ? [{ label, value }] : [];
      })
    : [];
  return {
    consequence:
      readString(record, "consequence") ?? fallbackReason ?? "This action needs your approval.",
    title: readString(record, "title") ?? null,
    actionClass: oneOf(ACTION_CLASSES, record.actionClass) ?? null,
    integration: oneOf(INTEGRATION_IDS, record.integration) ?? null,
    facts,
    recipients: readStringList(record.recipients) ?? [],
    recordIds: readStringList(record.recordIds) ?? [],
    expiresAt: readString(record, "expiresAt") ?? null,
  };
}

/** From a persisted approval (reload fallback and Runs detail). */
export function approvalFactsFromView(view: ApprovalView): ApprovalFacts {
  const descriptor: ApprovalDescriptor = view.descriptor;
  return readApprovalFacts(descriptor, view.consequence);
}

/**
 * The facts table rows: the descriptor's own facts, then recipients and
 * record ids that no fact already shows, so nothing is listed twice.
 */
export function approvalFactRows(facts: ApprovalFacts): ApprovalFact[] {
  const rows: ApprovalFact[] = [...facts.facts];
  const shown = (value: string) => rows.some((row) => row.value.includes(value));
  const recipients = facts.recipients.filter((recipient) => !shown(recipient));
  if (recipients.length > 0) {
    rows.push({
      label: recipients.length === 1 ? "Recipient" : "Recipients",
      value: recipients.join(", "),
    });
  }
  const recordIds = facts.recordIds.filter((id) => !shown(id));
  if (recordIds.length > 0) {
    rows.push({
      label: recordIds.length === 1 ? "Record" : "Records",
      value: recordIds.join(", "),
    });
  }
  return rows;
}

/**
 * How a fact row reads on the card:
 * - warning: a problem the reviewer must see first (Stripe would refuse the
 *   refund, the invoice belongs to someone else, a write may already be
 *   applied);
 * - text: a message body, shown with its line breaks;
 * - muted: bookkeeping stored with the action (Stripe metadata);
 * - plain: everything else.
 */
export type FactKind = "warning" | "text" | "muted" | "plain";

const WARNING_FACTS = new Set(["Check", "Mismatch", "May already be applied"]);
const TEXT_FACTS = new Set(["Body", "Message"]);
const MUTED_FACTS = new Set(["Stored on the refund"]);

export function factKind(label: string): FactKind {
  if (WARNING_FACTS.has(label)) return "warning";
  if (TEXT_FACTS.has(label)) return "text";
  if (MUTED_FACTS.has(label)) return "muted";
  return "plain";
}

/** A text fact taller than this many lines (or this long) starts folded, with "Show all". */
export const FOLDED_TEXT_LINES = 8;
const FOLDED_TEXT_CHARS = 600;

export function isLongText(value: string): boolean {
  return value.split("\n").length > FOLDED_TEXT_LINES || value.length > FOLDED_TEXT_CHARS;
}

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

/**
 * requested: a person can still decide. The others are outcomes: denied by a
 * person, blocked by policy, or ended by Stop or the approval timeout.
 */
export type ApprovalState =
  | "requested"
  | "approved"
  | "denied"
  | "blocked"
  | "stopped"
  | "timed_out";

/** How each approval outcome reads in the UI. */
export const APPROVAL_STATE_LABELS = {
  requested: { label: "Waiting", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  denied: { label: "Denied", tone: "danger" },
  blocked: { label: "Blocked by policy", tone: "neutral" },
  stopped: { label: "Stopped", tone: "neutral" },
  timed_out: { label: "Timed out", tone: "neutral" },
} as const satisfies Record<ApprovalState, StatusLabel>;

/** The first line of a call's error, named after its system: "Stripe: Your card was declined." */
export function failureLine(
  row: Pick<ToolRowModel, "errorText" | "integrationLabel">,
): string | null {
  const first = row.errorText
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (first === undefined) return null;
  const text = first.length > 200 ? `${first.slice(0, 199).trimEnd()}…` : first;
  return row.integrationLabel === null || text.startsWith(row.integrationLabel)
    ? text
    : `${row.integrationLabel}: ${text}`;
}

/**
 * How a decided approval reads once its call has an outcome. An approved
 * action that then failed at the system must not read as a success: the
 * card says "Approved, then failed" in the danger tone, with the reason.
 */
export function approvalOutcome(
  approval: Pick<ToolApprovalModel, "state">,
  row: Pick<ToolRowModel, "status" | "errorText" | "integrationLabel"> | null,
): { readonly label: string; readonly tone: Tone; readonly detail: string | null } {
  if (approval.state !== "approved") {
    return { ...APPROVAL_STATE_LABELS[approval.state], detail: null };
  }
  switch (row?.status) {
    case "failed":
    case "rejected":
      return { label: "Approved, then failed", tone: "danger", detail: failureLine(row) };
    case "outcome_unknown":
      return { label: "Approved, outcome unknown", tone: "warning", detail: failureLine(row) };
    case "stopped":
      return { label: "Approved, then stopped", tone: "neutral", detail: null };
    default:
      return { label: "Approved", tone: "success", detail: null };
  }
}

export type ToolApprovalModel = {
  readonly id: string;
  /** requested: a person can still decide. */
  readonly state: ApprovalState;
  readonly facts: ApprovalFacts;
  readonly reason: string | null;
};

export type ToolRowModel = {
  readonly toolCallId: string;
  readonly title: string;
  readonly toolName: string;
  readonly integration: IntegrationId | null;
  readonly integrationLabel: string | null;
  readonly kind: ConnectionKind | null;
  readonly operation: OperationName | null;
  readonly actionClass: ActionClass | null;
  readonly status: ToolRowStatus;
  /** undefined while the input is still streaming. */
  readonly input: unknown;
  readonly output: unknown;
  readonly errorText: string | null;
  /** Known for finished action-log rows. */
  readonly durationMs: number | null;
  readonly approval: ToolApprovalModel | null;
};

function integrationLabel(integration: IntegrationId | null): string | null {
  return integration === null ? null : INTEGRATIONS[integration].label;
}

/** A readable fallback title for a tool with no profile title. */
export function humanizeToolName(toolName: string): string {
  const match = /^mcp__[a-z_]+?__(.+)$/.exec(toolName);
  const bare = (match?.[1] ?? toolName).replace(/[-_]+/g, " ").trim().toLowerCase();
  return bare.length === 0 ? toolName : bare.charAt(0).toUpperCase() + bare.slice(1);
}

function approvalFromPart(part: DynamicToolUIPart): ToolApprovalModel | null {
  const approval = part.approval;
  if (!approval) return null;
  const facts = readApprovalFacts(approval.descriptor, approval.requestReason);
  const reason =
    typeof approval.reason === "string" && approval.reason !== "" ? approval.reason : null;
  if (approval.approved === undefined) {
    return { id: approval.id, state: "requested", facts, reason: null };
  }
  if (approval.approved) return { id: approval.id, state: "approved", facts, reason };
  return {
    id: approval.id,
    state: approval.isAutomatic ? "blocked" : "denied",
    facts,
    reason,
  };
}

/**
 * `runSettled`: the run that produced this part has ended (the message has a
 * final status or the stream closed), so an unfinished call was stopped.
 */
export function toolRowFromPart(part: DynamicToolUIPart, runSettled: boolean): ToolRowModel {
  const metadata = readToolMetadata(part.toolMetadata);
  const approval = approvalFromPart(part);
  let status: ToolRowStatus;
  switch (part.state) {
    case "input-streaming":
      status = runSettled ? "stopped" : "preparing";
      break;
    case "input-available":
      status = runSettled ? "stopped" : "running";
      break;
    case "approval-requested":
      status = runSettled ? "stopped" : "awaiting_approval";
      break;
    case "approval-responded":
      if (!part.approval.approved) status = part.approval.isAutomatic ? "blocked" : "denied";
      else status = runSettled ? "stopped" : "running";
      break;
    case "output-available":
      status = "succeeded";
      break;
    case "output-error":
      status = "failed";
      break;
    case "output-denied":
      status = part.approval.isAutomatic ? "blocked" : "denied";
      break;
  }
  const integration = metadata?.integration ?? null;
  // A request the run ended before anyone decided can no longer be decided.
  const settledApproval =
    approval?.state === "requested" && status === "stopped"
      ? { ...approval, state: "stopped" as const }
      : approval;
  return {
    toolCallId: part.toolCallId,
    title: part.title ?? humanizeToolName(part.toolName),
    toolName: part.toolName,
    integration,
    integrationLabel: integrationLabel(integration),
    kind: metadata?.connectionKind ?? null,
    operation: metadata?.operation ?? null,
    actionClass: metadata?.actionClass ?? null,
    status,
    input: part.input,
    output: part.state === "output-available" ? part.output : undefined,
    errorText: part.state === "output-error" ? part.errorText : null,
    durationMs: null,
    approval: settledApproval,
  };
}

function approvalFromView(view: ApprovalView): ToolApprovalModel {
  const facts = approvalFactsFromView(view);
  switch (view.status) {
    case "pending":
      return { id: view.id, state: "requested", facts, reason: null };
    case "approved":
      return { id: view.id, state: "approved", facts, reason: view.reason };
    case "expired":
      return {
        id: view.id,
        state: view.decidedBy === "restart" ? "stopped" : "timed_out",
        facts,
        reason: view.reason,
      };
    case "cancelled":
      return { id: view.id, state: "stopped", facts, reason: view.reason };
    case "denied":
      return {
        id: view.id,
        state:
          view.decidedBy === "timeout"
            ? "timed_out"
            : view.decidedBy === "stop"
              ? "stopped"
              : "denied",
        facts,
        reason: view.reason,
      };
  }
}

/** A read-only row from the action log (Runs detail, inspector). */
export function toolRowFromView(
  view: ToolCallView,
  approvals: readonly ApprovalView[] = [],
): ToolRowModel {
  const approvalView = approvals.find(
    (approval) => approval.id === view.approvalId || approval.toolCallId === view.toolCallId,
  );
  const status =
    view.error?.code === "outcome_unknown"
      ? "outcome_unknown"
      : toolRowStatusFromLog(view.status, view.decision);
  const approval = approvalView ? withOutcome(approvalFromView(approvalView), status) : null;
  return {
    toolCallId: view.toolCallId,
    title: view.title || humanizeToolName(view.toolName),
    toolName: view.toolName,
    integration: view.integration,
    integrationLabel: integrationLabel(view.integration),
    kind: view.connectionKind,
    operation: view.operation,
    actionClass: view.actionClass,
    status,
    input: view.input,
    output: view.output ?? undefined,
    errorText: view.error?.message ?? (view.isError ? "The call failed." : null),
    durationMs: view.durationMs,
    approval,
  };
}

/** An unapproved approval takes the call's outcome when the log knows it (stopped, timed out, blocked). */
function withOutcome(approval: ToolApprovalModel, status: ToolRowStatus): ToolApprovalModel {
  if (approval.state === "requested" || approval.state === "approved") return approval;
  if (status === "stopped" || status === "timed_out" || status === "blocked") {
    return { ...approval, state: status };
  }
  return approval;
}

/**
 * Enriches a settled live row with its action-log entry: the log has the
 * duration and the exact decision (timed out, stopped, rejected), which the
 * stream does not carry. While the call is in flight the stream is the
 * source of truth, so a pending approval always stays actionable.
 */
export function mergeToolRow(row: ToolRowModel, log: ToolCallView | undefined): ToolRowModel {
  if (!log || !isSettledStatus(row.status)) return row;
  const logStatus =
    log.error?.code === "outcome_unknown"
      ? "outcome_unknown"
      : toolRowStatusFromLog(log.status, log.decision);
  const status = isSettledStatus(logStatus) ? logStatus : row.status;
  return {
    ...row,
    status,
    durationMs: log.durationMs ?? row.durationMs,
    approval: row.approval ? withOutcome(row.approval, status) : null,
  };
}

// ---------------------------------------------------------------------------
// Assistant message layout: consecutive reads collapse into one group
// ---------------------------------------------------------------------------

type AssistantPart = ChatUIMessage["parts"][number];

export type AssistantBlock =
  | { readonly kind: "part"; readonly key: string; readonly part: AssistantPart }
  | { readonly kind: "tool"; readonly key: string; readonly part: DynamicToolUIPart }
  | { readonly kind: "reads"; readonly key: string; readonly parts: readonly DynamicToolUIPart[] };

/** Three or more consecutive reads render as "Checked N sources". */
export const READ_GROUP_MIN = 3;

function isGroupableRead(part: DynamicToolUIPart): boolean {
  const metadata = readToolMetadata(part.toolMetadata);
  if (metadata?.actionClass !== "read") return false;
  // A read that waits for a person is shown on its own so the card is visible.
  return part.state !== "approval-requested" && part.state !== "approval-responded";
}

function isVisiblePart(part: AssistantPart): boolean {
  switch (part.type) {
    case "step-start":
      return false;
    case "text":
      return part.text.trim() !== "";
    case "reasoning":
      return part.text.trim() !== "";
    case "data-usage":
    case "data-status":
    case "data-progress":
      return false;
    default:
      return true;
  }
}

/**
 * Orders an assistant message for rendering: hides step markers, empty text
 * and data parts that are shown elsewhere, and groups runs of reads (step
 * boundaries between them do not break a run).
 */
export function layoutAssistantParts(
  messageId: string,
  parts: readonly AssistantPart[],
): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  let reads: DynamicToolUIPart[] = [];

  const flushReads = () => {
    if (reads.length >= READ_GROUP_MIN) {
      blocks.push({
        kind: "reads",
        key: `${messageId}:reads:${reads[0]?.toolCallId}`,
        parts: reads,
      });
    } else {
      for (const part of reads) {
        blocks.push({ kind: "tool", key: `${messageId}:tool:${part.toolCallId}`, part });
      }
    }
    reads = [];
  };

  parts.forEach((part, index) => {
    if (part.type === "dynamic-tool" && isGroupableRead(part)) {
      reads.push(part);
      return;
    }
    if (!isVisiblePart(part)) return;
    flushReads();
    if (part.type === "dynamic-tool") {
      blocks.push({ kind: "tool", key: `${messageId}:tool:${part.toolCallId}`, part });
    } else {
      blocks.push({ kind: "part", key: `${messageId}:${index}`, part });
    }
  });
  flushReads();
  return blocks;
}

/** The distinct integration labels of a group, in first-use order. */
export function sourceLabels(rows: readonly ToolRowModel[]): string[] {
  const labels: string[] = [];
  for (const row of rows) {
    const label = row.integrationLabel;
    if (label !== null && !labels.includes(label)) labels.push(label);
  }
  return labels;
}
