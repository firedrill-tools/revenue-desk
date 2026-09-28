/**
 * The HubSpot fake: a local HubSpot CRM REST API (crm.ts) plus a Streamable
 * HTTP MCP endpoint, loaded from test/fixtures/business/hubspot.json.
 * Test-only.
 *
 * Both HubSpot connection modes of Revenue Desk run against it:
 * - stdio (the product default): the product launches the pinned
 *   `@hubspot/mcp-server` 0.4.0 itself with HUBSPOT_ACCESS_TOKEN and
 *   HUBSPOT_API_BASE_URL = this fake's `baseUrl`, so the real vendor code
 *   serves every tool and calls this REST API (see `stdioEnv`).
 * - Streamable HTTP (HUBSPOT_MCP_URL = `mcpUrl`): the fake serves the 10
 *   tools of Revenue Desk's hubspot-mcp-0.4 profile. Each call is forwarded
 *   to a private instance of the same pinned vendor server (launched with
 *   src/integrations/hubspot/launch.ts, network denied outside loopback),
 *   so tool schemas and results are byte-for-byte the vendor's.
 *
 * REST contract points: Bearer token (401 INVALID_AUTHENTICATION), JSON
 * bodies, the `{status:"error", message, correlationId, category}` envelope,
 * property validation (PROPERTY_DOESNT_EXIST, READ_ONLY_VALUE,
 * INVALID_OPTION, required hs_timestamp), 207 multi-status batches, v4
 * associations with paired inverse types, and `after` paging.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject, JsonValue } from "../../../../src/contracts/json.js";
import { buildHubSpotStdioLaunch } from "../../../../src/integrations/hubspot/launch.js";
import type { FakeClock } from "../core/clock.js";
import {
  bearerToken,
  FakeHttpServer,
  type FakeRequest,
  type FakeResponse,
  type FaultHandle,
  mediaType,
  type RawResponse,
  type RecordedHttpRequest,
  Router,
} from "../core/http.js";
import type { HubSpotFixture } from "../fixtures.js";
import { HubSpotApiError, HubSpotCrm, type HubSpotObjectType, type SearchRequest } from "./crm.js";

/**
 * The tools of the hubspot-mcp-0.4 profile (docs/ARCHITECTURE.md §2): 10 of
 * the 21 tools of @hubspot/mcp-server 0.4.0.
 */
export const HUBSPOT_PROFILE_TOOL_NAMES = [
  "hubspot-get-user-details",
  "hubspot-list-objects",
  "hubspot-search-objects",
  "hubspot-batch-read-objects",
  "hubspot-list-associations",
  "hubspot-get-association-definitions",
  "hubspot-list-properties",
  "hubspot-get-property",
  "hubspot-batch-create-objects",
  "hubspot-batch-update-objects",
] as const;

const DENY_NETWORK = pathToFileURL(resolve(import.meta.dirname, "../../deny-network.mjs")).href;

export interface HubSpotFakeOptions {
  readonly fixture: HubSpotFixture;
  readonly clock: FakeClock;
  /** The private-app token the REST API accepts (HUBSPOT_ACCESS_TOKEN). */
  readonly accessToken: string;
  /** The bearer token the MCP endpoint accepts (HUBSPOT_MCP_TOKEN). */
  readonly mcpToken: string;
  readonly prefix?: string;
  /**
   * Start the Streamable HTTP MCP endpoint (launches the vendor server).
   * Default false: only the REST API runs.
   */
  readonly mcp?: boolean;
}

/** One MCP tools/call the HTTP endpoint served. */
export interface HubSpotMcpCall {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export class HubSpotFake {
  readonly http: FakeHttpServer;
  readonly crm: HubSpotCrm;
  readonly mcpCalls: HubSpotMcpCall[] = [];
  private readonly accessToken: string;
  private readonly mcpToken: string;
  private vendor: {
    readonly client: Client;
    readonly tools: readonly Tool[];
    readonly stderr: () => string;
  } | null = null;
  private mcpAvailable = true;

