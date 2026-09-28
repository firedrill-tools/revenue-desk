// Persists one run's AgentEvents (docs/ARCHITECTURE.md §8): the run row, the
// action log (tool_calls), usage totals, the SDK session to resume and the
// conversation status. The assistant message itself is persisted by the
// server-side reducer (message-reducer.ts); approvals rows by the gate.
//
// Everything written here is redacted first. Writes are synchronous
// (better-sqlite3), so a row always exists before the chunk that shows it.

import type { ConversationStatus } from "../contracts/api.js";
import type { AgentEvent, AgentEventOf, ToolDecision } from "../contracts/events.js";
import { countPendingApprovalsForRun } from "../db/repos/approvals.js";
import {
  addConversationUsage,
  setConversationSession,
  setConversationStatus,
} from "../db/repos/conversations.js";
import { finishRun, recordRunStarted, recordRunUsage } from "../db/repos/runs.js";
import {
  insertToolCall,
  interruptToolCalls,
  markToolCallAwaitingApproval,
  markToolCallDecided,
  markToolCallDenied,
  markToolCallFinished,
  type ToolCallKey,
} from "../db/repos/tool-calls.js";
import type { DbExecutor } from "../db/repos/types.js";
import { type Redact, redactJson, redactJsonObject } from "./redaction.js";

export type RunRecorderOptions = {
  readonly db: DbExecutor;
  readonly runId: string;
  readonly conversationId: string;
  readonly redact: Redact;
  readonly now: () => Date;
  readonly newId: () => string;
};

export class RunRecorder {
  readonly #options: RunRecorderOptions;

  constructor(options: RunRecorderOptions) {
    this.#options = options;
  }

  apply(event: AgentEvent): void {
    const { db, runId, conversationId } = this.#options;
    switch (event.type) {
      case "run.started":
        recordRunStarted(db, runId, {
          model: event.model,
          effort: event.effort,
          connections: event.connections,
        });
        return;
      case "session":
        setConversationSession(db, conversationId, event.sdkSessionId);
        return;
      case "tool.input.available":
        this.#toolInput(event);
        return;
      case "approval.requested":
        markToolCallAwaitingApproval(db, this.#key(event.toolCallId), event.approvalId);
        this.#setStatus("awaiting_approval");
        return;
      case "approval.resolved":
        markToolCallDecided(db, this.#key(event.toolCallId), decisionOf(event));
        if (countPendingApprovalsForRun(db, runId) === 0) this.#setStatus("running");
        return;
      case "tool.denied":
        markToolCallDenied(db, this.#key(event.toolCallId), {
          decision: event.decision,
          reason: this.#options.redact(event.reason),
          finishedAt: this.#now(),
        });
        return;
      case "tool.output":
        this.#toolOutput(event);
        return;
      case "usage":
        this.#usage(event);
        return;
      case "run.finished":
        this.#finished(event);
        return;
      default:
        return;
    }
  }

  #toolInput(event: AgentEventOf<"tool.input.available">): void {
    const { db, runId, conversationId, redact } = this.#options;
    insertToolCall(db, {
      id: this.#options.newId(),
      runId,
      conversationId,
      toolUseId: event.toolCallId,
      integration: event.tool?.integration ?? null,
      connectionKind: event.tool?.connectionKind ?? null,
      toolName: event.toolName,
      operation: event.tool?.operation ?? null,
      actionClass: event.tool?.actionClass ?? null,
      title: redact(event.title),
      input: redactJsonObject(event.input, redact),
      startedAt: this.#now(),
    });
  }

  #toolOutput(event: AgentEventOf<"tool.output">): void {
    const { db, redact } = this.#options;
    const error = event.error;
    markToolCallFinished(db, this.#key(event.toolCallId), {
      output: redactJson(event.output, redact),
      truncated: event.truncated,
      isError: event.isError,
      errorCode: error?.code ?? null,
      errorMessage: error === null ? null : redact(error.message),
      httpStatus: event.execution?.httpStatus ?? error?.status ?? null,
      upstreamTool: event.execution?.upstreamTool ?? null,
      idempotencyKey: event.execution?.idempotencyKey ?? null,
      durationMs: event.durationMs,
      finishedAt: this.#now(),
    });
  }

  #usage(event: AgentEventOf<"usage">): void {
    const { db, runId, conversationId } = this.#options;
    const previous = recordRunUsage(db, runId, event);
    // Usage events carry run totals; the conversation gets the difference.
    addConversationUsage(db, conversationId, {
      costUsd: event.costUsd - (previous?.costUsd ?? 0),
      inputTokens: event.inputTokens - (previous?.inputTokens ?? 0),
      outputTokens: event.outputTokens - (previous?.outputTokens ?? 0),
    });
  }

  #finished(event: AgentEventOf<"run.finished">): void {
    const { db, runId, redact } = this.#options;
    const now = this.#now();
    db.transaction((tx) => {
      finishRun(tx, runId, {
        status: event.status,
        finishedAt: event.finishedAt,
        stopReason: event.stopReason,
        terminalReason: event.terminalReason,
        error:
          event.error === null
            ? null
            : { code: event.error.code, message: redact(event.error.message) },
      });
      interruptToolCalls(tx, runId, now);
      setConversationStatus(
        tx,
        this.#options.conversationId,
        event.status === "failed" ? "error" : "idle",
        now,
      );
    });
  }

  #key(toolUseId: string): ToolCallKey {
    return { runId: this.#options.runId, toolUseId };
  }

  #setStatus(status: ConversationStatus): void {
    setConversationStatus(this.#options.db, this.#options.conversationId, status, this.#now());
  }

  #now(): string {
    return this.#options.now().toISOString();
  }
}

function decisionOf(
  event: AgentEventOf<"approval.resolved">,
): Extract<ToolDecision, "approved" | "denied" | "timed_out" | "stopped"> {
  if (event.approved) return "approved";
  switch (event.decidedBy) {
    case "user":
      return "denied";
    case "timeout":
      return "timed_out";
    case "stop":
      return "stopped";
  }
}
