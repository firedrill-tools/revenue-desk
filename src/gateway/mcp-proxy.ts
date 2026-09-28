// Upstream MCP servers behind the gateway (HubSpot over stdio or Streamable
// HTTP, Composio's session MCP over Streamable HTTP).
//
// connectUpstream() opens a client and lists every tool page. The gateway
// then offers only the profile's tools, each with its raw upstream JSON
// schema forwarded byte for byte, and forwards calls unchanged under the
// upstream name. Anything else is neither listed nor forwarded. Secrets stay
// in this process: the Claude CLI child never sees an upstream credential.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolDescriptor, ToolFailure } from "../contracts/integration.js";
import type { JsonObject } from "../contracts/json.js";
import {
  errorResult,
  type GatewayTool,
  OUTCOME_UNKNOWN,
  outcomeUnknownMessage,
  type ToolExecution,
} from "./types.js";

/** Where an upstream MCP server lives. */
export type UpstreamConfig =
  | {
      readonly transport: "http";
      readonly url: string;
      /** May carry a credential; never logged. */
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      /** Added to the MCP SDK's minimal inherited environment (PATH, HOME, USER, …), never to `process.env`. */
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    };

/** A connected upstream MCP server and the tools it listed when it connected. */
export interface Upstream {
  readonly client: Client;
  readonly tools: readonly Tool[];
  readonly instructions: string | undefined;
  /** The last few kilobytes a stdio server wrote to stderr, for diagnostics. */
  stderrTail(): string;
  close(): Promise<void>;
}

export type UpstreamConnector = (
  config: UpstreamConfig,
  options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
) => Promise<Upstream>;

const STDERR_TAIL_BYTES = 4_096;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const CLIENT_INFO = { name: "revenue-desk-gateway", version: "1.0.0" };

function transportFor(config: UpstreamConfig): { transport: Transport; stderr: () => string } {
  if (config.transport === "http") {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: { ...config.headers } },
    });
    return { transport, stderr: () => "" };
  }
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    ...(config.env === undefined ? {} : { env: { ...config.env } }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: "pipe",
  });
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  return { transport, stderr: () => tail };
}

async function listAllTools(client: Client, timeoutMs: number, signal?: AbortSignal) {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor }, {
      timeout: timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined) return tools;
  }
  throw new Error("upstream tools/list did not finish within 100 pages");
}

/** Connects to an upstream MCP server and lists its tools (every page). */
export const connectUpstream: UpstreamConnector = async (config, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { transport, stderr } = transportFor(config);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const onAbort = () => void client.close().catch(() => {});
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await client.connect(transport, {
      timeout: timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const tools = await listAllTools(client, timeoutMs, options.signal);
    return {
      client,
      tools,
      instructions: client.getInstructions(),
      stderrTail: stderr,
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => {});
    const detail = stderr().trim();
    const message = error instanceof Error ? error.message : String(error);
    // The cause keeps the transport's error (a StreamableHTTPError carries the
    // HTTP status, so a refused token reads as needs_auth, not a generic error).
    throw new Error(
      `could not connect to the ${config.transport} MCP server: ${message}${detail ? `\n${detail}` : ""}`,
      { cause: error },
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
};

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

function annotationsOf(tool: Tool, descriptor: ToolDescriptor): ToolAnnotations {
  // The profile, not the upstream, decides what counts as read-only.
  return {
    ...tool.annotations,
    readOnlyHint: descriptor.readOnly,
    destructiveHint: descriptor.baseClass === "destructive",
  };
}

/** The upstream tool as the model sees it: its own schema, the profile's name and hints. */
function exposed(tool: Tool, descriptor: ToolDescriptor): Tool {
  return {
    name: descriptor.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    annotations: annotationsOf(tool, descriptor),
    // Never deferred behind tool search: the model's tool list is the same everywhere.
    _meta: { "anthropic/alwaysLoad": true },
  };
}

export type UpstreamTools = {
  readonly tools: readonly GatewayTool[];
  /** Profile tools the upstream does not list (by descriptor name). */
  readonly missing: readonly string[];
};

/**
 * Gateway tools for the profile's descriptors that the upstream lists. Each
 * forwards its arguments unchanged to the upstream tool named by
 * `descriptor.upstream`.
 */
export function upstreamGatewayTools(
  upstream: Upstream,
  descriptors: readonly ToolDescriptor[],
  options: { readonly timeoutMs?: number } = {},
): UpstreamTools {
  const byName = new Map(upstream.tools.map((tool) => [tool.name, tool]));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const tools: GatewayTool[] = [];
  const missing: string[] = [];
  for (const descriptor of descriptors) {
    const tool = byName.get(descriptor.upstream);
    if (tool === undefined) {
      missing.push(descriptor.name);
      continue;
    }
    tools.push({
      descriptor,
      definition: exposed(tool, descriptor),
      async execute(args: JsonObject, context): Promise<ToolExecution> {
        try {
          const result = (await upstream.client.request(
            { method: "tools/call", params: { name: descriptor.upstream, arguments: args } },
            CallToolResultSchema,
            { signal: context.signal, timeout: timeoutMs },
          )) as CallToolResult;
          const error: ToolFailure | null =
            result.isError === true
              ? {
                  provider: descriptor.integration,
                  status: null,
                  code: null,
                  message: textOf(result).slice(0, 1_000) || "The tool reported an error.",
                }
              : null;
          return { result, error, httpStatus: null, idempotencyKey: null };
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          // A write the server may have received before the request failed may have been applied.
          const failure: ToolFailure = descriptor.readOnly
            ? {
                provider: descriptor.integration,
                status: null,
                code: "upstream_error",
                message: `The ${descriptor.integration} MCP server failed: ${message}`,
              }
            : {
                provider: descriptor.integration,
                status: null,
                code: OUTCOME_UNKNOWN,
                message: outcomeUnknownMessage(
                  `The ${descriptor.integration} MCP server gave no result (${message})`,
                ),
              };
          return {
            result: errorResult(failure.message),
            error: failure,
            httpStatus: null,
            idempotencyKey: null,
          };
        }
      },
    });
  }
  return { tools, missing };
}