  private constructor(options: HubSpotFakeOptions) {
    this.crm = new HubSpotCrm(options.fixture, options.clock);
    this.accessToken = options.accessToken;
    this.mcpToken = options.mcpToken;
    const router = new Router();
    const rest = (
      method: string,
      pattern: string,
      handler: (request: FakeRequest) => FakeResponse,
    ) => router.add(method, pattern, (request) => this.dispatch(request, handler));

    rest("POST", "/oauth/v2/private-apps/get/access-token-info", (request) => {
      const body = jsonBody(request);
      if (body.tokenKey !== this.accessToken) {
        throw new HubSpotApiError(
          400,
          "VALIDATION_ERROR",
          "The token key is not a valid private app access token.",
        );
      }
      return ok({
        userId: this.crm.token.userId,
        hubId: this.crm.portal.hubId,
        appId: this.crm.token.appId,
        scopes: [...this.crm.token.scopes],
      });
    });
    rest("GET", "/account-info/v3/details", () =>
      ok({
        portalId: this.crm.portal.hubId,
        accountType: this.crm.portal.accountType,
        timeZone: this.crm.portal.timeZone,
        companyCurrency: this.crm.portal.companyCurrency,
        additionalCurrencies: [],
        utcOffset: this.crm.portal.utcOffset,
        utcOffsetMilliseconds: this.crm.portal.utcOffsetMilliseconds,
        uiDomain: this.crm.portal.uiDomain,
        dataHostingLocation: this.crm.portal.dataHostingLocation,
      }),
    );
    rest("GET", "/crm/v3/owners", () =>
      ok({ results: this.crm.owners.map((owner) => this.crm.owner(owner.id, null)) }),
    );
    rest("GET", "/crm/v3/owners/:id", (request) =>
      ok(this.crm.owner(request.params.id ?? "", request.query.get("idProperty"))),
    );
    rest("GET", "/crm/v3/objects/:type", (request) => {
      const limit = request.query.get("limit");
      const after = request.query.get("after");
      return ok(
        this.crm.list(this.crm.objectType(request.params.type ?? ""), {
          ...(limit === null ? {} : { limit: Number(limit) }),
          ...(after === null ? {} : { after }),
          properties: csv(request.query.get("properties")),
          associations: csv(request.query.get("associations")),
        }),
      );
    });
    rest("GET", "/crm/v3/objects/:type/:id", (request) =>
      ok(
        this.crm.get(
          this.crm.objectType(request.params.type ?? ""),
          request.params.id ?? "",
          csv(request.query.get("properties")),
        ),
      ),
    );
    rest("POST", "/crm/v3/objects/:type/search", (request) =>
      ok(
        this.crm.search(
          this.crm.objectType(request.params.type ?? ""),
          jsonBody(request) as SearchRequest,
        ),
      ),
    );
    rest("POST", "/crm/v3/objects/:type/batch/read", (request) => {
      const body = jsonBody(request);
      const reply = this.crm.batchRead(this.crm.objectType(request.params.type ?? ""), {
        inputs: inputsOf(body).map((input) => ({ id: String(input.id) })),
        ...(Array.isArray(body.properties) ? { properties: body.properties.map(String) } : {}),
        ...(Array.isArray(body.propertiesWithHistory)
          ? { propertiesWithHistory: body.propertiesWithHistory.map(String) }
          : {}),
      });
      return { status: reply.status, body: reply.body };
    });
    rest("POST", "/crm/v3/objects/:type/batch/create", (request) => {
      const body = jsonBody(request);
      return {
        status: 201,
        body: this.crm.batchCreate(
          this.crm.objectType(request.params.type ?? ""),
          inputsOf(body).map((input) => ({
            properties: objectOf(input.properties, "properties"),
            ...(Array.isArray(input.associations)
              ? {
                  associations: input.associations.map((association) => {
                    const entry = objectOf(association, "associations");
                    const to = objectOf(entry.to, "associations.to");
                    const types = Array.isArray(entry.types) ? entry.types : [];
                    return {
                      to: { id: String(to.id) },
                      types: types.map((type) => {
                        const value = objectOf(type, "associations.types");
                        return {
                          associationCategory: String(value.associationCategory),
                          associationTypeId: Number(value.associationTypeId),
                        };
                      }),
                    };
                  }),
                }
              : {}),
          })),
        ),
      };
    });
    rest("POST", "/crm/v3/objects/:type/batch/update", (request) => {
      const body = jsonBody(request);
      const reply = this.crm.batchUpdate(
        this.crm.objectType(request.params.type ?? ""),
        inputsOf(body).map((input) => ({
          id: String(input.id),
          properties: objectOf(input.properties, "properties"),
        })),
      );
      return { status: reply.status, body: reply.body };
    });
    rest("GET", "/crm/v4/objects/:type/:id/associations/:toType", (request) =>
      ok(
        this.crm.associationsOf(
          this.crm.objectType(request.params.type ?? ""),
          request.params.id ?? "",
          this.crm.objectType(request.params.toType ?? ""),
          request.query.get("after") ?? undefined,
        ),
      ),
    );
    rest("GET", "/crm/v4/associations/:from/:to/labels", (request) =>
      ok(
        this.crm.associationLabels(
          this.crm.objectType(request.params.from ?? ""),
          this.crm.objectType(request.params.to ?? ""),
        ),
      ),
    );
    rest("GET", "/crm/v3/properties/:type", (request) =>
      ok(this.crm.listProperties(this.crm.objectType(request.params.type ?? ""))),
    );
    rest("GET", "/crm/v3/properties/:type/:name", (request) =>
      ok(
        this.crm.property(
          this.crm.objectType(request.params.type ?? ""),
          request.params.name ?? "",
        ),
      ),
    );
    router.add("POST", "/mcp", () => this.mcpRoute());
    for (const method of ["GET", "DELETE"]) {
      router.add(method, "/mcp", () => ({
        status: 405,
        headers: { allow: "POST" },
        body: { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      }));
    }

    this.http = new FakeHttpServer({
      name: "hubspot",
      clock: options.clock,
      router,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      notFound: (request) =>
        envelope(
          new HubSpotApiError(
            404,
            "OBJECT_NOT_FOUND",
            `No route for ${request.method} ${request.path}`,
          ),
        ),
    });
  }

  static async start(options: HubSpotFakeOptions): Promise<HubSpotFake> {
    const fake = new HubSpotFake(options);
    await fake.http.start();
    if (options.mcp === true) {
      try {
        await fake.startVendor();
      } catch (error) {
        await fake.http.close();
        throw error;
      }
    }
    return fake;
  }

  /** HUBSPOT_API_BASE_URL for the product's stdio mode. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** HUBSPOT_MCP_URL for the product's Streamable HTTP mode. */
  get mcpUrl(): string {
    if (this.vendor === null) throw new Error("The HubSpot fake was started without mcp: true");
    return `${this.http.baseUrl}/mcp`;
  }

  get requests(): readonly RecordedHttpRequest[] {
    return this.http.requests;
  }

  /** The tools the HTTP MCP endpoint lists (the profile's, with vendor schemas). */
  get mcpTools(): readonly Tool[] {
    return this.vendor?.tools ?? [];
  }

  /** Makes the MCP endpoint answer 503, as a server that is down at start. */
  setMcpAvailable(available: boolean): void {
    this.mcpAvailable = available;
  }

  /** REST requests that changed CRM data (batch create and update), in order. */
  writes(): RecordedHttpRequest[] {
    return this.http.requests.filter(
      (entry) => entry.method === "POST" && /\/batch\/(create|update)$/.test(entry.path),
    );
  }

  async close(): Promise<void> {
    if (this.vendor !== null) {
      await this.vendor.client.close().catch(() => {});
      this.vendor = null;
    }
    await this.http.close();
  }

  readonly faults = {
    /** 429 RATE_LIMIT (secondly) for matching REST requests. */
    rateLimit: (
      path: string | RegExp,
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "hubspot-429-rate-limit",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: {
          status: 429,
          body: {
            status: "error",
            message: "You have reached your secondly limit.",
            errorType: "RATE_LIMIT",
            correlationId: randomUUID(),
            policyName: "SECONDLY",
          },
        },
      }),
    /** 500 INTERNAL_ERROR for matching REST requests. */
    serverError: (
      path: string | RegExp,
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "hubspot-500",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: envelope(new HubSpotApiError(500, "INTERNAL_ERROR", "internal error")),
      }),
  };

