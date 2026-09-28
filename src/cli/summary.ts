// Builds the `--json` RunSummary (src/contracts/cli.ts) from a run's
// AgentEvents, and maps the outcome to an exit code. Pure: no I/O.

import {
  CLI_EXIT_CODES,
  type CliExitCode,
  type RunSummary,
  type RunSummaryToolCall,
} from "../contracts/cli.js";
import type { AgentEffort } from "../contracts/env.js";
import type {
  AgentEvent,
  AgentEventOf,
  RunConnection,
  RunUsage,
  ToolDecision,
  ToolMetadata,
} from "../contracts/events.js";

export type RunFinished = AgentEventOf<"run.finished">;

/** What the CLI knows before the core reports anything. */
export type SummarySeed = {
  readonly runId: string;
  readonly conversationId: string;
  readonly model: string;
  readonly effort: AgentEffort;
  readonly startedAt: string;
  readonly connections: readonly RunConnection[];
};

type ToolCallState = {
  readonly toolCallId: string;
  toolName: string;
  /**
   * The base class from tool.input.start, replaced by the classification of
   * the complete input from tool.input.available when there is one.
   */
  metadata: ToolMetadata | null;
  approved: boolean | null;
  decision: ToolDecision;
  isError: boolean;
  durationMs: number | null;
};

export class RunSummaryBuilder {
  #seed: SummarySeed;
  readonly #calls = new Map<string, ToolCallState>();
  #usage: RunUsage | null = null;
  #finished: RunFinished | null = null;

  constructor(seed: SummarySeed) {
    this.#seed = seed;
  }

  get finished(): RunFinished | null {
    return this.#finished;
  }

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "run.started":
        this.#seed = {
          runId: event.runId,
          conversationId: event.conversationId,
          model: event.model,
          effort: event.effort,
          startedAt: event.startedAt,
          connections: event.connections,
        };
        return;
      case "tool.input.start": {
        const call = this.#call(event.toolCallId, event.toolName);
        call.metadata ??= event.tool;
        return;
      }
      case "tool.input.available": {
        const call = this.#call(event.toolCallId, event.toolName);
        if (event.tool !== null) call.metadata = event.tool;
        return;
      }
      case "approval.resolved": {
        const call = this.#calls.get(event.toolCallId);
        if (call !== undefined) call.approved = event.approved;
        return;
      }
      case "tool.output": {
        const call = this.#calls.get(event.toolCallId);
        if (call === undefined) return;
        call.decision = call.approved === true ? "approved" : "auto";
        call.isError = event.isError;
        call.durationMs = event.durationMs;
        return;
      }
      case "tool.denied": {
        const call = this.#calls.get(event.toolCallId);
        if (call !== undefined) call.decision = event.decision;
        return;
      }
      case "usage": {
        const { type: _type, ...usage } = event;
        this.#usage = usage;
        return;
      }
      case "run.finished":
        this.#finished ??= event;
        return;
      default:
        return;
    }
  }

  /** The summary of a finished run. Call only after a run.finished was applied. */
  build(): RunSummary {
    const finished = this.#finished;
    if (finished === null) throw new Error("RunSummaryBuilder.build() before run.finished");
    return {
      kind: "revenue-desk.run-summary",
      version: 1,
      runId: this.#seed.runId,
      conversationId: this.#seed.conversationId,
      mode: "headless",
      status: finished.status,
      reply: finished.reply,
      model: this.#seed.model,
      effort: this.#seed.effort,
      startedAt: this.#seed.startedAt,
      finishedAt: finished.finishedAt,
      usage: this.#usage,
      stopReason: finished.stopReason,
      terminalReason: finished.terminalReason,
      error: finished.error,
      connections: this.#seed.connections,
      toolCalls: [...this.#calls.values()].map(toSummaryCall),
    };
  }

  #call(toolCallId: string, toolName: string): ToolCallState {
    let call = this.#calls.get(toolCallId);
    if (call === undefined) {
      call = {
        toolCallId,
        toolName,
        metadata: null,
        approved: null,
        decision: "pending",
        isError: false,
        durationMs: null,
      };
      this.#calls.set(toolCallId, call);
    }
    call.toolName = toolName;
    return call;
  }
}

function toSummaryCall(call: ToolCallState): RunSummaryToolCall {
  const { metadata } = call;
  return {
    toolCallId: call.toolCallId,
    integration: metadata?.integration ?? null,
    connectionKind: metadata?.connectionKind ?? null,
    tool: call.toolName,
    operation: metadata?.operation ?? null,
    actionClass: metadata?.actionClass ?? null,
    decision: call.decision,
    isError: call.isError,
    durationMs: call.durationMs,
  };
}

/** The exit code of a finished run (CLI_EXIT_CODES). */
export function exitCodeFor(finished: Pick<RunFinished, "status" | "error">): CliExitCode {
  switch (finished.status) {
    case "completed":
      return CLI_EXIT_CODES.completed;
    case "cancelled":
      return CLI_EXIT_CODES.cancelled;
    case "timed_out":
      return CLI_EXIT_CODES.timedOut;
    case "failed":
      return finished.error?.code === "config_missing"
        ? CLI_EXIT_CODES.config
        : CLI_EXIT_CODES.failed;
  }
}
