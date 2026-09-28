// Chat client for AI SDK v7 streams with server-held approvals
// (docs/ARCHITECTURE.md §6, §7).
//
// Rules this module encodes:
// - The server owns history, so a chat request carries only the conversation
//   id and the new user message.
// - Every mutating request carries the per-boot CSRF token (lib/api.ts).
// - An approval decision is POSTed while the chat response stays open. The UI
//   waits for the server's tool-approval-response chunk; it never calls
//   addToolApprovalResponse and never uses sendAutomaticallyWhen, either of
//   which could replay the turn.
// - Stop is POST /api/runs/:id/stop; the stream ends with the server's abort
//   chunk. useChat().stop() is never used, because it would only detach this
//   tab while the run keeps going.
//
// Alias-free and DOM-free so the Node test suite can import it.

import { DefaultChatTransport, type UIMessage } from "ai";
import {
  API_PATHS,
  type ApprovalDecisionRequest,
  type ChatUIMessage,
} from "../../../src/contracts/api.js";
import { type ApiClient, ApiError, api as defaultApi } from "./api.js";

export type ChatTransportOptions = {
  /** Defaults to POST /api/chat; resume uses `${api}/:conversationId/stream`. */
  readonly api?: string;
  /** Defaults to the app client's CSRF-aware fetch. */
  readonly fetch?: typeof globalThis.fetch;
};

/** The body of POST /api/chat for the latest user message. */
export function chatRequestBody<MESSAGE extends UIMessage>(
  conversationId: string,
  messages: readonly MESSAGE[],
): { conversationId: string; message: MESSAGE | undefined } {
  return { conversationId, message: messages.at(-1) };
}

export function createChatTransport<MESSAGE extends UIMessage = ChatUIMessage>(
  options: ChatTransportOptions = {},
): DefaultChatTransport<MESSAGE> {
  return new DefaultChatTransport<MESSAGE>({
    api: options.api ?? API_PATHS.chat,
    fetch: options.fetch ?? defaultApi.fetchWithCsrf,
    prepareSendMessagesRequest: ({ id, messages }) => ({
      body: chatRequestBody(id, messages),
    }),
  });
}

// ---------------------------------------------------------------------------
// Approval decisions and stop
// ---------------------------------------------------------------------------

function decisionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "not_found") return "This approval is no longer pending.";
    if (error.code === "already_decided") return "This approval was already decided.";
    if (error.code === "network_error") return error.message;
  }
  return "The decision could not be sent. Try again.";
}

export class ApprovalDecisionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ApprovalDecisionError";
    this.code = code;
  }
}

/** POST /api/approvals/:id. Resolves when the server accepted the decision. */
export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecisionRequest,
  client: ApiClient = defaultApi,
): Promise<void> {
  const reason = decision.reason?.trim();
  try {
    await client.request("POST /api/approvals/:approvalId", {
      params: { approvalId },
      body: { approved: decision.approved, ...(reason ? { reason: reason.slice(0, 500) } : {}) },
    });
  } catch (error) {
    throw new ApprovalDecisionError(
      decisionErrorMessage(error),
      error instanceof ApiError ? error.code : "request_failed",
    );
  }
}

export type StopOutcome = "stopping" | "not_running";

/** POST /api/runs/:id/stop. A run that already ended is not an error. */
export async function stopRun(runId: string, client: ApiClient = defaultApi): Promise<StopOutcome> {
  try {
    await client.request("POST /api/runs/:runId/stop", { params: { runId } });
    return "stopping";
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === "run_not_active" || error.code === "not_found")
    ) {
      return "not_running";
    }
    throw error;
  }
}

/** A friendly line for a failed POST /api/chat (409 run_active, 429 too_many_runs, ...). */
export function chatErrorMessage(error: ApiError | null): string {
  if (error === null) return "The response stream was interrupted.";
  switch (error.code) {
    case "run_active":
      return "This conversation already has a run in progress.";
    case "too_many_runs":
      return "Four runs are already in progress. Try again when one finishes.";
    case "not_found":
      return "This conversation no longer exists.";
    case "csrf_failed":
    case "forbidden_origin":
      return "The session expired. Reload the page and try again.";
    default:
      return error.message;
  }
}
