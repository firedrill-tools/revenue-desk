// Boot recovery (docs/ARCHITECTURE.md §7): the approvals a run waits on live
// in the server's memory, so a restart ends every run the server owned.
//
// - runs still `running` become `failed` with `server_restart`;
// - their in-flight tool calls become `interrupted`;
// - every pending approval becomes `expired`, decided by `restart` (only the
//   server asks for approvals; the headless CLI never does);
// - their conversations show `error`;
// - their persisted assistant messages are closed, so a reloaded page never
//   offers an approval card or a spinner that nothing will ever answer.
//
// Runs of the CLI (source `cli`) run in their own process, possibly right now,
// so they are left alone unless the caller asks for them.

import { and, eq, inArray } from "drizzle-orm";
import type { ChatMessageMetadata, ChatUIMessage } from "../contracts/api.js";
import type { RunSource } from "../contracts/events.js";
import { expireAllPendingApprovals } from "./repos/approvals.js";
import { setConversationStatus } from "./repos/conversations.js";
import { getMessageRow, replaceAssistantMessage } from "./repos/messages.js";
import { finishRun } from "./repos/runs.js";
import { interruptToolCalls } from "./repos/tool-calls.js";
import type { DbExecutor, IsoTime } from "./repos/types.js";
import { conversations, runs } from "./schema.js";

export const RESTART_RUN_MESSAGE = "The server restarted while this run was in progress.";
export const RESTART_APPROVAL_REASON = "The server restarted before a decision was made.";
export const INTERRUPTED_TOOL_TEXT = "Interrupted: the run ended before this call finished.";

export type RecoveryResult = {
  readonly runs: number;
  readonly toolCalls: number;
  readonly approvals: number;
};

export function recoverAfterRestart(
  db: DbExecutor,
  options: { readonly now: IsoTime; readonly sources?: readonly RunSource[] },
): RecoveryResult {
  const sources = options.sources ?? ["ui"];
  const { now } = options;
  return db.transaction((tx) => {
    const stale = tx
      .select()
      .from(runs)
      .where(and(eq(runs.status, "running"), inArray(runs.source, [...sources])))
      .all();
    let toolCalls = 0;
    for (const run of stale) {
      finishRun(tx, run.id, {
        status: "failed",
        finishedAt: now,
        stopReason: null,
        terminalReason: null,
        error: { code: "server_restart", message: RESTART_RUN_MESSAGE },
      });
      toolCalls += interruptToolCalls(tx, run.id, now);
      const conversation = tx
        .select({ status: conversations.status })
        .from(conversations)
        .where(eq(conversations.id, run.conversationId))
        .get();
      if (conversation?.status === "running" || conversation?.status === "awaiting_approval") {
        setConversationStatus(tx, run.conversationId, "error", now);
      }
      if (run.assistantMessageId !== null) {
        const row = getMessageRow(tx, run.assistantMessageId);
        if (row !== undefined && row.role === "assistant") {
          replaceAssistantMessage(
            tx,
            row.id,
            closeInterruptedMessage(
              { parts: row.partsJson, metadata: row.metadataJson ?? undefined },
              RESTART_APPROVAL_REASON,
            ),
            now,
          );
        }
      }
    }
    const approvals = expireAllPendingApprovals(tx, now, RESTART_APPROVAL_REASON);
    return { runs: stale.length, toolCalls, approvals };
  });
}

type Part = ChatUIMessage["parts"][number];

/**
 * Closes every part the run left open: streaming text and reasoning end;
 * a pending approval is denied with `approvalReason`; any other tool call
 * without an outcome fails as interrupted. The metadata says `failed`.
 */
export function closeInterruptedMessage(
  message: Pick<ChatUIMessage, "parts" | "metadata">,
  approvalReason: string,
): Pick<ChatUIMessage, "parts" | "metadata"> {
  const metadata: ChatMessageMetadata | undefined =
    message.metadata === undefined ? undefined : { ...message.metadata, status: "failed" };
  return {
    parts: message.parts.map((part) => closePart(part, approvalReason)),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function closePart(part: Part, approvalReason: string): Part {
  if (part.type === "text" || part.type === "reasoning") {
    return part.state === "streaming" ? { ...part, state: "done" } : part;
  }
  if (part.type !== "dynamic-tool") return part;
  const base = {
    type: part.type,
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    ...(part.title === undefined ? {} : { title: part.title }),
    ...(part.toolMetadata === undefined ? {} : { toolMetadata: part.toolMetadata }),
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
  };
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return {
        ...base,
        state: "output-error",
        input: part.input,
        errorText: INTERRUPTED_TOOL_TEXT,
      };
    case "approval-requested": {
      const { id, descriptor, requestReason, isAutomatic } = part.approval;
      return {
        ...base,
        state: "output-denied",
        input: part.input,
        approval: {
          id,
          approved: false,
          reason: approvalReason,
          ...(descriptor === undefined ? {} : { descriptor }),
          ...(requestReason === undefined ? {} : { requestReason }),
          ...(isAutomatic === undefined ? {} : { isAutomatic }),
        },
      };
    }
    case "approval-responded": {
      const { approval } = part;
      if (approval.approved) {
        return {
          ...base,
          state: "output-error",
          input: part.input,
          errorText: INTERRUPTED_TOOL_TEXT,
          approval: { ...approval, approved: true },
        };
      }
      return {
        ...base,
        state: "output-denied",
        input: part.input,
        approval: { ...approval, approved: false },
      };
    }
    default:
      return part;
  }
}
