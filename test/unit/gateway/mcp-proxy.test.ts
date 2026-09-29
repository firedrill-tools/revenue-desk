// The gateway's MCP client (connectUpstream) over its two real transports,
// Streamable HTTP and stdio, and the proxy tools it builds. The upstreams are
// minimal MCP servers local to this file: a loopback HTTP one that checks a
// bearer token, pages tools/list and echoes calls, and a stdio child started
// from an inline script. They stand for "an MCP server", not for any vendor.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { sdkToolName, type ToolDescriptor } from "../../../src/contracts/integration.js";
import {
  connectUpstream,
  type Upstream,
  upstreamGatewayTools,
} from "../../../src/gateway/mcp-proxy.js";
import type { ExecutionContext } from "../../../src/gateway/types.js";
import { textOf } from "../../helpers/mcp-client.js";
import { REPOSITORY_ROOT } from "../../support/repository.js";

const TOKEN = "unit-upstream-token";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MAIL_TOOLS: readonly Tool[] = [
  {
    name: "GMAIL_FETCH_EMAILS",
    description: "Fetch emails matching a search query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 50 },
        label_ids: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "GMAIL_SEND_DRAFT",
    description: "Send an existing draft.",
    inputSchema: {
      type: "object",
      properties: { draft_id: { type: "string" } },
      required: ["draft_id"],
    },
    annotations: { readOnlyHint: true },
  },
];

type Call = { readonly tool: string; readonly arguments: Record<string, unknown> };

