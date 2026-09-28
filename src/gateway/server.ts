// One in-process MCP server per integration and per query() (docs/ARCHITECTURE.md §5).
//
// A hand-built McpServer with raw JSON-schema handlers (proved by spike S2):
// tools/list returns the offered definitions unchanged; tools/call reads the
// model's tool_use id from `_meta`, refuses a write without it, derives the
// idempotency key, runs the tool, then compacts and redacts the result that
// the model receives and reports the call to the observer.
//
// Build a fresh instance for every query(): an instance holds one transport,
// and a second concurrent query() silently gets no tools from a shared one.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IntegrationId } from "../contracts/integration.js";
import type { JsonObject } from "../contracts/json.js";
import { compactToolResult, DEFAULT_MAX_OUTPUT_CHARS } from "./compact.js";
import {
  idempotencyKeyFor,
  MISSING_TOOL_USE_ID,
  toolUseIdFromMeta,
  untrackedToolUseId,
} from "./context.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "./mcp-proxy.js";
import {
  errorResult,
  type GatewayCall,
  type GatewayObserver,
  type GatewayTool,
  notify,
  type ToolExecution,
} from "./types.js";

export type GatewayServerOptions = {
  readonly integration: IntegrationId;
  readonly runId: string;
  readonly tools: readonly GatewayTool[];
  readonly observer?: GatewayObserver;
  /** Applied to every result before the model or the observer sees it. */
  readonly redact?: (text: string) => string;
  readonly maxOutputChars?: number;
  /** Per-call wall-clock limit (the SDK ignores values under 1000). */
  readonly timeoutMs?: number;
  /** How often callProgress fires while a call runs. Default 1000. */
  readonly progressIntervalMs?: number;
  /** MCP instructions for the model; upstream instructions are only forwarded when passed here. */
  readonly instructions?: string;
};

export interface GatewayServer {
  readonly integration: IntegrationId;
  readonly tools: readonly GatewayTool[];
  /** A fresh server instance for one query(). */
  serverConfig(): McpSdkServerConfigWithInstance;
}

function asJsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServer {
  const byName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const definitions = options.tools.map((tool) => tool.definition);
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const progressIntervalMs = options.progressIntervalMs ?? 1_000;
  const observer = options.observer;

  const call = async (
    name: string,
    rawArgs: unknown,
    meta: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    const tool = byName.get(name);
    if (tool === undefined) {
      return errorResult(`Tool ${name} is not available on ${options.integration}.`);
    }
    const { descriptor } = tool;
    const args = asJsonObject(rawArgs);
    const toolUseId = toolUseIdFromMeta(meta);
    const idempotencyKey = toolUseId === null ? null : idempotencyKeyFor(options.runId, toolUseId);
    const gatewayCall: GatewayCall = {
      integration: descriptor.integration,
      connectionKind: descriptor.connectionKind,
      tool: descriptor.name,
      sdkName: descriptor.sdkName,
      upstreamTool: descriptor.upstream,
      toolUseId,
      idempotencyKey,
      arguments: args,
    };
    const started = performance.now();
    let execution: ToolExecution;
    if (toolUseId === null && !descriptor.readOnly) {
      // Fail closed: without the tool_use id there is no idempotency key and no action-log join.
      execution = {
        result: errorResult(MISSING_TOOL_USE_ID),
        error: {
          provider: null,
          status: null,
          code: "tool_use_id_missing",
          message: MISSING_TOOL_USE_ID,
        },
        httpStatus: null,
      };
    } else {
      notify(() => observer?.callStarted?.(gatewayCall));
      const progress = setInterval(() => {
        notify(() =>
          observer?.callProgress?.(gatewayCall, Math.round(performance.now() - started)),
        );
      }, progressIntervalMs);
      progress.unref();
      const contextId = toolUseId ?? untrackedToolUseId();
      try {
        execution = await tool.execute(args, {
          runId: options.runId,
          toolUseId: contextId,
          idempotencyKey: idempotencyKey ?? idempotencyKeyFor(options.runId, contextId),
          signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        execution = {
          result: errorResult(message),
          error: { provider: descriptor.integration, status: null, code: null, message },
          httpStatus: null,
        };
      } finally {
        clearInterval(progress);
      }
    }
    const compacted = compactToolResult(execution.result, {
      maxChars,
      ...(options.redact === undefined ? {} : { redact: options.redact }),
    });
    const redact = options.redact ?? ((text: string) => text);
    const error =
      execution.error === null
        ? null
        : {
            ...execution.error,
            message: redact(execution.error.message),
          };
    notify(() =>
      observer?.callFinished({
        call: gatewayCall,
        output: compacted.output,
        truncated: compacted.truncated,
        isError: compacted.result.isError === true,
        error,
        httpStatus: execution.httpStatus,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    return compacted.result;
  };

  const serverConfig = (): McpSdkServerConfigWithInstance => {
    const instance = new McpServer(
      { name: options.integration, version: "1.0.0" },
      {
        capabilities: { tools: { listChanged: false } },
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      },
    );
    instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definitions }));
    instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      call(request.params.name, request.params.arguments, request.params._meta, extra.signal),
    );
    return {
      type: "sdk",
      name: options.integration,
      instance,
      timeout: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    };
  };

  return { integration: options.integration, tools: options.tools, serverConfig };
}
