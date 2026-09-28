/**
 * Local upstream MCP servers for gateway tests: a stateless Streamable HTTP
 * server and a stdio server, both serving raw JSON-schema tools the way real
 * upstreams do (no zod). Tool names and schemas here are test fixtures, not
 * captured vendor catalogs.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig } from "../../src/gateway/mcp-proxy.js";

export interface UpstreamToolFixture {
  readonly tool: Tool;
  /** The data the tool returns; it is echoed with the received arguments. */
  reply(args: Record<string, unknown>): unknown;
}

export interface UpstreamCall {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

const readOnly = { readOnlyHint: true } as const;
const write = { readOnlyHint: false, destructiveHint: false } as const;

/** A mail-like upstream (served over HTTP in the gate). */
export const MAIL_TOOLS: readonly UpstreamToolFixture[] = [
  {
    tool: {
      name: "GMAIL_FETCH_EMAILS",
      description: "Fetch emails matching a Gmail search query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query, e.g. from:ana@acme.test" },
          max_results: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          label_ids: { type: "array", items: { type: "string" } },
          include_payload: { type: "boolean", default: false },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: readOnly,
    },
    reply: () => ({
      messages: [{ id: "m_1", threadId: "t_1", from: "ana@acme.test", subject: "Charged twice?" }],
    }),
  },
  {
    tool: {
      name: "GMAIL_CREATE_EMAIL_DRAFT",
      description: "Create a draft email.",
      inputSchema: {
        type: "object",
        properties: {
          recipient_email: { type: "string", format: "email" },
          subject: { type: "string" },
          body: { type: "string" },
          thread_id: { type: "string" },
        },
        required: ["recipient_email", "subject", "body"],
        additionalProperties: false,
      },
      annotations: write,
    },
    reply: () => ({ draft_id: "r_1" }),
  },
  {
    tool: {
      name: "GMAIL_SEND_DRAFT",
      description: "Send an existing draft.",
      inputSchema: {
        type: "object",
        properties: { draft_id: { type: "string" } },
        required: ["draft_id"],
        additionalProperties: false,
      },
      annotations: write,
    },
    reply: () => ({ sent: true }),
  },
  {
    tool: {
      name: "GMAIL_DELETE_MESSAGE",
      description: "Permanently delete a message.",
      inputSchema: {
        type: "object",
        properties: { message_id: { type: "string" } },
        required: ["message_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    reply: () => ({ deleted: true }),
  },
];

/** A CRM-like upstream (served over stdio in the gate). */
export const CRM_TOOLS: readonly UpstreamToolFixture[] = [
  {
    tool: {
      name: "search_contacts",
      description: "Search CRM contacts by email or name.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          properties: { type: "array", items: { type: "string" }, uniqueItems: true },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
      annotations: readOnly,
    },
    reply: () => ({ results: [{ id: "101", email: "ana@acme.test", company: "Acme" }] }),
  },
  {
    tool: {
      name: "create_note",
      description: "Create a note on a CRM contact.",
      inputSchema: {
        type: "object",
        $defs: {
          association: {
            type: "object",
            properties: {
              object_type: { type: "string", enum: ["contact", "company", "deal"] },
              id: { type: "string", pattern: "^[0-9]+$" },
            },
            required: ["object_type", "id"],
            additionalProperties: false,
          },
        },
        properties: {
          contact_id: { type: "string", pattern: "^[0-9]+$" },
          body: { type: "string", maxLength: 65536 },
          associations: { type: "array", items: { $ref: "#/$defs/association" } },
        },
        required: ["contact_id", "body"],
        additionalProperties: false,
      },
      annotations: write,
    },
    reply: () => ({ note_id: "n_1" }),
  },
  {
    tool: {
      name: "delete_contact",
      description: "Delete a CRM contact.",
      inputSchema: {
        type: "object",
        properties: { contact_id: { type: "string" } },
        required: ["contact_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    reply: () => ({ deleted: true }),
  },
];

export const CRM_INSTRUCTIONS = "CRM test server: contact ids are numeric strings.";

export const UPSTREAM_FIXTURES = { mail: MAIL_TOOLS, crm: CRM_TOOLS } as const;
export type UpstreamFixtureName = keyof typeof UPSTREAM_FIXTURES;

/**
 * A low-level MCP server with raw JSON-schema tools. With `pageSize`,
 * `tools/list` pages through the tools with a numeric cursor.
 */
export function createUpstreamServer(options: {
  readonly name: string;
  readonly tools: readonly UpstreamToolFixture[];
  readonly onCall: (call: UpstreamCall) => void;
  readonly instructions?: string;
  readonly pageSize?: number;
  /** Throws inside the named tool, to exercise upstream failures. */
  readonly failing?: string;
}): Server {
  const server = new Server(
    { name: options.name, version: "1.0.0" },
    {
      capabilities: { tools: {} },
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    },
  );
  const size = options.pageSize ?? options.tools.length;
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const start = Number(request.params?.cursor ?? 0);
    const page = options.tools.slice(start, start + size).map((fixture) => fixture.tool);
    const next = start + size;
    return {
      tools: page,
      ...(next < options.tools.length ? { nextCursor: String(next) } : {}),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const fixture = options.tools.find((entry) => entry.tool.name === request.params.name);
    const args = request.params.arguments ?? {};
    options.onCall({ tool: request.params.name, arguments: args });
    if (fixture === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool ${request.params.name}` }],
      };
    }
    if (options.failing === request.params.name) throw new Error(`${request.params.name} exploded`);
    const data = { ...(fixture.reply(args) as object), received: args };
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });
  return server;
}

export interface HttpUpstream {
  readonly url: string;
  readonly calls: UpstreamCall[];
  /** HTTP requests refused for a missing or wrong bearer token. */
  readonly unauthorized: number;
  close(): Promise<void>;
}

/** A stateless Streamable HTTP MCP server on loopback that requires `Authorization: Bearer <token>`. */
export async function startHttpUpstream(options: {
  readonly token: string;
  readonly tools: readonly UpstreamToolFixture[];
  readonly name?: string;
  readonly instructions?: string;
  readonly pageSize?: number;
  readonly failing?: string;
}): Promise<HttpUpstream> {
  const calls: UpstreamCall[] = [];
  let unauthorized = 0;
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      unauthorized += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    const body = parts.length === 0 ? undefined : JSON.parse(Buffer.concat(parts).toString("utf8"));
    const server = createUpstreamServer({
      name: options.name ?? "http-upstream",
      tools: options.tools,
      onCall: (call) => calls.push(call),
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.failing === undefined ? {} : { failing: options.failing }),
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
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    get unauthorized() {
      return unauthorized;
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..");

/** How to launch `stdio-upstream.ts` as a child process: Node with the tsx loader. */
export function stdioUpstreamConfig(options: {
  readonly fixture: UpstreamFixtureName;
  readonly callLog: string;
  readonly instructions?: string;
}): UpstreamConfig {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return {
    transport: "stdio",
    command: process.execPath,
    args: ["--import", tsx, join(here, "stdio-upstream.ts"), options.fixture],
    env: {
      UPSTREAM_CALL_LOG: options.callLog,
      ...(options.instructions === undefined
        ? {}
        : { UPSTREAM_INSTRUCTIONS: options.instructions }),
    },
    cwd: repositoryRoot,
  };
}

/** The calls a stdio upstream appended to its JSONL log. */
export function readCallLog(path: string): UpstreamCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UpstreamCall);
}

export function appendCallLog(path: string, call: UpstreamCall): void {
  appendFileSync(path, `${JSON.stringify(call)}\n`);
}
