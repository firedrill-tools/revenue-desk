import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { errorResult, type GatewayObserver, notify } from "./types.js";

/** Where an upstream MCP server lives. Secrets stay in this process; the Claude CLI never sees them. */
export type UpstreamConfig =
  | {
      readonly transport: "http";
      readonly url: string;
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

const STDERR_TAIL_BYTES = 4_096;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const CLIENT_INFO = { name: "revenue-desk-gateway", version: "1.0.0" };

function transportFor(config: UpstreamConfig): {
  transport: Transport;
  stderr: () => string;
} {
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

async function listAllTools(client: Client, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor }, {
      timeout: timeoutMs,
    });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined) return tools;
  }
  throw new Error("upstream tools/list did not finish within 100 pages");
}

/** Connects to an upstream MCP server and lists its tools (every page). */
export async function connectUpstream(
  config: UpstreamConfig,
  options: { readonly timeoutMs?: number } = {},
): Promise<Upstream> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { transport, stderr } = transportFor(config);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const tools = await listAllTools(client, timeoutMs);
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
    throw new Error(
      `could not connect to the ${config.transport} MCP server: ${message}${detail ? `\n${detail}` : ""}`,
    );
  }
}

export interface FilteringProxyOptions {
  /** The integration id; tools reach the model as `mcp__<name>__<tool>`. */
  readonly name: string;
  readonly upstream: Upstream;
  /** Upstream tool names to expose. Anything else is neither listed nor forwarded. */
  readonly allow: readonly string[];
  /** Per-call wall-clock limit in milliseconds, for both the SDK and the upstream request. */
  readonly timeoutMs?: number;
  /** MCP instructions to show the model. Upstream instructions are not forwarded unless passed here. */
  readonly instructions?: string;
  readonly observer?: GatewayObserver;
}

export interface FilteringProxy {
  readonly name: string;
  /** The tools the model will see, exactly as listed (raw JSON schemas). */
  readonly tools: readonly Tool[];
  /** Allowlisted names the upstream does not offer. */
  readonly missing: readonly string[];
  /**
   * A fresh in-process server for one `query()`. An instance holds one
   * transport at a time: with SDK 0.3.283, reusing it after a query ended
   * worked, but a second concurrent query() silently got no tools from it.
   */
  serverConfig(): McpSdkServerConfigWithInstance;
}

/** The upstream tool as the model sees it: its own schema, our `_meta`. */
function exposed(tool: Tool): Tool {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    // Never deferred behind tool search: the model's tool list is the same everywhere.
    _meta: { "anthropic/alwaysLoad": true },
  };
}

/**
 * Exposes an allowlisted subset of an upstream MCP server to the Claude Agent
 * SDK as an in-process (`type: 'sdk'`) server. `tools/list` returns the
 * upstream JSON schemas unchanged and `tools/call` forwards name and arguments
 * unchanged, so no schema is ever converted.
 *
 * Neither the Claude CLI nor this proxy validates arguments against the
 * upstream schema (SDK 0.3.283 forwarded out-of-range values and undeclared
 * properties); the upstream server is the validator.
 */
export function createFilteringProxy(options: FilteringProxyOptions): FilteringProxy {
  const allowed = new Set(options.allow);
  const tools = options.upstream.tools.filter((tool) => allowed.has(tool.name)).map(exposed);
  const offered = new Set(tools.map((tool) => tool.name));
  const upstreamNames = new Set(options.upstream.tools.map((tool) => tool.name));
  const missing = options.allow.filter((name) => !upstreamNames.has(name));
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    if (!offered.has(name)) return errorResult(`Tool ${name} is not available on ${options.name}.`);
    const started = performance.now();
    let result: CallToolResult;
    try {
      result = (await options.upstream.client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
        { signal, timeout: timeoutMs },
      )) as CallToolResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = errorResult(`The ${options.name} MCP server failed: ${message}`);
    }
    notify(options.observer, {
      server: options.name,
      kind: "mcp",
      tool: name,
      arguments: args,
      result,
      isError: result.isError === true,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  };

  const serverConfig = (): McpSdkServerConfigWithInstance => {
    const instance = new McpServer(
      { name: options.name, version: "1.0.0" },
      {
        capabilities: { tools: { listChanged: false } },
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      },
    );
    instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      call(request.params.name, request.params.arguments ?? {}, extra.signal),
    );
    return { type: "sdk", name: options.name, instance, timeout: timeoutMs };
  };

  return { name: options.name, tools, missing, serverConfig };
}
