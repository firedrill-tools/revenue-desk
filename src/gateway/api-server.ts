import {
  type AnyZodRawShape,
  createSdkMcpServer,
  type InferShape,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, type GatewayObserver, notify } from "./types.js";

/** What an API tool's `run` receives besides its validated arguments. */
export interface ApiToolContext {
  /** Aborted when the SDK cancels the call (Stop, timeout or the run ending). */
  readonly signal?: AbortSignal;
}

/**
 * One in-process tool of an API integration. `run` returns plain data, which
 * the model receives as JSON text; it throws `ApiToolError` for a provider
 * error the model should see.
 */
export interface ApiToolDefinition<Shape extends AnyZodRawShape = AnyZodRawShape> {
  readonly name: string;
  readonly description: string;
  /** A zod raw shape; the SDK converts it to the JSON schema the model sees. */
  readonly input: Shape;
  /** Reads run in parallel and carry `readOnlyHint`; everything else is a write. */
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  run(args: InferShape<Shape>, context: ApiToolContext): Promise<unknown>;
}

/** Keeps the zod shape's inferred argument type for `run`. */
export function defineApiTool<Shape extends AnyZodRawShape>(
  definition: ApiToolDefinition<Shape>,
): ApiToolDefinition<Shape> {
  return definition;
}

/** A provider error, normalised so the model and the action log see the same fields. */
export class ApiToolError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    provider: string,
    message: string,
    details: { readonly status?: number; readonly code?: string } = {},
  ) {
    super(message);
    this.name = "ApiToolError";
    this.provider = provider;
    this.status = details.status;
    this.code = details.code;
  }

  toJSON(): Record<string, unknown> {
    return {
      provider: this.provider,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
      message: this.message,
    };
  }
}

export interface ApiServerOptions {
  /** The integration id; tools reach the model as `mcp__<name>__<tool>`. */
  readonly name: string;
  // biome-ignore lint/suspicious/noExplicitAny: each tool keeps its own shape.
  readonly tools: readonly ApiToolDefinition<any>[];
  /** Per-call wall-clock limit in milliseconds (the SDK ignores values under 1000). */
  readonly timeoutMs?: number;
  readonly observer?: GatewayObserver;
}

function signalOf(extra: unknown): AbortSignal | undefined {
  if (typeof extra !== "object" || extra === null || !("signal" in extra)) return undefined;
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function annotationsOf(definition: ApiToolDefinition): ToolAnnotations {
  return definition.readOnly
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: definition.destructive === true };
}

function failure(error: unknown): CallToolResult {
  if (error instanceof ApiToolError) return errorResult(JSON.stringify({ error: error.toJSON() }));
  const message = error instanceof Error ? error.message : String(error);
  return errorResult(JSON.stringify({ error: { message } }));
}

function sdkTool(server: string, definition: ApiToolDefinition, observer?: GatewayObserver) {
  const handler = async (args: Record<string, unknown>, extra: unknown) => {
    const started = performance.now();
    let result: CallToolResult;
    try {
      const signal = signalOf(extra);
      const data = await definition.run(args, signal === undefined ? {} : { signal });
      result = { content: [{ type: "text", text: JSON.stringify(data ?? null) }] };
    } catch (error) {
      result = failure(error);
    }
    notify(observer, {
      server,
      kind: "api",
      tool: definition.name,
      arguments: args,
      result,
      isError: result.isError === true,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  };
  return tool(definition.name, definition.description, definition.input, handler, {
    annotations: annotationsOf(definition),
  }) as SdkMcpToolDefinition;
}

/**
 * An in-process MCP server for an API integration, built with the SDK's own
 * `createSdkMcpServer`/`tool()`. Each call returns a new server instance.
 * Build one per `query()`: an instance holds one transport at a time, and a
 * concurrent second query() silently gets no tools from a shared instance.
 *
 * The SDK validates arguments against the zod shape only after `canUseTool`
 * has approved the call, and reports a failure as an MCP -32602 error result;
 * `run` is not called then.
 */
export function createApiServer(options: ApiServerOptions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: options.name,
    version: "1.0.0",
    alwaysLoad: true,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    tools: options.tools.map((definition) => sdkTool(options.name, definition, options.observer)),
  });
}
