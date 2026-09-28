// Helpers over the chat's messages: preparing server history for useChat,
// finding the active run, and describing what the agent is doing right now
// for the status line (docs/ARCHITECTURE.md §9, Loaders).
//
// Alias-free and DOM-free so the Node test suite can import it.

import type { ChatStatus, DynamicToolUIPart } from "ai";
import type {
  ApprovalView,
  ChatUIMessage,
  ConversationDetail,
} from "../../../src/contracts/api.js";
import type { RunStatus, RunUsage, StatusData } from "../../../src/contracts/events.js";

/**
 * The messages useChat starts from. When a run is active, the server's resume
 * stream replays the assistant message from its start, and the AI SDK
 * continues the last assistant message it already holds, so a partial copy
 * of that message must be dropped or its parts would appear twice.
 */
export function prepareInitialMessages(detail: ConversationDetail): ChatUIMessage[] {
  const messages = [...detail.messages];
  const activeRunId = detail.conversation.activeRunId;
  const last = messages.at(-1);
  if (activeRunId !== null && last?.role === "assistant" && last.metadata?.runId === activeRunId) {
    messages.pop();
  }
  return messages;
}

export function messageText(message: ChatUIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

/** A short conversation title from the first prompt. */
export function titleFromPrompt(prompt: string, maxLength = 60): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") ?? "";
  if (firstLine.length <= maxLength) return firstLine;
  const cut = firstLine.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function lastAssistantMessage(
  messages: readonly ChatUIMessage[],
): ChatUIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

/**
 * The assistant message of the request in flight, once its start chunk has
 * arrived. The AI SDK can still report "submitted" at that point (a start
 * chunk and transient data do not flip it to "streaming"), so both count.
 */
export function inFlightAssistantMessage(
  messages: readonly ChatUIMessage[],
  status: ChatStatus,
): ChatUIMessage | null {
  if (status !== "submitted" && status !== "streaming") return null;
  const last = messages.at(-1);
  return last?.role === "assistant" ? last : null;
}

/** The run id of the assistant message in flight, if the start chunk has arrived. */
export function streamingRunId(
  messages: readonly ChatUIMessage[],
  status: ChatStatus,
): string | null {
  return inFlightAssistantMessage(messages, status)?.metadata?.runId ?? null;
}

/** Whether the run behind an assistant message is over (its final status arrived). */
export function isRunSettled(message: ChatUIMessage, isStreamingMessage: boolean): boolean {
  const status: RunStatus | undefined = message.metadata?.status;
  if (status !== undefined) return status !== "running";
  return !isStreamingMessage;
}

/** The per-run usage: message metadata, else the persisted data-usage part. */
export function messageUsage(message: ChatUIMessage): RunUsage | null {
  if (message.metadata?.usage) return message.metadata.usage;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type === "data-usage") return part.data;
  }
  return null;
}

export type ConversationUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly runs: number;
  readonly last: RunUsage | null;
};

export function conversationUsage(messages: readonly ChatUIMessage[]): ConversationUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  let runs = 0;
  let last: RunUsage | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = messageUsage(message);
    if (!usage) continue;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheCreationTokens += usage.cacheCreationTokens;
    costUsd += usage.costUsd;
    runs += 1;
    last = usage;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, runs, last };
}

/** Every tool part of a conversation, oldest first. */
export function toolParts(messages: readonly ChatUIMessage[]): DynamicToolUIPart[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool")
      : [],
  );
}

/** Approval ids that the rendered parts already show as a card. */
export function approvalIdsInParts(messages: readonly ChatUIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const part of toolParts(messages)) {
    if (part.approval) ids.add(part.approval.id);
  }
  return ids;
}

/**
 * Pending approvals the thread cannot show (for example, the page reloaded
 * and the replay has not delivered the request yet); rendered as standalone
 * cards so a reloaded page can still decide them.
 */
export function orphanApprovals(
  pending: readonly ApprovalView[],
  messages: readonly ChatUIMessage[],
): ApprovalView[] {
  const shown = approvalIdsInParts(messages);
  return pending.filter((approval) => approval.status === "pending" && !shown.has(approval.id));
}

// ---------------------------------------------------------------------------
// The status line
// ---------------------------------------------------------------------------

export type Activity =
  | { readonly kind: "thinking" }
  | { readonly kind: "tool"; readonly title: string }
  | { readonly kind: "retrying"; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: "compacting" };

/**
 * What the agent is doing, for the Shimmer line shown after a pause with no
 * new tokens. null when nothing is in flight or a person must act (the
 * approval card is the call to action then).
 */
export function describeActivity(
  status: ChatStatus,
  messages: readonly ChatUIMessage[],
  modelStatus: StatusData | null,
): Activity | null {
  if (status !== "submitted" && status !== "streaming") return null;
  if (modelStatus?.phase === "retrying") {
    return { kind: "retrying", attempt: modelStatus.attempt, maxAttempts: modelStatus.maxAttempts };
  }
  if (modelStatus?.phase === "compacting") return { kind: "compacting" };

  const last = messages.at(-1);
  if (status === "submitted" || last?.role !== "assistant") return { kind: "thinking" };

  const running: DynamicToolUIPart[] = [];
  for (const part of last.parts) {
    if (part.type !== "dynamic-tool") continue;
    if (part.state === "approval-requested") return null;
    if (
      part.state === "input-streaming" ||
      part.state === "input-available" ||
      (part.state === "approval-responded" && part.approval.approved)
    ) {
      running.push(part);
    }
  }
  const current = running.at(-1);
  if (current) {
    const title = current.title ?? "Working";
    return running.length > 1
      ? { kind: "tool", title: `${title} and ${running.length - 1} more` }
      : { kind: "tool", title };
  }
  return { kind: "thinking" };
}

export function activityLabel(activity: Activity): string {
  switch (activity.kind) {
    case "thinking":
      return "Thinking";
    case "tool":
      return activity.title;
    case "retrying":
      return `Model busy, retrying ${activity.attempt}/${activity.maxAttempts}`;
    case "compacting":
      return "Compacting the conversation";
  }
}
