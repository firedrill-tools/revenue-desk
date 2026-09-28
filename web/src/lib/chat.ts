// Chat client helpers for AI SDK v7 streams with server-held approvals.
//
// Rules this module encodes (docs/ARCHITECTURE.md §6):
// - The server owns history, so a request carries only the conversation id and
//   the new user message.
// - An approval decision is POSTed to the approvals endpoint while the chat
//   response stays open. The UI waits for the server's tool-approval-response
//   chunk; it never calls addToolApprovalResponse and never uses
//   sendAutomaticallyWhen, either of which could replay the turn.
//
// This file must stay free of DOM-only globals and "@/" imports: the Node test
// suite imports it to drive the real transport against the server in process.

import { DefaultChatTransport, type DynamicToolUIPart, type UIMessage } from "ai";
import { useCallback, useState } from "react";

export const SPIKE_CHAT_API = "/api/spike/chat";
export const SPIKE_APPROVALS_API = "/api/spike/approvals";

export type ChatMessageMetadata = { runId: string; model: string };
export type ChatUIMessage = UIMessage<ChatMessageMetadata>;

export type ChatTransportOptions = {
  api: string;
  /** For tests: route requests somewhere other than the network. */
  fetch?: typeof globalThis.fetch;
};

export function createChatTransport<MESSAGE extends UIMessage = ChatUIMessage>(
  options: ChatTransportOptions,
): DefaultChatTransport<MESSAGE> {
  return new DefaultChatTransport<MESSAGE>({
    api: options.api,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    prepareSendMessagesRequest: ({ id, messages }) => ({
      body: { conversationId: id, message: messages.at(-1) },
    }),
  });
}

// ---------------------------------------------------------------------------
// Approval decisions.
// ---------------------------------------------------------------------------

export class ApprovalDecisionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApprovalDecisionError";
    this.status = status;
    this.code = code;
  }
}

function decisionErrorMessage(status: number): string {
  if (status === 404) return "This approval is no longer pending.";
  if (status === 409) return "This approval was already decided.";
  return "The decision could not be sent. Try again.";
}

export async function submitApprovalDecision(
  endpoint: string,
  decision: { approvalId: string; approved: boolean; reason?: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImpl(`${endpoint}/${encodeURIComponent(decision.approvalId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      approved: decision.approved,
      ...(decision.reason ? { reason: decision.reason } : {}),
    }),
  });
  if (response.ok) return;

  let code = "request_failed";
  try {
    const body: unknown = await response.json();
    const errorCode = (body as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof errorCode === "string") code = errorCode;
  } catch {
    // Non-JSON error body; keep the generic code.
  }
  throw new ApprovalDecisionError(decisionErrorMessage(response.status), response.status, code);
}

export type ApprovalSubmission = {
  approved: boolean;
  /** "sending" lasts until the server's tool-approval-response moves the part on. */
  status: "sending" | "failed";
  error?: string;
};

export type ApprovalDecisions = {
  submissions: Readonly<Record<string, ApprovalSubmission>>;
  decide: (approvalId: string, approved: boolean, reason?: string) => Promise<void>;
};

export function useApprovalDecisions(endpoint: string): ApprovalDecisions {
  const [submissions, setSubmissions] = useState<Readonly<Record<string, ApprovalSubmission>>>({});

  const decide = useCallback(
    async (approvalId: string, approved: boolean, reason?: string) => {
      setSubmissions((current) => ({ ...current, [approvalId]: { approved, status: "sending" } }));
      try {
        await submitApprovalDecision(endpoint, {
          approvalId,
          approved,
          ...(reason ? { reason } : {}),
        });
      } catch (error) {
        const message =
          error instanceof ApprovalDecisionError
            ? error.message
            : "The decision could not be sent. Try again.";
        setSubmissions((current) => ({
          ...current,
          [approvalId]: { approved, status: "failed", error: message },
        }));
      }
    },
    [endpoint],
  );

  return { submissions, decide };
}

// ---------------------------------------------------------------------------
// Reading the stream contract off tool parts. Values arrive as unknown JSON,
// so everything is checked before it is shown.
// ---------------------------------------------------------------------------

export type ToolMetadataView = {
  integration?: string;
  connectionKind?: string;
  operation?: string;
  actionClass?: string;
};

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readToolMetadata(part: DynamicToolUIPart): ToolMetadataView {
  const metadata: unknown = part.toolMetadata;
  if (!isRecord(metadata)) return {};
  const view: ToolMetadataView = {};
  const integration = readString(metadata, "integration");
  const connectionKind = readString(metadata, "connectionKind");
  const operation = readString(metadata, "operation");
  const actionClass = readString(metadata, "actionClass");
  if (integration) view.integration = integration;
  if (connectionKind) view.connectionKind = connectionKind;
  if (operation) view.operation = operation;
  if (actionClass) view.actionClass = actionClass;
  return view;
}

export type ApprovalFacts = {
  consequence: string;
  actionClass?: string;
  facts: Array<{ label: string; value: string }>;
};

/** Reads approval.descriptor, falling back to the request reason for the headline. */
export function readApprovalFacts(
  approval: DynamicToolUIPart["approval"],
): ApprovalFacts | undefined {
  if (!approval) return undefined;
  const descriptor: unknown = approval.descriptor;
  const record = isRecord(descriptor) ? descriptor : {};
  const consequence =
    readString(record, "consequence") ??
    approval.requestReason ??
    "This action needs your approval.";
  const facts = Array.isArray(record.facts)
    ? record.facts.flatMap((fact: unknown) => {
        if (!isRecord(fact)) return [];
        const label = readString(fact, "label");
        const value = readString(fact, "value");
        return label && value ? [{ label, value }] : [];
      })
    : [];
  const actionClass = readString(record, "actionClass");
  return { consequence, facts, ...(actionClass ? { actionClass } : {}) };
}

/** Financial and destructive approvals use the danger colour on the primary action. */
export function isHighRiskAction(actionClass: string | undefined): boolean {
  return actionClass === "financial" || actionClass === "destructive";
}
