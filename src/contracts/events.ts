// Agent core contract: the input of one turn and the AgentEvent stream it
// produces (docs/ARCHITECTURE.md §5, §6). The core (W1) produces events; the
// server (W3) maps them to AI SDK v7 UI message chunks and persists them; the
// CLI (W6) persists them and prints the reply or a run summary.
//
// Frozen for the parallel workstreams. Adjusted from the proposal by spikes
// S1 (UI stream reducer) and S2 (real SDK 0.3.283 message order).
//
// Shared by server, CLI and web: no Node-only globals, no implementation imports.

import type { AgentEnv, ModelSettings } from "./env.js";
import type {
  ActionClass,
  ActionDetails,
  ConnectionKind,
  ConnectionState,
  IntegrationId,
  OperationName,
  PolicyModes,
  ProfileId,
  ResolvedConnection,
  ToolFailure,
  WorkspaceSettings,
} from "./integration.js";
import type { JsonObject, JsonValue } from "./json.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type AgentMode = "interactive" | "headless";
export type RunSource = "ui" | "cli";

export const RUN_STATUSES = ["running", "completed", "failed", "cancelled", "timed_out"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type FinishedRunStatus = Exclude<RunStatus, "running">;

export const RUN_ERROR_CODES = [
  /** ANTHROPIC_API_KEY or another required value is missing. */
  "config_missing",
  /** The model or the Messages API failed (including an unavailable model: no fallback). */
  "model_error",
  "max_turns",
  "budget_exceeded",
  "timeout",
  "cancelled",
  /** The process died with the run in flight (set by boot recovery). */
  "server_restart",
  "internal",
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

/** Sanitised and redacted; safe to show and store. */
export type RunError = { readonly code: RunErrorCode; readonly message: string };

/**
 * Why a run's AbortSignal was aborted. Callers pass it as
 * `controller.abort(reason)`; the core maps it to the finished status.
 * - user: Stop in the UI, SIGINT in the CLI -> cancelled
 * - timeout: the CLI's --timeout-ms -> timed_out
 * - shutdown: SIGTERM of the server or CLI -> cancelled
 */
export type RunStopReason = "user" | "timeout" | "shutdown";

/**
 * How a tool call was decided.
 * - auto: the policy allowed it without asking
 * - approved / denied: a person decided an approval
 * - policy_denied: the policy denies the class, or `ask` in headless mode
 * - timed_out: the approval expired (AGENT_APPROVAL_TIMEOUT_MS)
 * - stopped: the run was stopped while the approval was pending
 * - rejected: refused before the policy: an unknown tool, or input that
 *   fails the tool's JSON schema (validated before any approval)
 */
export const TOOL_DECISIONS = [
  "pending",
  "auto",
  "approved",
  "denied",
  "policy_denied",
  "timed_out",
  "stopped",
  "rejected",
] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

export type ApprovalDecider = "user" | "timeout" | "stop";

/** Token and cost totals for one run (from the SDK result message's modelUsage). */
export type RunUsage = {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** The SDK's num_turns (not the number of model requests). */
  readonly numTurns: number;
  /** Counted from message_start events. */
  readonly modelRequests: number;
  readonly durationMs: number;
  readonly durationApiMs: number;
};

/**
 * The SDK result's terminal_reason values in @anthropic-ai/claude-agent-sdk
 * 0.3.283 (test/unit/contracts.test.ts keeps this equal to TerminalReason).
 * 'aborted_tools' and 'aborted_streaming' mean the run was stopped.
 */
export type SdkTerminalReason =
  | "blocking_limit"
  | "rapid_refill_breaker"
  | "prompt_too_long"
  | "image_error"
  | "model_error"
  | "api_error"
  | "malformed_tool_use_exhausted"
  | "aborted_streaming"
  | "aborted_tools"
  | "stop_hook_prevented"
  | "hook_stopped"
  | "tool_deferred"
  | "max_turns"
  | "background_requested"
  | "completed"
  | "budget_exhausted"
  | "structured_output_retry_exhausted"
  | "tool_deferred_unavailable"
  | "turn_setup_failed";

// ---------------------------------------------------------------------------
// Wire payloads that also travel in the UI message stream (type aliases, so
// they are assignable to the AI SDK's JSONObject)
// ---------------------------------------------------------------------------

/** `toolMetadata` on tool-input-start / tool-input-available chunks. */
export type ToolMetadata = {
  readonly integration: IntegrationId;
  readonly connectionKind: ConnectionKind;
  readonly operation: OperationName;
  /** The tool's base class on input start; the classified class on input available. */
  readonly actionClass: ActionClass;
};

/**
 * `approvalDescriptor` on tool-approval-request; the AI SDK reducer stores it
 * as `approval.descriptor`. web/src/lib/chat.ts reads consequence, facts and
 * actionClass from it (spike S1).
 */
export type ApprovalDescriptor = ActionDetails & {
  readonly actionClass: ActionClass;
  readonly integration: IntegrationId;
  readonly connectionKind: ConnectionKind;
  readonly operation: OperationName;
  readonly title: string;
  /** ISO time after which the approval is denied as timed out. */
  readonly expiresAt: string;
};

/** Availability of one integration for this run. */
export type RunConnection = {
  readonly integration: IntegrationId;
  readonly kind: ConnectionKind;
  readonly profile: ProfileId;
  /** ready: its tools are offered. Otherwise its tools are not offered and the prompt says so. */
  readonly availability: "ready" | "unavailable";
  readonly state: ConnectionState;
  /** Plain sentence for unavailable connections; null when ready. */
  readonly detail: string | null;
  readonly endpointLabel: string | null;
};

/** Transient model status (the UI's "Thinking" and retry lines). */
export type StatusData =
  | { readonly phase: "requesting" }
  | { readonly phase: "compacting" }
  | {
      readonly phase: "retrying";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly retryInMs: number;
      /** HTTP status of the failed attempt; null for a connection error. */
      readonly errorStatus: number | null;
    };

// ---------------------------------------------------------------------------
// AgentEvent
// ---------------------------------------------------------------------------

/**
 * One turn of the agent as an ordered stream. Ordering rules (proved by
 * spikes S1 and S2 against the real SDK and the AI SDK v7 reducer):
 *
 * 1. `run.started` is first and `run.finished` is last, exactly once each,
 *    also when the run fails or is stopped.
 * 2. A step is one model request: `step.start` at message_start,
 *    `step.finish` at message_stop. The SDK asks for permission only after the
 *    step's message has ended, so `step.finish` comes BEFORE any
 *    `approval.requested` or `tool.output` of that step's tool calls.
 * 3. Per tool call (toolCallId is the model's tool_use id):
 *    `tool.input.start` once, then `tool.input.delta`*, then
 *    `tool.input.available` exactly once (from the assistant message; the
 *    canUseTool callback never emits a second one), then either
 *    - `tool.output`, or
 *    - `approval.requested`, `approval.resolved`, then `tool.output`
 *      (approved) or `tool.denied` (not approved), or
 *    - `tool.denied` directly (policy_denied, rejected).
 *    `approval.resolved` always precedes `tool.denied`/`tool.output` for that
 *    call: the UI reducer needs the approval response before the outcome.
 * 4. Text and reasoning blocks: `*.start`, `*.delta`*, `*.end` with one id.
 * 5. Messages with parent_tool_use_id !== null (subagents) produce no events.
 *    A `<synthetic>` or `message.error` assistant message is an error
 *    (run.finished failed, model_error), never text.
 * 6. Reads may run concurrently, so outputs of one step can interleave.
 */
export type AgentEvent =
  | {
      readonly type: "run.started";
      readonly runId: string;
      readonly conversationId: string;
      readonly source: RunSource;
      readonly mode: AgentMode;
      readonly model: string;
      readonly effort: ModelSettings["effort"];
      readonly startedAt: string;
      /** All six integrations, ready or not. */
      readonly connections: readonly RunConnection[];
    }
  | { readonly type: "session"; readonly sdkSessionId: string }
  | { readonly type: "status"; readonly status: StatusData }
  | { readonly type: "step.start" }
  | { readonly type: "step.finish" }
  | { readonly type: "reasoning.start"; readonly id: string }
  | { readonly type: "reasoning.delta"; readonly id: string; readonly delta: string }
  | { readonly type: "reasoning.end"; readonly id: string }
  | { readonly type: "text.start"; readonly id: string }
  | { readonly type: "text.delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text.end"; readonly id: string }
  | {
      readonly type: "tool.input.start";
      readonly toolCallId: string;
      /** As the model saw it, e.g. mcp__stripe__create_refund. */
      readonly toolName: string;
      /** The profile title; the raw name for an unknown tool. */
      readonly title: string;
      /** Null for a name that is not in the run's registry. */
      readonly tool: ToolMetadata | null;
    }
  | {
      readonly type: "tool.input.delta";
      readonly toolCallId: string;
      readonly inputTextDelta: string;
    }
  | {
      readonly type: "tool.input.available";
      readonly toolCallId: string;
      readonly toolName: string;
      /** The classification's title, e.g. "Post to #billing in Slack". */
      readonly title: string;
      readonly input: JsonObject;
      /** Classified from the complete input; null when unknown or unclassifiable. */
      readonly tool: ToolMetadata | null;
    }
  | {
      readonly type: "approval.requested";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly descriptor: ApprovalDescriptor;
    }
  | {
      readonly type: "approval.resolved";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly approved: boolean;
      readonly decidedBy: ApprovalDecider;
      readonly reason: string | null;
    }
  | {
      readonly type: "tool.progress";
      readonly toolCallId: string;
      readonly elapsedMs: number;
    }
  | {
      readonly type: "tool.output";
      readonly toolCallId: string;
      /** What the model received, compacted (about 20k characters at most). */
      readonly output: JsonValue;
      readonly truncated: boolean;
      readonly isError: boolean;
      readonly error: ToolFailure | null;
      readonly durationMs: number;
      /** How the gateway reached the system: for the action log. */
      readonly execution: {
        /** A Composio slug, an MCP tool name or "POST /v1/refunds". */
        readonly upstreamTool: string;
        readonly httpStatus: number | null;
        readonly idempotencyKey: string | null;
      } | null;
    }
  | {
      readonly type: "tool.denied";
      readonly toolCallId: string;
      readonly decision: Extract<
        ToolDecision,
        "denied" | "policy_denied" | "timed_out" | "stopped" | "rejected"
      >;
      /** The text the model received as the tool result. */
      readonly reason: string;
    }
  | ({ readonly type: "usage" } & RunUsage)
  | {
      readonly type: "run.finished";
      readonly status: FinishedRunStatus;
      readonly finishedAt: string;
      readonly stopReason: string | null;
      readonly terminalReason: SdkTerminalReason | null;
      /** The final assistant text of the turn, or null. */
      readonly reply: string | null;
      readonly error: RunError | null;
    };

export type AgentEventType = AgentEvent["type"];
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { readonly type: T }>;

// ---------------------------------------------------------------------------
// Running one turn (src/agent/run-turn.ts, W1)
// ---------------------------------------------------------------------------

export type ApprovalRequest = {
  readonly approvalId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly descriptor: ApprovalDescriptor;
};

export type ApprovalOutcome =
  | { readonly approved: true; readonly decidedBy: "user"; readonly reason: string | null }
  | { readonly approved: false; readonly decidedBy: ApprovalDecider; readonly reason: string };

export interface PendingApproval {
  /** Settles exactly once: the user, the timeout, or the run's signal (stop). */
  readonly decision: Promise<ApprovalOutcome>;
}

/**
 * Implemented by the server (W3): persist the pending approvals row and
 * register its waiter, then resolve. The core emits `approval.requested` only
 * after open() resolves, so a decision can never arrive before its waiter.
 */
export interface ApprovalGate {
  open(request: ApprovalRequest, signal: AbortSignal): Promise<PendingApproval>;
}

/** Whether an integration takes part in this run, decided by the caller. */
export type ConnectionPlan =
  | {
      readonly integration: IntegrationId;
      readonly status: "available";
      readonly connection: ResolvedConnection;
    }
  | {
      readonly integration: IntegrationId;
      readonly status: "unavailable";
      readonly state: Exclude<ConnectionState, "connected">;
      readonly detail: string;
    };

type RunTurnCommon = {
  readonly runId: string;
  readonly conversationId: string;
  readonly source: RunSource;
  /** The user's message text. */
  readonly prompt: string;
  /** conversations.sdk_session_id of an earlier turn, for resume. */
  readonly resumeSessionId: string | null;
  readonly env: AgentEnv;
  readonly model: ModelSettings;
  readonly settings: WorkspaceSettings;
  /** Effective modes after AGENT_POLICY, saved policies and CLI --policy. */
  readonly policy: PolicyModes;
  /** YYYY-MM-DD the prompt states as today. */
  readonly businessDate: string;
  /** One entry per integration. */
  readonly connections: readonly ConnectionPlan[];
  /** Aborted with a RunStopReason. The core interrupts, then hard-aborts after 3 s. */
  readonly signal: AbortSignal;
};

export type RunTurnInput =
  | (RunTurnCommon & { readonly mode: "interactive"; readonly approvals: ApprovalGate })
  /** `ask` becomes policy_denied with HEADLESS_ASK_DENIAL; nothing waits. */
  | (RunTurnCommon & { readonly mode: "headless" });

export type RunTurn = (input: RunTurnInput) => AsyncIterable<AgentEvent>;
