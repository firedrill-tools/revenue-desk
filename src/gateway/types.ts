// Shared types of the tool gateway (docs/ARCHITECTURE.md §5 "Tool gateway").
//
// Every tool reaches the model through one in-process MCP server per
// integration and per query(). A GatewayTool is one allowlisted tool of a
// run: its descriptor (profile entry plus integration and connection kind),
// the MCP definition the model sees, and how to execute it (an in-process
// API call or a forwarded upstream MCP call). The gateway server adds what
// every call needs: the tool-use id and idempotency key, fail-closed writes,
// output compaction and redaction, and the observer that feeds the action log.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ConnectionKind,
  IntegrationId,
  SdkToolName,
  ToolDescriptor,
  ToolFailure,
} from "../contracts/integration.js";
import type { JsonObject, JsonValue } from "../contracts/json.js";

/** What a tool's executor receives besides its arguments. */
export type ExecutionContext = {
  readonly runId: string;
  /** The model's tool_use id; a synthetic `untracked-…` id for a read that arrived without one. */
  readonly toolUseId: string;
  /** Hex sha256 of `${runId}:${toolUseId}`. */
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
};

/** The raw outcome of one execution, before compaction and redaction. */
export type ToolExecution = {
  readonly result: CallToolResult;
  /** Normalised provider error when the call failed. */
  readonly error: ToolFailure | null;
  /** HTTP status of the provider's last response (2xx included), when the executor knows it. */
  readonly httpStatus: number | null;
  /** The idempotency key a write actually sent to the provider; null when none was sent. */
  readonly idempotencyKey: string | null;
};

/** One tool a gateway server offers. */
export interface GatewayTool {
  readonly descriptor: ToolDescriptor;
  /** The MCP tool the model sees; its name equals descriptor.name. */
  readonly definition: Tool;
  execute(args: JsonObject, context: ExecutionContext): Promise<ToolExecution>;
}

/** A call as the gateway started it. */
export type GatewayCall = {
  readonly integration: IntegrationId;
  readonly connectionKind: ConnectionKind;
  /** The name after `mcp__<integration>__`. */
  readonly tool: string;
  readonly sdkName: SdkToolName;
  /** A Composio slug, an MCP tool name, or "POST /v1/refunds". */
  readonly upstreamTool: string;
  /** Null when the CLI sent no tool-use id (the call cannot be joined to its tool_use). */
  readonly toolUseId: string | null;
  readonly idempotencyKey: string | null;
  readonly arguments: JsonObject;
  /** False for a write: once started it runs to its own deadline, whatever happens to the run. */
  readonly readOnly: boolean;
};

/** A settled call, as the model received it (compacted and redacted). */
export type GatewayCallResult = {
  readonly call: GatewayCall;
  readonly output: JsonValue;
  readonly truncated: boolean;
  readonly isError: boolean;
  readonly error: ToolFailure | null;
  readonly httpStatus: number | null;
  /** The idempotency key the call actually sent (only API writes send one). */
  readonly idempotencyKey: string | null;
  readonly durationMs: number;
};

/**
 * Receives every call the gateway executes: the agent core turns these into
 * tool.progress and tool.output events (the action log). Observers must not
 * throw; a throwing observer is ignored.
 */
export interface GatewayObserver {
  callStarted?(call: GatewayCall): void;
  callProgress?(call: GatewayCall, elapsedMs: number): void;
  callFinished(result: GatewayCallResult): void;
}

/** A tool result that reports an error to the model instead of data. */
export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Runs an observer callback, never letting it change a tool result. */
export function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Observation must never change a tool result.
  }
}

/**
 * The error code of a write that may have been applied: it was sent (or may
 * have been) and no answer came back. Retrying it could apply it twice.
 */
export const OUTCOME_UNKNOWN = "outcome_unknown";

/** The model- and log-facing text of an outcome_unknown write. */
export function outcomeUnknownMessage(cause: string): string {
  return `${cause.replace(/[.\s]+$/, "")}. This change may already have been made. Do not repeat it: check the record first (for example list the charge's refunds, or read the invoice or payment) and report what you find.`;
}

/**
 * How long a started write may run before it is aborted: the HTTP layer's
 * per-attempt limit (60 s; writes are never retried) plus a margin.
 */
export const WRITE_DEADLINE_MS = 65_000;
