// The in-process tools of the API integrations (Stripe, QuickBooks, Slack).
//
// An ApiTool is structurally the gateway's ApiToolDefinition
// (src/gateway/api-server.ts), typed against the frozen ApiCallContext so a
// write always receives the gateway-derived idempotency key. The gateway turns
// a list of them into one in-process MCP server per query.

import type { AnyZodRawShape, InferShape } from "@anthropic-ai/claude-agent-sdk";
import type { ApiCallContext } from "../../contracts/integration.js";
import type { JsonValue } from "../../contracts/json.js";
import { ApiToolError } from "./errors.js";

export interface ApiTool<Shape extends AnyZodRawShape = AnyZodRawShape> {
  /** The name after `mcp__<integration>__`; equal to its ToolSpec name. */
  readonly name: string;
  /** What the model reads to choose and fill the tool. */
  readonly description: string;
  /** A zod raw shape; the SDK converts it to the JSON schema the model sees. */
  readonly input: Shape;
  /** Reads run concurrently and carry readOnlyHint; everything else is a write. */
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  /** Returns JSON data for the model; throws ApiToolError for a provider error. */
  run(args: InferShape<Shape>, context: ApiCallContext): Promise<JsonValue>;
}

/** Keeps the zod shape's inferred argument type for `run`. */
export function apiTool<Shape extends AnyZodRawShape>(tool: ApiTool<Shape>): ApiTool<Shape> {
  return tool;
}

/** Per-run facts the API tools need besides the connection. */
export type ApiToolOptions = {
  /**
   * The workspace currency (WorkspaceSettings.currency). QuickBooks omits the
   * currency on transactions when multicurrency is off; amounts then use it.
   */
  readonly currency: string;
};

/**
 * The idempotency key of a write. A write without one fails closed, before
 * anything is sent (docs/ARCHITECTURE.md §5, "Tool-use id").
 */
export function requireIdempotencyKey(provider: string, context: ApiCallContext): string {
  const key = context.idempotencyKey;
  if (typeof key !== "string" || key.trim() === "") {
    throw new ApiToolError(provider, "Refusing a write without an idempotency key.", {
      code: "idempotency_key_missing",
    });
  }
  return key;
}
