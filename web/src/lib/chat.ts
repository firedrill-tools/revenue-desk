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
import type { RunError } from "../../../src/contracts/events.js";
import { type ApiClient, ApiError, api as defaultApi, parseTransportError } from "./api.js";

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

/**
 * Whether the chat's error is a transport problem worth a banner. A run that
 * failed (no model key, spending limit, model error) ends its stream with an
 * `error` chunk, which useChat reports as an error too: the stream itself
 * ended normally and the thread already shows why the run failed, so no
 * "stream interrupted" banner (whose Reconnect could do nothing) is shown.
 * A request the server refused (409, 429, ...) and a stream cut before the
 * run finished keep it.
 */
export function shouldShowTransportError(
  messages: readonly Pick<ChatUIMessage, "role" | "metadata">[],
  error: Error | undefined,
): boolean {
  if (error === undefined) return false;
  if (parseTransportError(error) !== null) return true;
  const last = messages.at(-1);
  return !(last?.role === "assistant" && last.metadata?.status === "failed");
}

/** What to do about a failed run, by its error code; null when there is nothing to add. */
export function runErrorNextStep(error: RunError | null | undefined): string | null {
  if (error === null || error === undefined) return null;
  switch (error.code) {
    case "config_missing":
      return error.message.includes("DOTENV_PATH")
        ? null
        : "Add ANTHROPIC_API_KEY to the file DOTENV_PATH names, then restart Revenue Desk.";
    case "budget_exceeded":
      return "Each run may spend up to AGENT_MAX_BUDGET_USD; raise it and restart, or ask a narrower question.";
    case "max_turns":
      return "Each run may take up to AGENT_MAX_TURNS turns; raise it and restart, or ask a narrower question.";
    case "model_error":
      return "Check the model in Settings › Model or AGENT_MODEL, then try again.";
    case "server_restart":
      return "Revenue Desk restarted during the run. Check the calls above, then ask again.";
    default:
      return null;
  }
}

/**
 * A friendly line for a failed POST /api/chat (409 run_active, 429
 * too_many_runs, ...). `waitingApprovals` is how many open conversations
 * wait for the user's approval: runs parked on an approval count toward the
 * limit, and deciding them is what frees a slot.
 */
export function chatErrorMessage(error: ApiError | null, waitingApprovals = 0): string {
  if (error === null) return "The response stream was interrupted.";
  switch (error.code) {
    case "run_active":
      return "This conversation already has a run in progress.";
    case "too_many_runs":
      return waitingApprovals > 0
        ? `Four runs are open and ${waitingApprovals === 1 ? "1 of them is" : `${Math.min(waitingApprovals, 4)} of them are`} waiting for your approval. Decide or stop one, then try again.`
        : "Four runs are already in progress. Stop one, or try again when one finishes.";
    case "not_found":
      return "This conversation no longer exists.";
    case "csrf_failed":
    case "forbidden_origin":
      return "The session expired. Reload the page and try again.";
    default:
      return error.message;
  }
}