  /** The env the product's stdio mode needs to run the vendor server against this fake. */
  stdioEnv(): { readonly HUBSPOT_ACCESS_TOKEN: string; readonly HUBSPOT_API_BASE_URL: string } {
    return { HUBSPOT_ACCESS_TOKEN: this.accessToken, HUBSPOT_API_BASE_URL: this.baseUrl };
  }

  // --- REST ---------------------------------------------------------------------

  private dispatch(
    request: FakeRequest,
    handler: (request: FakeRequest) => FakeResponse,
  ): FakeResponse {
    if (bearerToken(request) !== this.accessToken) {
      return envelope(
        new HubSpotApiError(
          401,
          "INVALID_AUTHENTICATION",
          "Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview",
        ),
      );
    }
    try {
      const reply = handler(request);
      return { ...reply, headers: { "x-hubspot-correlation-id": randomUUID(), ...reply.headers } };
    } catch (error) {
      if (error instanceof HubSpotApiError) return envelope(error);
      throw error;
    }
  }

  // --- MCP ----------------------------------------------------------------------

  private async startVendor(): Promise<void> {
    const launch = buildHubSpotStdioLaunch({
      accessToken: this.accessToken,
      apiBaseUrl: this.baseUrl,
    });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      env: { ...launch.env, NODE_OPTIONS: `--import=${DENY_NETWORK}` },
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8_192);
    });
    const client = new Client({ name: "revenue-desk-hubspot-fake", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: 30_000 });
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const tools = HUBSPOT_PROFILE_TOOL_NAMES.map((name) => {
        const tool = byName.get(name);
        if (tool === undefined) throw new Error(`@hubspot/mcp-server does not list ${name}`);
        return tool;
      });
      this.vendor = { client, tools, stderr: () => stderr };
    } catch (error) {
      await client.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not start the vendor HubSpot MCP server for the fake: ${message}\n${stderr}`,
      );
    }
  }

  private mcpRoute(): RawResponse {
    return {
      raw: async (request, response, body) => {
        if (!this.mcpAvailable) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Service unavailable" },
              id: null,
            }),
          );
          return;
        }
        if (request.headers.authorization !== `Bearer ${this.mcpToken}`) {
          response.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": "Bearer",
          });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Unauthorized" },
              id: null,
            }),
          );
          return;
        }
        const vendor = this.vendor;
        if (vendor === null) {
          response.writeHead(503).end();
          return;
        }
        const server = new Server(
          { name: "hubspot-mcp-server", version: "0.4.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...vendor.tools] }));
        server.setRequestHandler(CallToolRequestSchema, async (call): Promise<CallToolResult> => {
          const name = call.params.name;
          const args = call.params.arguments ?? {};
          if (!vendor.tools.some((tool) => tool.name === name)) {
            throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
          }
          const result = (await vendor.client.request(
            { method: "tools/call", params: { name, arguments: args } },
            CallToolResultSchema,
          )) as CallToolResult;
          this.mcpCalls.push({ tool: name, arguments: args, isError: result.isError === true });
          return result;
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(request, response, parseJsonBody(body));
      },
    };
  }
}

function parseJsonBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function ok(body: JsonObject): FakeResponse {
  return { status: 200, body };
}

function envelope(error: HubSpotApiError): FakeResponse {
  return {
    status: error.status,
    body: {
      status: "error",
      message: error.message,
      correlationId: randomUUID(),
      category: error.category,
      ...error.extra,
    },
  };
}

function jsonBody(request: FakeRequest): JsonObject {
  if (mediaType(request) !== "application/json") {
    throw new HubSpotApiError(415, "VALIDATION_ERROR", "Content-Type must be application/json");
  }
  try {
    const parsed: unknown = JSON.parse(request.rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as JsonObject;
  } catch {
    throw new HubSpotApiError(400, "VALIDATION_ERROR", "Invalid input JSON on line 1");
  }
}

function inputsOf(body: JsonObject): JsonObject[] {
  if (!Array.isArray(body.inputs))
    throw new HubSpotApiError(
      400,
      "VALIDATION_ERROR",
      "Invalid input JSON: inputs must be an array",
    );
  return body.inputs.map((input) => objectOf(input, "inputs"));
}

function objectOf(value: JsonValue | undefined, name: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new HubSpotApiError(
      400,
      "VALIDATION_ERROR",
      `Invalid input JSON: ${name} must be an object`,
    );
  }
  return value as JsonObject;
}

function csv(value: string | null): string[] {
  return value === null || value === ""
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export type { HubSpotObjectType };
