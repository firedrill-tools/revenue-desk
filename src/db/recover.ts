// Recovery of runs whose owner is gone (docs/ARCHITECTURE.md §7, §8).
//
// Every run row names the process that runs it (src/db/owner.ts): the server
// or one CLI invocation, which may be working on the same database right now.
// A run still `running` whose owner exited (a crash, a restart, a CLI killed
// with SIGKILL) would stay running for ever and block its conversation, so it
// is recovered:
//
// - the run becomes `failed` with `server_restart` ("the process died with
//   the run in flight");
// - its in-flight tool calls become `interrupted`;
// - its pending approvals become `expired`, decided by `restart` (the waiter
//   lived in the dead process);
// - its conversation shows `error`;
// - its persisted assistant message is closed, so a reloaded page never
//   offers an approval card or a spinner that nothing will ever answer.
//
// Runs whose owner is alive, another server's or a CLI's, are left alone.
// Recovery runs at server boot, when the CLI opens the database, before a new
// run is refused because its conversation seems busy, and when the app lists
// conversations.

import { and, eq } from "drizzle-orm";
import type { ChatMessageMetadata, ChatUIMessage } from "../contracts/api.js";
import type { RunSource } from "../contracts/events.js";
import { type OwnerState, ownerState, type ProcessProbe, type RunOwner } from "./owner.js";
import { expireDanglingApprovals, expirePendingApprovalsOfRun } from "./repos/approvals.js";
import { setConversationStatus } from "./repos/conversations.js";
import { getMessageRow, replaceAssistantMessage } from "./repos/messages.js";
import { finishRun, runningRuns } from "./repos/runs.js";
import { interruptToolCalls } from "./repos/tool-calls.js";
import type { DbExecutor, IsoTime } from "./repos/types.js";
import { conversations, type RunRow, runs } from "./schema.js";

/** Why a recovered run failed, by the kind of process that owned it. */
export const ORPHANED_RUN_MESSAGES: { readonly [S in RunSource]: string } = {
  ui: "The server stopped while this run was in progress.",
  cli: "The command-line process running this run exited before it finished.",
};
export const RESTART_APPROVAL_REASON = "The server stopped before a decision was made.";
export const INTERRUPTED_TOOL_TEXT = "Interrupted: the run ended before this call finished.";

export type RecoveryResult = {
  readonly runs: number;
  readonly toolCalls: number;
  readonly approvals: number;
};

export type RecoveryOptions = {
  readonly now: IsoTime;
  /** Only this conversation's runs. Default: every running run. */
  readonly conversationId?: string;
  /**
   * Whether this process is still running a run it owns (the server's run
   * registry). A run it owns but no longer runs is recovered. Default: none.
   */
  readonly runsLocally?: (runId: string) => boolean;
  /** Test seams (src/db/owner.ts). */
  readonly self?: RunOwner;
  readonly probe?: ProcessProbe;
};

/** Whether a running row still has a process working on it. */
export function runOwnerState(
  run: Pick<RunRow, "ownerPid" | "ownerStartedAt">,
  options: Pick<RecoveryOptions, "self" | "probe"> = {},
): OwnerState {
  return ownerState(
    { pid: run.ownerPid, startedAt: run.ownerStartedAt },
    {
      ...(options.self === undefined ? {} : { self: options.self }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
    },
  );
}

/** True when nothing will ever finish this running run. */
export function isOrphaned(run: RunRow, options: Omit<RecoveryOptions, "now"> = {}): boolean {
  switch (runOwnerState(run, options)) {
    case "alive":
      return false;
    case "self":
      return !(options.runsLocally?.(run.id) ?? false);
    case "gone":
      return true;
  }
}

/**
 * Fails every running run (of one conversation, or all) whose owner is gone,
 * in one transaction. Never touches a run a live process owns.
 */
export function recoverOrphanedRuns(db: DbExecutor, options: RecoveryOptions): RecoveryResult {
  const { now } = options;
  return db.transaction(
    (tx) => {
      let recovered = 0;
      let toolCalls = 0;
      let approvals = 0;
      for (const run of runningRuns(tx, options.conversationId)) {
        if (!isOrphaned(run, options)) continue;
        const outcome = recoverRun(tx, run, now);
        if (outcome === null) continue;
        recovered += 1;
        toolCalls += outcome.toolCalls;
        approvals += outcome.approvals;
      }
      return { runs: recovered, toolCalls, approvals };
    },
    { behavior: "immediate" },
  );
}

/**
 * Server boot: recovers every orphaned run (nothing of this process runs
 * yet), then expires the pending approvals of runs that are not running.
 */
export function recoverAfterRestart(
  db: DbExecutor,
  options: Omit<RecoveryOptions, "conversationId" | "runsLocally">,
): RecoveryResult {
  const result = recoverOrphanedRuns(db, options);
  const dangling = expireDanglingApprovals(db, options.now, RESTART_APPROVAL_REASON);
  return { ...result, approvals: result.approvals + dangling };
}

function recoverRun(
  tx: DbExecutor,
  run: RunRow,
  now: IsoTime,
): { readonly toolCalls: number; readonly approvals: number } | null {
  const failed = finishRun(tx, run.id, {
    status: "failed",
    finishedAt: now,
    stopReason: null,
    terminalReason: null,
    error: { code: "server_restart", message: ORPHANED_RUN_MESSAGES[run.source] },
  });
  if (!failed) return null;
  const toolCalls = interruptToolCalls(tx, run.id, now);
  const approvals = expirePendingApprovalsOfRun(tx, run.id, now, RESTART_APPROVAL_REASON);
  const conversation = tx
    .select({ status: conversations.status })
    .from(conversations)
    .where(eq(conversations.id, run.conversationId))
    .get();
  const otherRunning = tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, run.conversationId), eq(runs.status, "running")))
    .get();
  if (
    otherRunning === undefined &&
    (conversation?.status === "running" || conversation?.status === "awaiting_approval")
  ) {
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
  return { toolCalls, approvals };
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
