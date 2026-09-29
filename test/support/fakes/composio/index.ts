/**
 * A local fake of the Composio API and its session MCP endpoints
 * (COMPOSIO_BASE_URL). Test-only; loopback only. It runs Gmail and Google
 * Calendar on a local mailbox and calendar; QuickBooks and Slack are listed
 * with their captured schemas but have no local data, so a call to one
 * fails as Composio fails a toolkit with no usable connected account.
 *
 * What the real @composio/core 0.21 client does against it:
 * - `sessions.create(userId, config)`: POST /api/v3.1/tool_router/session
 *   with `x-api-key`. The reply's MCP URL is on the fake's own origin, which
 *   the SDK requires before it attaches the session credential.
 * - `session.toolkits()`: GET …/session/{id}/toolkits, the connection state
 *   per toolkit (from test/fixtures/business/composio.json; tests change it).
 * - `session.authorize(toolkit, {callbackUrl})`: POST …/session/{id}/link.
 *   The redirect URL is a local page that completes the "connection" and
 *   sends the browser back to the callback (the sandbox's Connect button).
 * Errors use Composio's envelope `{error:{message, code, slug, status,
 * request_id}}` with an `x-request-id` header.
 *
 * The session MCP endpoint (Streamable HTTP, stateless) lists exactly the
 * session's enabled slugs with the schemas captured read-only in
 * test/fixtures/surfaces/composio-direct.json, validates arguments against
 * them, and runs Gmail and Calendar ones on the local mailbox (gmail.ts) and
 * calendar (calendar.ts). Results are `{successful, data, error}`, as Composio tools
 * return; a failure is also `isError: true`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject, JsonValue } from "../../../../src/contracts/json.js";
import type { FakeClock } from "../core/clock.js";
import {
  FakeHttpServer,
  type FakeRequest,
  type FakeResponse,
  header,
  mediaType,
  type RawResponse,
  type RecordedHttpRequest,
  Router,
} from "../core/http.js";
import { IdSequence } from "../core/ids.js";
import { withDefaults } from "../core/schema.js";
import type {
  CalendarFixture,
  ComposioConnectionStatus,
  ComposioFixture,
  GmailFixture,
} from "../fixtures.js";
import { GoogleCalendar } from "./calendar.js";
import { GmailMailbox, ToolError } from "./gmail.js";

export const COMPOSIO_TOOLKIT_SLUGS = ["gmail", "googlecalendar", "quickbooks", "slack"] as const;

const TOOLKIT_NAMES: Readonly<Record<ComposioToolkitSlug, string>> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  quickbooks: "QuickBooks",
  slack: "Slack",
};

/** The toolkit a slug belongs to, by its prefix (GMAIL_, GOOGLECALENDAR_, …). */
function toolkitOfSlug(name: string): ComposioToolkitSlug | undefined {
  return COMPOSIO_TOOLKIT_SLUGS.find((slug) => name.startsWith(`${slug.toUpperCase()}_`));
}
export type ComposioToolkitSlug = (typeof COMPOSIO_TOOLKIT_SLUGS)[number];

const SURFACE_FILE = resolve(
  import.meta.dirname,
  "../../../fixtures/surfaces/composio-direct.json",
);

/** The captured direct_tools surface: every allowlisted slug with its schema. */
export function capturedComposioTools(): Readonly<Record<ComposioToolkitSlug, readonly Tool[]>> {
  const surface = JSON.parse(readFileSync(SURFACE_FILE, "utf8")) as {
    toolkits: Record<ComposioToolkitSlug, { tools: (Tool & { catalog?: unknown })[] }>;
  };
  const strip = (tools: readonly (Tool & { catalog?: unknown })[]) =>
    tools.map(({ catalog: _catalog, ...tool }) => tool as Tool);
  return {
    gmail: strip(surface.toolkits.gmail.tools),
    googlecalendar: strip(surface.toolkits.googlecalendar.tools),
    quickbooks: strip(surface.toolkits.quickbooks.tools),
    slack: strip(surface.toolkits.slack.tools),
  };
}

