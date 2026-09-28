// Persists one run's AgentEvents (docs/ARCHITECTURE.md §8): the run row, the
// action log (tool_calls), usage totals, the SDK session to resume and the
// conversation status. The assistant message itself is persisted by the
// server-side reducer (message-reducer.ts); approvals rows by the gate.
//
// Everything written here is redacted first. Writes are synchronous
// (better-sqlite3), so a row always exists before the chunk that shows it.

import type { ConversationStatus } from "../contracts/api.js";
import type { AgentEvent, AgentEventOf, ToolDecision, ToolMetadata } from "../contracts/events.js";
import type { IntegrationId, ProbeResult, ToolFailure } from "../contracts/integration.js";
import { countPendingApprovalsForRun } from "../db/repos/approvals.js";
import { recordConnectionFailure } from "../db/repos/connections.js";
import {
  addConversationUsage,
  setConversationSession,
  setConversationStatus,
} from "../db/repos/conversations.js";
import { finishRun, recordRunStarted, recordRunUsage, setRunSession } from "../db/repos/runs.js";
import {
  insertToolCall,
  interruptToolCalls,
  markToolCallAwaitingApproval,
  markToolCallDecided,
  markToolCallDenied,
  markToolCallExecuting,
  markToolCallFinished,
  type ToolCallKey,
} from "../db/repos/tool-calls.js";
import type { DbExecutor } from "../db/repos/types.js";
import { idempotencyKeyFor } from "../gateway/context.js";
import { type Redact, redactJson, redactJsonObject } from "./redaction.js";

export type RunRecorderOptions = {
  readonly db: DbExecutor;
  readonly runId: string;
  readonly conversationId: string;
  readonly redact: Redact;
  readonly now: () => Date;
  readonly newId: () => string;
  /**
   * What a failed call says about its integration's connection
   * (connectionFromFailure in src/integrations/registry.ts): an expired or
   * refused credential is recorded on the connections row, as a check would.
   */
  readonly connectionFromFailure?: (
    integration: IntegrationId,
    failure: ToolFailure,
  ) => ProbeResult | null;
};

/** The longest connection detail stored (as ConnectionService stores a check's). */
const MAX_CONNECTION_DETAIL = 300;

export class RunRecorder {
  readonly #options: RunRecorderOptions;
  /** Base metadata from tool.input.start, for calls whose input cannot be classified. */
  readonly #baseMetadata = new Map<string, ToolMetadata | null>();
  /** The classified metadata of each call, from tool.input.available. */
  readonly #metadata = new Map<string, ToolMetadata | null>();
  /** Calls whose start (the first tool.progress) was recorded. */
  readonly #started = new Set<string>();

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
        setRunSession(db, runId, event.sdkSessionId);
        return;
      case "tool.input.start":
        this.#baseMetadata.set(event.toolCallId, event.tool);
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
      case "tool.progress":
        this.#toolStarted(event.toolCallId);
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
    // A known tool whose input cannot be classified (e.g. schema-invalid, so
    // rejected) keeps its integration, kind, operation and base class; only an
    // unknown tool is recorded without them.
    const tool = event.tool ?? this.#baseMetadata.get(event.toolCallId) ?? null;
    this.#metadata.set(event.toolCallId, tool);
    insertToolCall(db, {
      id: this.#options.newId(),
      runId,
      conversationId,
      toolUseId: event.toolCallId,
      integration: tool?.integration ?? null,
      connectionKind: tool?.connectionKind ?? null,
      toolName: event.toolName,
      operation: tool?.operation ?? null,
      actionClass: tool?.actionClass ?? null,
      title: redact(event.title),
      input: redactJsonObject(event.input, redact),
      startedAt: this.#now(),
    });
  }

  /**
   * The gateway started the call. An API write carries its idempotency key
   * from now on (derived from the run and the tool_use id, as the gateway
   * derives it), so a run that ends before its answer records which request
   * may have been applied.
   */
  #toolStarted(toolCallId: string): void {
    if (this.#started.has(toolCallId)) return;
    this.#started.add(toolCallId);
    const tool = this.#metadata.get(toolCallId) ?? null;
    if (tool === null || tool.connectionKind !== "api" || tool.actionClass === "read") return;
    markToolCallExecuting(
      this.#options.db,
      this.#key(toolCallId),
      idempotencyKeyFor(this.#options.runId, toolCallId),
    );
  }

  #toolOutput(event: AgentEventOf<"tool.output">): void {
    const { db, redact } = this.#options;
    const error = event.error;
    this.#connectionFailure(event.toolCallId, error);
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

  /** A call whose provider refused the credential marks its connection expired or needs_auth. */
  #connectionFailure(toolCallId: string, error: ToolFailure | null): void {
    const judge = this.#options.connectionFromFailure;
    const integration = this.#metadata.get(toolCallId)?.integration;
    if (judge === undefined || error === null || integration === undefined) return;
    const result = judge(integration, error);
    if (result === null) return;
    const detail = this.#options.redact(result.detail);
    recordConnectionFailure(
      this.#options.db,
      integration,
      {
        state: result.state,
        detail:
          detail.length <= MAX_CONNECTION_DETAIL
            ? detail
            : `${detail.slice(0, MAX_CONNECTION_DETAIL - 1)}…`,
      },
      this.#now(),
    );
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