/** A stateless Streamable HTTP MCP server on loopback that requires `Bearer TOKEN`. */
async function startHttpMcp(options: { pageSize?: number; failing?: string } = {}) {
  const calls: Call[] = [];
  let unauthorized = 0;
  const size = options.pageSize ?? MAIL_TOOLS.length;
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      unauthorized += 1;
      response.writeHead(401, { "content-type": "application/json" }).end("{}");
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    const body = parts.length === 0 ? undefined : JSON.parse(Buffer.concat(parts).toString("utf8"));
    const server = new Server(
      { name: "http-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, (list) => {
      const start = Number(list.params?.cursor ?? 0);
      const next = start + size;
      return {
        tools: MAIL_TOOLS.slice(start, next),
        ...(next < MAIL_TOOLS.length ? { nextCursor: String(next) } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, (call): CallToolResult => {
      const args = call.params.arguments ?? {};
      calls.push({ tool: call.params.name, arguments: args });
      if (options.failing === call.params.name) throw new Error(`${call.params.name} exploded`);
      return { content: [{ type: "text", text: JSON.stringify({ received: args }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  return {
    url,
    calls,
    get unauthorized() {
      return unauthorized;
    },
  };
}

/** A stdio MCP server: one tool, instructions from its environment, calls appended to a log. */
const STDIO_SERVER = `
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "stdio-test", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: process.env.UPSTREAM_INSTRUCTIONS },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: "search_contacts", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, (call) => {
  const line = JSON.stringify({ tool: call.params.name, arguments: call.params.arguments ?? {} });
  appendFileSync(process.env.UPSTREAM_CALL_LOG, line + "\\n");
  return { content: [{ type: "text", text: "{}" }] };
});
await server.connect(new StdioServerTransport());
`;

function descriptor(name: string, upstream = name, readOnly = true): ToolDescriptor {
  return {
    name,
    upstream,
    operation: "gmail.messages.list",
    title: name,
    baseClass: readOnly ? "read" : "outbound",
    readOnly,
    integration: "gmail",
    connectionKind: "composio",
    sdkName: sdkToolName("gmail", name),
  };
}

const context = (): ExecutionContext => ({
  runId: "run_1",
  toolUseId: "toolu_1",
  idempotencyKey: "k",
  signal: new AbortController().signal,
});

async function mailUpstream(options: { pageSize?: number; failing?: string } = {}) {
  const upstream = await startHttpMcp(options);
  const connection = await connectUpstream({
    transport: "http",
    url: upstream.url,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  cleanups.push(() => connection.close());
  return { upstream, connection };
}

describe("connectUpstream", () => {
  it("lists every page of an HTTP upstream's tools with its bearer header", async () => {
    const { upstream, connection } = await mailUpstream({ pageSize: 1 });
    expect(connection.tools.map((tool) => tool.name)).toEqual(MAIL_TOOLS.map((tool) => tool.name));
    expect(upstream.unauthorized).toBe(0);
  });

  it("fails clearly when the HTTP upstream refuses the token, keeping the HTTP status", async () => {
    const upstream = await startHttpMcp();
    const failure = await connectUpstream({
      transport: "http",
      url: upstream.url,
      headers: { Authorization: "Bearer no" },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not connect to the http MCP server/);
    // The transport's error stays reachable, with its status (401).
    expect(JSON.stringify((failure as Error).cause, ["code"])).toContain("401");
    expect(upstream.unauthorized).toBeGreaterThan(0);
  });

  it("gives up when its signal aborts", async () => {
    const { upstream } = await mailUpstream();
    await expect(
      connectUpstream(
        { transport: "http", url: upstream.url, headers: { Authorization: `Bearer ${TOKEN}` } },
        { signal: AbortSignal.abort("user") },
      ),
    ).rejects.toThrow(/could not connect/);
  });

  it("starts a stdio upstream and reads its instructions", { timeout: 20_000 }, async () => {
    const state = mkdtempSync(join(tmpdir(), "revenue-desk-proxy-"));
    cleanups.push(() => rmSync(state, { recursive: true, force: true }));
    const log = join(state, "calls.jsonl");
    const instructions = "Contact ids are numeric strings.";
    const connection = await connectUpstream({
      transport: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "-e", STDIO_SERVER],
      env: { UPSTREAM_CALL_LOG: log, UPSTREAM_INSTRUCTIONS: instructions },
      cwd: REPOSITORY_ROOT,
    });
    cleanups.push(() => connection.close());
    expect(connection.instructions).toBe(instructions);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["search_contacts"]);
    const { tools } = upstreamGatewayTools(connection, [
      { ...descriptor("search_contacts"), integration: "hubspot", connectionKind: "mcp" },
    ]);
    await tools[0]?.execute({ query: "ana" }, context());
    const logged = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(logged).toEqual([{ tool: "search_contacts", arguments: { query: "ana" } }]);
  });

  it("reports a stdio upstream that exits, with its stderr", { timeout: 20_000 }, async () => {
    await expect(
      connectUpstream({
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "process.stderr.write('boom: missing token\\n'); process.exit(3)"],
      }),
    ).rejects.toThrow(/could not connect to the stdio MCP server[\s\S]*boom: missing token/);
  });
});

describe("upstreamGatewayTools", () => {
  it("offers only the profile's tools, with the upstream schema byte for byte", async () => {
    const { connection } = await mailUpstream();
    const { tools, missing } = upstreamGatewayTools(connection, [
      descriptor("GMAIL_FETCH_EMAILS"),
      descriptor("GMAIL_SEND_DRAFT", "GMAIL_SEND_DRAFT", false),
      descriptor("GMAIL_NOT_OFFERED"),
    ]);
    expect(missing).toEqual(["GMAIL_NOT_OFFERED"]);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_DRAFT",
    ]);
    for (const tool of tools) {
      const upstream = MAIL_TOOLS.find((entry) => entry.name === tool.definition.name);
      expect(tool.definition.inputSchema).toEqual(upstream?.inputSchema);
      expect(tool.definition.description).toBe(upstream?.description);
      expect(tool.definition._meta).toEqual({ "anthropic/alwaysLoad": true });
      expect(tool.definition).not.toHaveProperty("outputSchema");
    }
    // The profile, not the upstream, decides the read-only hint.
    expect(tools[1]?.definition.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("forwards the arguments unchanged under the upstream name", async () => {
    const { upstream, connection } = await mailUpstream();
    const { tools } = upstreamGatewayTools(connection, [
      descriptor("fetch_mail", "GMAIL_FETCH_EMAILS"),
    ]);
    const args = { query: "from:ana@acme.test", max_results: 5, label_ids: ["INBOX"] };
    const execution = await tools[0]?.execute(args, context());
    expect(upstream.calls).toEqual([{ tool: "GMAIL_FETCH_EMAILS", arguments: args }]);
    expect(tools[0]?.definition.name).toBe("fetch_mail");
    expect(execution?.error).toBeNull();
    expect(JSON.parse(textOf(execution?.result ?? { content: [] }))).toMatchObject({
      received: args,
    });
  });

  it("turns an upstream failure into an error result and a normalised failure", async () => {
    const { connection } = await mailUpstream({ failing: "GMAIL_SEND_DRAFT" });
    const { tools } = upstreamGatewayTools(connection, [
      descriptor("GMAIL_SEND_DRAFT", "GMAIL_SEND_DRAFT", false),
    ]);
    const execution = await tools[0]?.execute({ draft_id: "r_1" }, context());
    expect(execution?.result.isError).toBe(true);
    expect(execution?.error).toMatchObject({ provider: "gmail", status: null });
    expect(execution?.error?.message).toMatch(/GMAIL_SEND_DRAFT exploded/);
  });

  it("reports a tool result the upstream marked as an error", async () => {
    const fixture = MAIL_TOOLS[0];
    if (fixture === undefined) throw new Error("tool missing");
    const stub = {
      client: {
        request: async () => ({ isError: true, content: [{ type: "text", text: "not found" }] }),
      },
      tools: [fixture],
      instructions: undefined,
      stderrTail: () => "",
      close: async () => {},
    } as unknown as Upstream;
    const { tools } = upstreamGatewayTools(stub, [descriptor("GMAIL_FETCH_EMAILS")]);
    const execution = await tools[0]?.execute({ query: "x" }, context());
    expect(execution?.error).toEqual({
      provider: "gmail",
      status: null,
      code: null,
      message: "not found",
    });
  });

  it("reports a closed upstream as an upstream_error", async () => {
    const { connection } = await mailUpstream();
    const { tools } = upstreamGatewayTools(connection, [descriptor("GMAIL_FETCH_EMAILS")]);
    await connection.close();
    const execution = await tools[0]?.execute({ query: "x" }, context());
    expect(execution?.error?.code).toBe("upstream_error");
    expect(execution?.result.isError).toBe(true);
  });
});