export interface ComposioFakeOptions {
  readonly composio: ComposioFixture;
  readonly gmail: GmailFixture;
  readonly calendar: CalendarFixture;
  readonly clock: FakeClock;
  /** The project API key the fake accepts (COMPOSIO_API_KEY). */
  readonly apiKey: string;
  readonly prefix?: string;
}

interface Session {
  readonly id: string;
  readonly userId: string;
  readonly toolkits: readonly ComposioToolkitSlug[];
  /** Enabled slugs per toolkit (the allowlist the client sent). */
  readonly enabled: Readonly<Record<ComposioToolkitSlug, readonly string[]>>;
  readonly createdAt: string;
  /** The create request body, for assertions (never contains the key). */
  readonly config: JsonObject;
}

interface Connection {
  id: string;
  status: ComposioConnectionStatus;
  readonly authConfigId: string;
}

/** A tool call through a session MCP endpoint. */
export interface ComposioToolCall {
  readonly sessionId: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly successful: boolean;
  readonly error: string | null;
}

/** A Connect link the client asked for. */
export interface ComposioLinkRequest {
  readonly sessionId: string;
  readonly toolkit: string;
  readonly callbackUrl: string | null;
  readonly redirectUrl: string;
  completed: boolean;
}

class ComposioApiError extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    message: string,
    readonly code = status * 10 + 1,
  ) {
    super(message);
  }
}

export class ComposioFake {
  readonly http: FakeHttpServer;
  readonly gmail: GmailMailbox;
  readonly calendar: GoogleCalendar;
  readonly sessions = new Map<string, Session>();
  readonly toolCalls: ComposioToolCall[] = [];
  readonly links: ComposioLinkRequest[] = [];
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly connections: Map<ComposioToolkitSlug, Connection>;
  private readonly surface = capturedComposioTools();
  private readonly ids = new IdSequence();
  private readonly clock: FakeClock;
  private sessionFailure: ComposioApiError | null = null;

