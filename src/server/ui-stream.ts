// AgentEvent -> AI SDK v7 UI message chunks (docs/ARCHITECTURE.md §6).
//
// One mapper per run turns the core's ordered events into the chunks of one
// assistant message. The sequence is the one spike S1 proved against the
// v7 reducer (useChat and readUIMessageStream):
//
//   run.started            start{messageId, metadata}, a persisted data-notice per unavailable connection
//   status                 transient data-status
//   step.start/.finish     start-step / finish-step
//   text.*, reasoning.*    text-* / reasoning-*
//   tool.input.start       tool-input-start{dynamic, title, toolMetadata}
//   tool.input.available   tool-input-available (exactly once per call)
//   approval.requested     tool-approval-request{approvalDescriptor, reason: consequence}
//   approval.resolved      tool-approval-response
//   tool.denied            policy_denied: an automatic request/response pair, then tool-output-denied;
//                          rejected: tool-output-error; otherwise tool-output-denied
//   tool.progress          transient data-progress
//   tool.output            tool-output-available, or tool-output-error when isError
//   usage                  persisted data-usage and message-metadata{usage}
//   run.finished           message-metadata{status}, then finish, abort or error
//
// Invariants the mapper enforces whatever the core emits, because the
// reducer throws or renders nothing otherwise:
// - a tool-approval-response always precedes the outcome of a call that asked;
// - a denied call always carries a response (approved:false), so the approval
//   card can say why;
// - tool-input-available is sent once per call;
// - chunks for a call the stream never started are dropped (reported);
// - at run.finished, open text/reasoning parts are ended and every call
//   without an outcome is closed (interrupted), so no part keeps spinning.
//
// Also used by the CLI (through readUIMessageStream) to persist its messages.

import type { InferUIMessageChunk } from "ai";
import type { ChatMessageMetadata, ChatUIMessage, NoticeData } from "../contracts/api.js";
import type { AgentEvent, AgentEventOf, RunConnection, RunUsage } from "../contracts/events.js";
import { INTEGRATIONS } from "../contracts/integration.js";
import type { JsonValue } from "../contracts/json.js";
import { type Redact, redactJson } from "./redaction.js";

export type ChatUIChunk = InferUIMessageChunk<ChatUIMessage>;

export const INTERRUPTED_TOOL_TEXT = "Interrupted: the run ended before this call finished.";
export const UNDECIDED_APPROVAL_TEXT = "The run ended before a decision was made.";
export const FAILED_RUN_TEXT = "The run failed.";

/** The approval id of the automatic (policy) denial of a call. */
export function automaticApprovalId(toolCallId: string): string {
  return `policy_${toolCallId}`;
}

/** Transient chunks are delivered live but never become part of the message. */
export function isTransientChunk(chunk: ChatUIChunk): boolean {
  return (
    (chunk.type === "data-status" || chunk.type === "data-progress") && chunk.transient === true
  );
}

export type UIStreamMapperOptions = {
  /** The assistant message id (the `start` chunk's messageId). */
  readonly messageId: string;
  /** Metadata for a `start` the mapper must send before run.started arrived. */
  readonly fallbackMetadata: ChatMessageMetadata;
  readonly redact: Redact;
  /** Events that break the AgentEvent ordering rules; their chunks are dropped. */
  readonly onAnomaly?: (message: string) => void;
};

type ToolCallState = {
  inputAvailable: boolean;
  approvalId: string | null;
  /** The approval response that was sent, if any. */
  approved: boolean | null;
  /** An outcome chunk (output or denial) was sent. */
  settled: boolean;
};

export class UIStreamMapper {
  readonly #options: UIStreamMapperOptions;
  #metadata: ChatMessageMetadata;
  #started = false;
  #finished = false;
  readonly #openText = new Set<string>();
  readonly #openReasoning = new Set<string>();
  readonly #tools = new Map<string, ToolCallState>();

  constructor(options: UIStreamMapperOptions) {
    this.#options = options;
    this.#metadata = { ...options.fallbackMetadata };
  }

  /** True once run.finished was mapped; later events are ignored. */
  get finished(): boolean {
    return this.#finished;
  }

  map(event: AgentEvent): ChatUIChunk[] {
    if (this.#finished) {
      this.#anomaly(`${event.type} after run.finished`);
      return [];
    }
    if (event.type === "run.started") return this.#runStarted(event);
    const chunks: ChatUIChunk[] = this.#started ? [] : this.#start();
    chunks.push(...this.#mapAfterStart(event));
    return chunks;
  }

  #mapAfterStart(event: Exclude<AgentEvent, { readonly type: "run.started" }>): ChatUIChunk[] {
    switch (event.type) {
      case "session":
        return [];
      case "status":
        return [{ type: "data-status", data: event.status, transient: true }];
      case "step.start":
        return [{ type: "start-step" }];
      case "step.finish":
        return [{ type: "finish-step" }];
      case "text.start":
        this.#openText.add(event.id);
        return [{ type: "text-start", id: event.id }];
      case "text.delta":
        if (!this.#openText.has(event.id)) return this.#drop(`text.delta for unknown ${event.id}`);
        return [{ type: "text-delta", id: event.id, delta: event.delta }];
      case "text.end":
        if (!this.#openText.delete(event.id)) return this.#drop(`text.end for unknown ${event.id}`);
        return [{ type: "text-end", id: event.id }];
      case "reasoning.start":
        this.#openReasoning.add(event.id);
        return [{ type: "reasoning-start", id: event.id }];
      case "reasoning.delta":
        if (!this.#openReasoning.has(event.id)) {
          return this.#drop(`reasoning.delta for unknown ${event.id}`);
        }
        return [{ type: "reasoning-delta", id: event.id, delta: event.delta }];
      case "reasoning.end":
        if (!this.#openReasoning.delete(event.id)) {
          return this.#drop(`reasoning.end for unknown ${event.id}`);
        }
        return [{ type: "reasoning-end", id: event.id }];
      case "tool.input.start":
        return this.#toolInputStart(event);
      case "tool.input.delta": {
        const tool = this.#tools.get(event.toolCallId);
        if (tool === undefined || tool.inputAvailable) {
          return this.#drop(`tool.input.delta out of order for ${event.toolCallId}`);
        }
        return [
          {
            type: "tool-input-delta",
            toolCallId: event.toolCallId,
            inputTextDelta: event.inputTextDelta,
          },
        ];
      }
      case "tool.input.available":
        return this.#toolInputAvailable(event);
      case "approval.requested":
        return this.#approvalRequested(event);
      case "approval.resolved":
        return this.#approvalResolved(event);
      case "tool.denied":
        return this.#toolDenied(event);
      case "tool.progress":
        if (!this.#tools.has(event.toolCallId)) {
          return this.#drop(`tool.progress for unknown ${event.toolCallId}`);
        }
        return [
          {
            type: "data-progress",
            data: { toolCallId: event.toolCallId, elapsedMs: event.elapsedMs },
            transient: true,
          },
        ];
      case "tool.output":
        return this.#toolOutput(event);
      case "usage":
        return this.#usage(event);
      case "run.finished":
        return this.#runFinished(event);
    }
  }

  #start(): ChatUIChunk[] {
    this.#started = true;
    return [
      { type: "start", messageId: this.#options.messageId, messageMetadata: { ...this.#metadata } },
    ];
  }

  #runStarted(event: AgentEventOf<"run.started">): ChatUIChunk[] {
    if (this.#started) return this.#drop("a second run.started");
    this.#metadata = { runId: event.runId, model: event.model, effort: event.effort };
    const chunks = this.#start();
    for (const connection of event.connections) {
      if (connection.availability !== "unavailable") continue;
      chunks.push({
        type: "data-notice",
        id: `notice-${connection.integration}`,
        data: noticeFor(connection),
      });
    }
    return chunks;
  }

  #toolInputStart(event: AgentEventOf<"tool.input.start">): ChatUIChunk[] {
    if (this.#tools.has(event.toolCallId)) {
      return this.#drop(`a second tool.input.start for ${event.toolCallId}`);
    }
    this.#tools.set(event.toolCallId, {
      inputAvailable: false,
      approvalId: null,
      approved: null,
      settled: false,
    });
    return [
      {
        type: "tool-input-start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        dynamic: true,
        title: event.title,
        ...(event.tool === null ? {} : { toolMetadata: event.tool }),
      },
    ];
  }

  #toolInputAvailable(event: AgentEventOf<"tool.input.available">): ChatUIChunk[] {
    let tool = this.#tools.get(event.toolCallId);
    if (tool?.inputAvailable) {
      // A second tool-input-available after a new step would duplicate the part.
      return this.#drop(`a second tool.input.available for ${event.toolCallId}`);
    }
    if (tool === undefined) {
      tool = { inputAvailable: false, approvalId: null, approved: null, settled: false };
      this.#tools.set(event.toolCallId, tool);
    }
    tool.inputAvailable = true;
    return [
      {
        type: "tool-input-available",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        dynamic: true,
        input: redactJson(event.input, this.#options.redact),
        title: event.title,
        ...(event.tool === null ? {} : { toolMetadata: event.tool }),
      },
    ];
  }

  #approvalRequested(event: AgentEventOf<"approval.requested">): ChatUIChunk[] {
    const tool = this.#tools.get(event.toolCallId);
    if (tool === undefined || tool.settled || tool.approvalId !== null) {
      return this.#drop(`approval.requested out of order for ${event.toolCallId}`);
    }
    tool.approvalId = event.approvalId;
    return [
      {
        type: "tool-approval-request",
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        approvalDescriptor: redactJson(event.descriptor, this.#options.redact),
        reason: event.descriptor.consequence,
      },
    ];
  }

  #approvalResolved(event: AgentEventOf<"approval.resolved">): ChatUIChunk[] {
    const tool = this.#tools.get(event.toolCallId);
    if (tool === undefined || tool.approvalId !== event.approvalId || tool.approved !== null) {
      return this.#drop(`approval.resolved out of order for ${event.toolCallId}`);
    }
    return this.#respond(tool, event.approved, event.reason);
  }

  #respond(tool: ToolCallState, approved: boolean, reason: string | null): ChatUIChunk[] {
    if (tool.approvalId === null) return [];
    tool.approved = approved;
    return [
      {
        type: "tool-approval-response",
        approvalId: tool.approvalId,
        approved,
        ...(reason === null ? {} : { reason }),
      },
    ];
  }

  /** The approval request and response of a call the policy denied without asking. */
  #automaticDenial(toolCallId: string, tool: ToolCallState, reason: string): ChatUIChunk[] {
    tool.approvalId = automaticApprovalId(toolCallId);
    return [
      {
        type: "tool-approval-request",
        approvalId: tool.approvalId,
        toolCallId,
        isAutomatic: true,
        reason,
      },
      ...this.#respond(tool, false, reason),
    ];
  }

  #toolDenied(event: AgentEventOf<"tool.denied">): ChatUIChunk[] {
    const tool = this.#tools.get(event.toolCallId);
    if (tool === undefined || tool.settled) {
      return this.#drop(`tool.denied out of order for ${event.toolCallId}`);
    }
    tool.settled = true;
    if (event.decision === "rejected" && tool.approvalId === null) {
      return [
        {
          type: "tool-output-error",
          toolCallId: event.toolCallId,
          errorText: this.#options.redact(event.reason),
        },
      ];
    }
    const chunks: ChatUIChunk[] = [];
    if (tool.approvalId === null) {
      chunks.push(...this.#automaticDenial(event.toolCallId, tool, event.reason));
    } else if (tool.approved === null) {
      chunks.push(...this.#respond(tool, false, event.reason));
    }
    chunks.push({ type: "tool-output-denied", toolCallId: event.toolCallId });
    return chunks;
  }

  #toolOutput(event: AgentEventOf<"tool.output">): ChatUIChunk[] {
    const tool = this.#tools.get(event.toolCallId);
    if (tool === undefined || tool.settled) {
      return this.#drop(`tool.output out of order for ${event.toolCallId}`);
    }
    tool.settled = true;
    const chunks: ChatUIChunk[] = [];
    if (tool.approvalId !== null && tool.approved === null) {
      // It ran, so it was approved; the response must precede the output.
      chunks.push(...this.#respond(tool, true, null));
    }
    if (event.isError) {
      chunks.push({
        type: "tool-output-error",
        toolCallId: event.toolCallId,
        errorText: this.#options.redact(event.error?.message ?? textOf(event.output)),
      });
    } else {
      chunks.push({
        type: "tool-output-available",
        toolCallId: event.toolCallId,
        output: redactJson(event.output, this.#options.redact),
      });
    }
    return chunks;
  }

  #usage(event: AgentEventOf<"usage">): ChatUIChunk[] {
    const usage: RunUsage = {
      costUsd: event.costUsd,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      numTurns: event.numTurns,
      modelRequests: event.modelRequests,
      durationMs: event.durationMs,
      durationApiMs: event.durationApiMs,
    };
    this.#metadata = { ...this.#metadata, usage };
    return [
      { type: "data-usage", id: "usage", data: usage },
      { type: "message-metadata", messageMetadata: { ...this.#metadata } },
    ];
  }

  #runFinished(event: AgentEventOf<"run.finished">): ChatUIChunk[] {
    this.#finished = true;
    const chunks = this.#closeOpenParts();
    this.#metadata = { ...this.#metadata, status: event.status };
    chunks.push({ type: "message-metadata", messageMetadata: { ...this.#metadata } });
    switch (event.status) {
      case "completed":
        chunks.push({ type: "finish", finishReason: "stop" });
        break;
      case "cancelled":
        chunks.push({ type: "abort", reason: event.stopReason ?? "cancelled" });
        break;
      case "timed_out":
        chunks.push({ type: "abort", reason: event.stopReason ?? "timeout" });
        break;
      case "failed":
        chunks.push({
          type: "error",
          errorText: this.#options.redact(event.error?.message ?? FAILED_RUN_TEXT),
        });
        break;
    }
    return chunks;
  }

  #closeOpenParts(): ChatUIChunk[] {
    const chunks: ChatUIChunk[] = [];
    for (const id of this.#openReasoning) chunks.push({ type: "reasoning-end", id });
    for (const id of this.#openText) chunks.push({ type: "text-end", id });
    this.#openReasoning.clear();
    this.#openText.clear();
    for (const [toolCallId, tool] of this.#tools) {
      if (tool.settled) continue;
      tool.settled = true;
      if (tool.approvalId !== null && tool.approved === null) {
        chunks.push(...this.#respond(tool, false, UNDECIDED_APPROVAL_TEXT));
      }
      if (tool.approved === false) {
        chunks.push({ type: "tool-output-denied", toolCallId });
      } else {
        chunks.push({ type: "tool-output-error", toolCallId, errorText: INTERRUPTED_TOOL_TEXT });
      }
    }
    return chunks;
  }

  #drop(message: string): ChatUIChunk[] {
    this.#anomaly(message);
    return [];
  }

  #anomaly(message: string): void {
    this.#options.onAnomaly?.(message);
  }
}

function noticeFor(connection: RunConnection): NoticeData {
  const label = INTEGRATIONS[connection.integration].label;
  return {
    level: connection.state === "not_configured" ? "info" : "warning",
    code: "connection_unavailable",
    integration: connection.integration,
    message: connection.detail ?? `${label} is unavailable for this run.`,
  };
}

function textOf(value: JsonValue): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json === undefined ? "The tool failed." : json;
}