  private constructor(options: ComposioFakeOptions) {
    this.clock = options.clock;
    this.apiKey = options.apiKey;
    this.userId = options.composio.userId;
    this.gmail = new GmailMailbox(options.gmail, options.clock);
    this.calendar = new GoogleCalendar(options.calendar, options.clock);
    this.connections = new Map(
      COMPOSIO_TOOLKIT_SLUGS.flatMap((slug) => {
        const connection = options.composio.connections[slug];
        return connection === undefined ? [] : [[slug, { ...connection }] as const];
      }),
    );
    const router = new Router();
    const api = (method: string, pattern: string, handler: (request: FakeRequest) => JsonObject) =>
      router.add(method, pattern, (request) => this.dispatch(request, handler));
    api("POST", "/api/v3.1/tool_router/session", (request) => this.createSession(request));
    api("GET", "/api/v3.1/tool_router/session/:id", (request) =>
      this.sessionJson(this.session(request.params.id)),
    );
    api("GET", "/api/v3.1/tool_router/session/:id/toolkits", (request) => this.toolkits(request));
    api("POST", "/api/v3.1/tool_router/session/:id/link", (request) => this.link(request));
    router.add("POST", "/tool_router/:id/mcp", (request) => this.mcpRoute(request));
    for (const method of ["GET", "DELETE"]) {
      router.add(method, "/tool_router/:id/mcp", () => ({
        status: 405,
        headers: { allow: "POST" },
        body: { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      }));
    }
    router.add("GET", "/fake-connect/:id", (request) => this.completeLink(request));
    this.http = new FakeHttpServer({
      name: "composio",
      clock: options.clock,
      router,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      notFound: (request) =>
        this.errorReply(
          new ComposioApiError(
            404,
            "NotFound",
            `Route ${request.method} ${request.path} not found`,
          ),
        ),
    });
  }

  static async start(options: ComposioFakeOptions): Promise<ComposioFake> {
    const fake = new ComposioFake(options);
    await fake.http.start();
    return fake;
  }

  /** COMPOSIO_BASE_URL. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get requests(): readonly RecordedHttpRequest[] {
    return this.http.requests;
  }

  close(): Promise<void> {
    return this.http.close();
  }

  // --- Test controls ------------------------------------------------------------

  /** Sets a toolkit's connected-account status; null removes the connection (needs_auth). */
  setConnection(toolkit: ComposioToolkitSlug, status: ComposioConnectionStatus | null): void {
    const connection = this.connections.get(toolkit);
    if (connection === undefined) return;
    if (status === null) this.connections.delete(toolkit);
    else connection.status = status;
  }

  /** Makes session creation fail (a Composio outage or a refused project), until cleared with null. */
  failSessions(
    failure: { readonly status: number; readonly slug: string; readonly message: string } | null,
  ): void {
    this.sessionFailure =
      failure === null ? null : new ComposioApiError(failure.status, failure.slug, failure.message);
  }

  // --- API ------------------------------------------------------------------------

  private dispatch(
    request: FakeRequest,
    handler: (request: FakeRequest) => JsonObject,
  ): FakeResponse {
    try {
      if (header(request, "x-api-key") !== this.apiKey) {
        throw new ComposioApiError(
          401,
          "Auth_InvalidApiKey",
          "Invalid API key. Check COMPOSIO_API_KEY.",
          10401,
        );
      }
      return { status: 200, headers: { "x-request-id": randomUUID() }, body: handler(request) };
    } catch (error) {
      if (error instanceof ComposioApiError) return this.errorReply(error);
      throw error;
    }
  }

  private errorReply(error: ComposioApiError): FakeResponse {
    const requestId = randomUUID();
    return {
      status: error.status,
      headers: { "x-request-id": requestId },
      body: {
        error: {
          message: error.message,
          code: error.code,
          slug: error.slug,
          status: error.status,
          request_id: requestId,
        },
      },
    };
  }

  private createSession(request: FakeRequest): JsonObject {
    if (this.sessionFailure !== null) throw this.sessionFailure;
    const body = jsonObject(request);
    const userId = body.user_id;
    if (typeof userId !== "string" || userId === "") {
      throw new ComposioApiError(400, "Validation_Failed", "user_id is required", 10400);
    }
    const toolkitsParam = body.toolkits as JsonObject | JsonValue[] | undefined;
    const requested = Array.isArray(toolkitsParam)
      ? toolkitsParam
      : (((toolkitsParam as JsonObject | undefined)?.enable as JsonValue[] | undefined) ?? []);
    const toolkits = requested.map(String);
    for (const toolkit of toolkits) {
      if (!COMPOSIO_TOOLKIT_SLUGS.includes(toolkit as ComposioToolkitSlug)) {
        throw new ComposioApiError(
          400,
          "Toolkit_NotFound",
          `Toolkit ${toolkit} is not available in this fake`,
          10404,
        );
      }
    }
    const tools = (body.tools ?? {}) as JsonObject;
    const enabled = {} as Record<ComposioToolkitSlug, string[]>;
    for (const slug of COMPOSIO_TOOLKIT_SLUGS) {
      const entry = tools[slug] as JsonObject | undefined;
      const list = Array.isArray(entry?.enable)
        ? entry.enable.map(String)
        : this.surface[slug].map((tool) => tool.name);
      const known = new Set(this.surface[slug].map((tool) => tool.name));
      const unknown = list.find((name) => !known.has(name));
      if (unknown !== undefined) {
        throw new ComposioApiError(
          400,
          "Tool_NotFound",
          `Tool ${unknown} does not exist in toolkit ${slug}`,
          10404,
        );
      }
      enabled[slug] = toolkits.includes(slug) ? list : [];
    }
    const id = this.ids.next("trs_");
    const session: Session = {
      id,
      userId,
      toolkits: toolkits as ComposioToolkitSlug[],
      enabled,
      createdAt: this.clock.now().toISOString(),
      config: body,
    };
    this.sessions.set(id, session);
    return this.sessionJson(session);
  }

  private sessionJson(session: Session): JsonObject {
    return {
      session_id: session.id,
      mcp: { type: "http", url: `${this.baseUrl}/tool_router/${session.id}/mcp` },
      tool_router_tools: COMPOSIO_TOOLKIT_SLUGS.flatMap((slug) => [...session.enabled[slug]]),
      config: {
        user_id: session.userId,
        toolkits: { enable: [...session.toolkits] },
        tools: Object.fromEntries(
          COMPOSIO_TOOLKIT_SLUGS.map((slug) => [slug, { enable: [...session.enabled[slug]] }]),
        ),
      },
    };
  }

  private session(id: string | undefined): Session {
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (session === undefined)
      throw new ComposioApiError(
        404,
        "ToolRouter_SessionNotFound",
        `Session ${id ?? ""} not found`,
        10404,
      );
    return session;
  }

  private toolkits(request: FakeRequest): JsonObject {
    const session = this.session(request.params.id);
    const filter = (request.query.get("toolkits") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const slugs = (filter.length > 0 ? filter : session.toolkits).filter(
      (slug): slug is ComposioToolkitSlug => session.toolkits.includes(slug as ComposioToolkitSlug),
    );
    return {
      items: slugs.map((slug) => {
        const connection = session.userId === this.userId ? this.connections.get(slug) : undefined;
        return {
          slug,
          name: TOOLKIT_NAMES[slug],
          is_no_auth: false,
          connected_account:
            connection === undefined
              ? null
              : {
                  id: connection.id,
                  status: connection.status,
                  auth_config: {
                    id: connection.authConfigId,
                    auth_scheme: "OAUTH2",
                    is_composio_managed: true,
                  },
                },
        };
      }),
      next_cursor: null,
      total_pages: 1,
    };
  }

  private link(request: FakeRequest): JsonObject {
    const session = this.session(request.params.id);
    const body = jsonObject(request);
    const toolkit = String(body.toolkit ?? "");
    if (!session.toolkits.includes(toolkit as ComposioToolkitSlug)) {
      throw new ComposioApiError(
        400,
        "Toolkit_NotInSession",
        `Toolkit ${toolkit} is not in session ${session.id}`,
        10400,
      );
    }
    const linkId = this.ids.next("lnk_");
    const redirectUrl = `${this.baseUrl}/fake-connect/${linkId}`;
    this.links.push({
      sessionId: session.id,
      toolkit,
      callbackUrl: typeof body.callback_url === "string" ? body.callback_url : null,
      redirectUrl,
      completed: false,
    });
    return {
      connected_account_id: `ca_${linkId.slice(4)}`,
      redirect_url: redirectUrl,
      link_token: linkId,
    };
  }

  /** The hosted sign-in, simulated: the connection becomes ACTIVE and the browser goes back. */
  private completeLink(request: FakeRequest): FakeResponse {
    const link = this.links.find((entry) =>
      entry.redirectUrl.endsWith(`/fake-connect/${request.params.id ?? ""}`),
    );
    if (link === undefined) return { status: 404, body: "Unknown connection link." };
    link.completed = true;
    const slug = link.toolkit as ComposioToolkitSlug;
    const existing = this.connections.get(slug);
    if (existing === undefined) {
      this.connections.set(slug, {
        id: `ca_${slug}_rd`,
        status: "ACTIVE",
        authConfigId: `ac_${slug}_rd`,
      });
    } else {
      existing.status = "ACTIVE";
    }
    const back =
      link.callbackUrl !== null &&
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(link.callbackUrl);
    if (back && link.callbackUrl !== null)
      return { status: 302, headers: { location: link.callbackUrl }, body: "" };
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: `<!doctype html><title>Local sandbox</title><p>Local sandbox — no real services. ${link.toolkit} is now connected for the fictional Kestrel Analytics account. You can close this tab.</p>`,
    };
  }

  // --- Session MCP ------------------------------------------------------------------

  private mcpRoute(request: FakeRequest): RawResponse | FakeResponse {
    if (header(request, "x-api-key") !== this.apiKey) {
      return {
        status: 401,
        body: { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
      };
    }
    const session = this.sessions.get(request.params.id ?? "");
    if (session === undefined) {
      return {
        status: 404,
        body: { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
      };
    }
    const tools = COMPOSIO_TOOLKIT_SLUGS.flatMap((slug) =>
      this.surface[slug].filter((tool) => session.enabled[slug].includes(tool.name)),
    );
    return {
      raw: async (incoming, response, body) => {
        const server = new Server(
          { name: "mcp-typescript server on vercel", version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
        server.setRequestHandler(CallToolRequestSchema, (call) => {
          const tool = tools.find((entry) => entry.name === call.params.name);
          if (tool === undefined)
            throw new McpError(ErrorCode.InvalidParams, `Tool ${call.params.name} not found`);
          return this.execute(session, tool, call.params.arguments ?? {});
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(
          incoming,
          response,
          body === "" ? undefined : (JSON.parse(body) as unknown),
        );
      },
    };
  }

  private execute(session: Session, tool: Tool, args: Record<string, unknown>): CallToolResult {
    const record = (successful: boolean, error: string | null) =>
      this.toolCalls.push({
        sessionId: session.id,
        tool: tool.name,
        arguments: args,
        successful,
        error,
      });
    const fail = (message: string): CallToolResult => {
      record(false, message);
      return {
        isError: true,
        content: [
          { type: "text", text: JSON.stringify({ successful: false, data: {}, error: message }) },
        ],
      };
    };
    const toolkit = toolkitOfSlug(tool.name);
    if (toolkit === undefined) return fail(`Tool ${tool.name} belongs to no toolkit of this fake.`);
    const connection = session.userId === this.userId ? this.connections.get(toolkit) : undefined;
    if (connection === undefined)
      return fail(`No connected account found for user ${session.userId} and toolkit ${toolkit}.`);
    if (connection.status !== "ACTIVE") {
      return fail(
        `The ${toolkit} connected account ${connection.id} is ${connection.status}; reconnect it to continue.`,
      );
    }
    const checked = withDefaults(tool.inputSchema, args);
    if (!checked.ok) return fail(`Invalid request data provided: ${checked.issues.join("; ")}`);
    const input = checked.value as Readonly<Record<string, JsonValue>>;
    try {
      const data = this.run(tool.name, input);
      record(true, null);
      return {
        content: [{ type: "text", text: JSON.stringify({ successful: true, data, error: null }) }],
      };
    } catch (error) {
      if (error instanceof ToolError) return fail(error.message);
      throw error;
    }
  }

  private run(name: string, args: Readonly<Record<string, JsonValue>>): JsonObject {
    switch (name) {
      case "GMAIL_FETCH_EMAILS":
        return this.gmail.fetchEmails(args);
      case "GMAIL_FETCH_MESSAGE_BY_THREAD_ID":
        return this.gmail.fetchThread(args);
      case "GMAIL_LIST_THREADS":
        return this.gmail.listThreads(args);
      case "GMAIL_LIST_LABELS":
        return this.gmail.listLabels(args);
      case "GMAIL_CREATE_EMAIL_DRAFT":
        return this.gmail.createDraft(args);
      case "GMAIL_ADD_LABEL_TO_EMAIL":
        return this.gmail.modifyLabels(args);
      case "GMAIL_SEND_DRAFT":
        return this.gmail.sendDraft(args);
      case "GMAIL_REPLY_TO_THREAD":
        return this.gmail.reply(args);
      case "GOOGLECALENDAR_EVENTS_LIST":
        return this.calendar.eventsList(args);
      case "GOOGLECALENDAR_FIND_EVENT":
        return this.calendar.findEvent(args);
      case "GOOGLECALENDAR_FIND_FREE_SLOTS":
        return this.calendar.findFreeSlots(args);
      case "GOOGLECALENDAR_CREATE_EVENT":
        return this.calendar.createEvent(args);
      case "GOOGLECALENDAR_UPDATE_EVENT":
        return this.calendar.updateEvent(args);
      default:
        throw new ToolError(`Tool ${name} is not implemented by the local fake.`);
    }
  }
}

function jsonObject(request: FakeRequest): JsonObject {
  if (mediaType(request) !== "application/json") {
    throw new ComposioApiError(
      415,
      "Validation_UnsupportedMediaType",
      "Content-Type must be application/json",
      10415,
    );
  }
  try {
    const parsed: unknown = JSON.parse(request.rawBody === "" ? "{}" : request.rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as JsonObject;
  } catch {
    throw new ComposioApiError(
      400,
      "Validation_InvalidJson",
      "The request body is not a JSON object",
      10400,
    );
  }
}
