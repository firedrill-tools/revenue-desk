import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { HubSpotConnection } from "../../../src/contracts/integration.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import type { Upstream, UpstreamConfig } from "../../../src/gateway/mcp-proxy.js";
import { registerTool } from "../../../src/gateway/registry.js";
import { invalidArgumentsMessage } from "../../../src/gateway/validate.js";
import { classifyHubSpot } from "../../../src/integrations/hubspot/classify.js";
import { createHubSpotIntegration } from "../../../src/integrations/hubspot/definition.js";
import { checkHubSpotInput } from "../../../src/integrations/hubspot/input-rules.js";
import { type ConnectUpstream, probeHubSpot } from "../../../src/integrations/hubspot/probe.js";
import {
  HUBSPOT_API_TOOL_NAMES,
  HUBSPOT_PROFILE,
  HUBSPOT_TOOL_NAMES,
} from "../../../src/integrations/hubspot/profile.js";
import { resolveHubSpot } from "../../../src/integrations/hubspot/resolve.js";
import { hubspotUpstreamConfig } from "../../../src/integrations/hubspot/upstream.js";
import { SETTINGS, secret, testEnv } from "./helpers.js";

const TOKEN = "pat-na1-unit-dummy-token";
const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../fixtures/surfaces/hubspot-mcp-0.4.0.json"),
    "utf8",
  ),
) as { tools: Tool[] };

type StdioTransport = Extract<HubSpotConnection["mcp"], { readonly transport: "stdio" }>;

const stdioMcp: StdioTransport = {
  transport: "stdio",
  accessToken: secret(TOKEN),
  apiBaseUrl: null,
  command: null,
};

const stdio: HubSpotConnection = {
  integration: "hubspot",
  kind: "mcp",
  profile: "hubspot-mcp-0.4",
  endpointLabel: "api.hubspot.com",
  mcp: stdioMcp,
};

describe("hubspot-mcp-0.4 profile", () => {
  it("forwards the 10 decided MCP tools, all present in the 0.4.0 capture", () => {
    expect(HUBSPOT_TOOL_NAMES).toEqual([
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
    ]);
    const captured = new Map(fixture.tools.map((tool) => [tool.name, tool]));
    // The owners lookup is Revenue Desk's own REST tool: the MCP server has none.
    expect(HUBSPOT_API_TOOL_NAMES).toEqual(["hubspot-list-owners"]);
    expect(captured.has("hubspot-list-owners")).toBe(false);
    expect(HUBSPOT_PROFILE.tools["hubspot-list-owners"]).toMatchObject({
      upstream: "GET /crm/v3/owners",
      operation: "hubspot.owners.list",
      baseClass: "read",
      readOnly: true,
    });
    for (const spec of Object.values(HUBSPOT_PROFILE.tools)) {
      if (HUBSPOT_API_TOOL_NAMES.includes(spec.name)) continue;
      const tool = captured.get(spec.name);
      expect(tool, spec.name).toBeDefined();
      expect(spec.upstream).toBe(spec.name);
      expect(spec.readOnly).toBe(tool?.annotations?.readOnlyHint === true);
    }
    expect(captured.has("hubspot-batch-create-associations")).toBe(true);
    expect(HUBSPOT_TOOL_NAMES).not.toContain("hubspot-batch-create-associations");
  });
});

describe("classifyHubSpot", () => {
  it("classifies reads as read, naming the object type in the title", () => {
    expect(
      classifyHubSpot(
        "hubspot-search-objects",
        { objectType: "contacts", query: "ana@acme.test" },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "read",
      operation: "hubspot.objects.search",
      title: "Search HubSpot contacts",
    });
    expect(
      classifyHubSpot("hubspot-list-objects", { objectType: "line_items" }, SETTINGS)?.title,
    ).toBe("List HubSpot line items");
    expect(classifyHubSpot("hubspot-get-user-details", {}, SETTINGS)).toEqual({
      actionClass: "read",
      operation: "hubspot.account.get",
      title: "Get HubSpot account details",
    });
    expect(
      classifyHubSpot("hubspot-search-objects", { objectType: "Robert'); DROP" }, SETTINGS)?.title,
    ).toBe("Search HubSpot records");
    for (const name of HUBSPOT_TOOL_NAMES.slice(0, 8)) {
      expect(classifyHubSpot(name, { objectType: "deals" }, SETTINGS)?.actionClass).toBe("read");
    }
  });

  it("creates a note with its associations inline as internal_write", () => {
    const input: JsonObject = {
      objectType: "notes",
      inputs: [
        {
          properties: {
            hs_note_body: "Refunded duplicate charge ch_2 ($49.00).",
            hs_timestamp: "2026-09-28T10:00:00Z",
          },
          associations: [
            {
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
              to: { id: "101" },
            },
            {
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }],
              to: { id: "555" },
            },
          ],
        },
      ],
    };
    expect(classifyHubSpot("hubspot-batch-create-objects", input, SETTINGS)).toEqual({
      actionClass: "internal_write",
      operation: "hubspot.notes.create",
      title: "Create note in HubSpot",
      details: {
        consequence: "Create 1 note in HubSpot",
        facts: [
          { label: "Records", value: "1 note" },
          { label: "Linked to", value: "101 and 555" },
          {
            label: "note 1",
            value:
              "hs_note_body: Refunded duplicate charge ch_2 ($49.00).; hs_timestamp: 2026-09-28T10:00:00Z",
          },
        ],
        recordIds: ["101", "555"],
      },
    });
  });

  it("names the operation by object type for other creates and for updates", () => {
    const tasks = classifyHubSpot(
      "hubspot-batch-create-objects",
      {
        objectType: "tasks",
        inputs: [
          { properties: { hs_task_subject: "Call Acme" } },
          { properties: { hs_task_subject: "Call Kite" } },
        ],
      },
      SETTINGS,
    );
    expect(tasks).toMatchObject({
      actionClass: "internal_write",
      operation: "hubspot.tasks.create",
      title: "Create 2 tasks in HubSpot",
    });
    expect(tasks?.details?.recordIds).toBeUndefined();
    const deal = classifyHubSpot(
      "hubspot-batch-update-objects",
      { objectType: "deals", inputs: [{ id: "9001", properties: { dealstage: "closedwon" } }] },
      SETTINGS,
    );
    expect(deal).toMatchObject({
      actionClass: "internal_write",
      operation: "hubspot.deals.update",
      title: "Update deal in HubSpot",
      details: {
        recordIds: ["9001"],
        facts: [
          { label: "Records", value: "1 deal" },
          { label: "Record ids", value: "9001" },
          { label: "deal 1", value: "dealstage: closedwon" },
        ],
      },
    });
    expect(
      classifyHubSpot(
        "hubspot-batch-create-objects",
        { objectType: "line_items", inputs: [{ properties: {} }, { properties: {} }] },
        SETTINGS,
      )?.title,
    ).toBe("Create 2 line items in HubSpot");
  });

  it("denies writes it cannot judge", () => {
    const denied: Array<[string, JsonObject]> = [
      ["hubspot-batch-create-objects", { objectType: "quotes", inputs: [{ properties: {} }] }],
      ["hubspot-batch-create-objects", { objectType: "2-1234567", inputs: [{ properties: {} }] }],
      ["hubspot-batch-create-objects", { objectType: "users", inputs: [{ properties: {} }] }],
      ["hubspot-batch-create-objects", { objectType: "NOTES", inputs: [{ properties: {} }] }],
      ["hubspot-batch-create-objects", { objectType: "notes", inputs: [] }],
      ["hubspot-batch-create-objects", { objectType: "notes" }],
      ["hubspot-batch-create-objects", { objectType: "notes", inputs: ["x"] }],
      ["hubspot-batch-update-objects", { objectType: "deals", inputs: [{ properties: {} }] }],
      ["hubspot-batch-create-associations", {}],
      ["hubspot-create-property", {}],
      ["constructor", {}],
    ];
    for (const [tool, input] of denied) {
      expect(classifyHubSpot(tool, input, SETTINGS), `${tool} ${JSON.stringify(input)}`).toBeNull();
    }
  });
});

describe("HubSpot rules the forwarded schema does not state", () => {
  const note = (properties: JsonObject): JsonObject => ({
    objectType: "notes",
    inputs: [{ properties, associations: [] }],
  });

  it("requires hs_timestamp on engagement records before HubSpot sees them", () => {
    expect(checkHubSpotInput("hubspot-batch-create-objects", note({ hs_note_body: "x" }))).toEqual([
      {
        path: "/inputs/0/properties",
        message:
          'is missing "hs_timestamp", which HubSpot requires for notes: when it happened, as an ISO 8601 date-time, e.g. 2026-09-28T14:00:00Z',
      },
    ]);
    const tasks = checkHubSpotInput("hubspot-batch-create-objects", {
      objectType: "tasks",
      inputs: [
        { properties: { hs_task_subject: "Call", hs_timestamp: "2026-10-01T18:00:00Z" } },
        { properties: { hs_task_subject: "Follow up" } },
      ],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ path: "/inputs/1/properties" });
    expect(tasks[0]?.message).toContain("the task's due time");
    for (const objectType of ["calls", "meetings", "emails"]) {
      expect(
        checkHubSpotInput("hubspot-batch-create-objects", { objectType, inputs: [{}] }),
        objectType,
      ).toHaveLength(1);
    }
  });

  it("accepts a timestamp, other object types, updates and reads", () => {
    for (const timestamp of ["2026-09-28T13:01:00.000Z", 1_790_600_000_000]) {
      expect(
        checkHubSpotInput("hubspot-batch-create-objects", note({ hs_timestamp: timestamp })),
      ).toEqual([]);
    }
    expect(
      checkHubSpotInput("hubspot-batch-create-objects", {
        objectType: "companies",
        inputs: [{ properties: { name: "Acme" } }],
      }),
    ).toEqual([]);
    expect(checkHubSpotInput("hubspot-batch-update-objects", note({}))).toEqual([]);
    expect(checkHubSpotInput("hubspot-search-objects", note({}))).toEqual([]);
    expect(createHubSpotIntegration().checkInput).toBe(checkHubSpotInput);
  });

  it("rejects the call in the gateway's validation, with the schema checked first", () => {
    const schema = fixture.tools.find(
      (tool) => tool.name === "hubspot-batch-create-objects",
    )?.inputSchema;
    const spec = HUBSPOT_PROFILE.tools["hubspot-batch-create-objects"];
    if (schema === undefined || spec === undefined) throw new Error("no create tool");
    const tool = registerTool(
      {
        ...spec,
        integration: "hubspot",
        connectionKind: "mcp",
        sdkName: "mcp__hubspot__hubspot-batch-create-objects",
      },
      schema,
      createHubSpotIntegration(),
      SETTINGS,
    );
    const missing = tool.validate(note({ hs_note_body: "Refunded the duplicate." }));
    expect(missing.map((issue) => issue.path)).toEqual(["/inputs/0/properties"]);
    expect(invalidArgumentsMessage(spec.title, missing)).toContain(
      '`inputs.0.properties` is missing "hs_timestamp", which HubSpot requires for notes',
    );
    expect(
      tool.validate(note({ hs_note_body: "x", hs_timestamp: "2026-09-28T13:01:00Z" })),
    ).toEqual([]);
    // An input the schema refuses gets the schema's issues only.
    expect(tool.validate({ objectType: "notes" }).map((issue) => issue.message)).toEqual([
      'is missing the required property "inputs"',
    ]);
  });
});

describe("resolveHubSpot", () => {
  it("is not configured without a token or an MCP URL", () => {
    expect(resolveHubSpot(testEnv())).toEqual({
      status: "not_configured",
      missing: ["HUBSPOT_ACCESS_TOKEN"],
    });
  });

  it("resolves the stdio server with an optional API base URL and command override", () => {
    expect(resolveHubSpot(testEnv({ hubspot: { accessToken: secret(TOKEN) } }))).toMatchObject({
      status: "configured",
      connection: {
        kind: "mcp",
        endpointLabel: "api.hubspot.com",
        mcp: { transport: "stdio", apiBaseUrl: null, command: null },
      },
    });
    const faked = resolveHubSpot(
      testEnv({
        hubspot: {
          accessToken: secret(TOKEN),
          apiBaseUrl: "http://127.0.0.1:4440/hs/",
          command: { command: "node", args: ["fake.js"] },
        },
      }),
    );
    expect(faked).toMatchObject({
      status: "configured",
      connection: {
        endpointLabel: "127.0.0.1:4440",
        mcp: {
          transport: "stdio",
          apiBaseUrl: "http://127.0.0.1:4440/hs",
          command: { command: "node", args: ["fake.js"] },
        },
      },
    });
    expect(
      resolveHubSpot(
        testEnv({ hubspot: { accessToken: secret(TOKEN), apiBaseUrl: "http://hubspot.example" } }),
      ),
    ).toMatchObject({
      status: "invalid",
      problems: [{ variable: "HUBSPOT_API_BASE_URL" }],
    });
  });

  it("prefers HUBSPOT_MCP_URL, with or without a token", () => {
    expect(
      resolveHubSpot(
        testEnv({
          hubspot: {
            accessToken: secret(TOKEN),
            mcpUrl: "https://mcp.example.test/mcp",
            mcpToken: secret("mcp-token"),
          },
        }),
      ),
    ).toMatchObject({
      status: "configured",
      connection: {
        endpointLabel: "mcp.example.test",
        mcp: { transport: "http", url: "https://mcp.example.test/mcp" },
      },
    });
    expect(
      resolveHubSpot(testEnv({ hubspot: { mcpUrl: "http://127.0.0.1:4441/mcp" } })),
    ).toMatchObject({
      status: "configured",
      connection: { mcp: { transport: "http", token: null } },
    });
    expect(
      resolveHubSpot(
        testEnv({ hubspot: { mcpUrl: "http://mcp.example.test/mcp", mcpToken: secret("t") } }),
      ),
    ).toMatchObject({
      status: "invalid",
      problems: [{ variable: "HUBSPOT_MCP_URL" }],
    });
  });
});

describe("HubSpot upstream configuration", () => {
  it("launches the pinned server over stdio with an explicit environment", () => {
    const config = hubspotUpstreamConfig({
      ...stdio,
      mcp: { ...stdioMcp, apiBaseUrl: "http://127.0.0.1:4440/hs" },
    });
    expect(config.transport).toBe("stdio");
    if (config.transport !== "stdio") return;
    expect(config.command).toBe(process.execPath);
    expect(config.args).toHaveLength(1);
    expect(config.args?.[0]).toMatch(/@hubspot[/\\]mcp-server/);
    expect(config.env).toEqual({
      PRIVATE_APP_ACCESS_TOKEN: TOKEN,
      DOTENV_CONFIG_PATH: devNull,
      DOTENV_CONFIG_QUIET: "true",
      BASE_URL_OVERRIDE: "http://127.0.0.1:4440/hs",
    });
    expect(config.cwd).toMatch(/mcp-server$/);
  });

  it("uses a command override for tests and a Bearer header for HTTP servers", () => {
    const override = hubspotUpstreamConfig({
      ...stdio,
      mcp: { ...stdioMcp, command: { command: "node", args: ["fake.js"] } },
    });
    expect(override).toMatchObject({ transport: "stdio", command: "node", args: ["fake.js"] });
    const http: UpstreamConfig = hubspotUpstreamConfig({
      ...stdio,
      mcp: { transport: "http", url: "https://mcp.example.test/mcp", token: secret("mcp-token") },
    });
    expect(http).toEqual({
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { authorization: "Bearer mcp-token" },
    });
    expect(
      hubspotUpstreamConfig({
        ...stdio,
        mcp: { transport: "http", url: "https://m.test/mcp", token: null },
      }),
    ).toEqual({
      transport: "http",
      url: "https://m.test/mcp",
      headers: {},
    });
  });

  it("exposes the allowlist and upstream through the definition", () => {
    const definition = createHubSpotIntegration();
    expect(definition).toMatchObject({
      id: "hubspot",
      label: "HubSpot",
      kind: "mcp",
      allowlist: HUBSPOT_TOOL_NAMES,
    });
    expect(definition.upstream(stdio).transport).toBe("stdio");
  });
});

describe("probeHubSpot with a fake upstream", () => {
  function fakeUpstream(tools: readonly string[], result: CallToolResult | Error) {
    const calls: string[] = [];
    let closed = 0;
    const client = {
      callTool: async (params: { name: string }) => {
        calls.push(params.name);
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as Client;
    const upstream: Upstream = {
      client,
      tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
      instructions: undefined,
      stderrTail: () => "",
      close: async () => {
        closed += 1;
      },
    };
    const connect: ConnectUpstream = async () => upstream;
    return { connect, calls, closed: () => closed };
  }

  const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

  it("is connected when every profile tool is listed and the token works", async () => {
    const fake = fakeUpstream(
      [...HUBSPOT_TOOL_NAMES, "hubspot-get-workflow"],
      text('- Token Info: {"userId": 1, "hubId": 20211234}'),
    );
    await expect(
      probeHubSpot(stdio, new AbortController().signal, { connect: fake.connect }),
    ).resolves.toEqual({
      state: "connected",
      detail: "HubSpot MCP server lists all 10 profile tools; the token is accepted.",
      accountHint: "…234",
    });
    expect(fake.calls).toEqual(["hubspot-get-user-details"]);
    expect(fake.closed()).toBe(1);
  });

  it("reports a rejected token as needs_auth, without echoing it", async () => {
    const fake = fakeUpstream(HUBSPOT_TOOL_NAMES, {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error retrieving token. HubSpot API Error: 401 Unauthorized - {"token":"${TOKEN}"}`,
        },
      ],
    });
    const result = await probeHubSpot(stdio, new AbortController().signal, {
      connect: fake.connect,
    });
    expect(result.state).toBe("needs_auth");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fake.closed()).toBe(1);
  });

  it("reports a server that does not match the profile, other failures and launch problems as error", async () => {
    const partial = fakeUpstream(HUBSPOT_TOOL_NAMES.slice(0, 8), text("{}"));
    await expect(
      probeHubSpot(stdio, new AbortController().signal, { connect: partial.connect }),
    ).resolves.toMatchObject({
      state: "error",
      detail: expect.stringContaining(
        "hubspot-batch-create-objects and hubspot-batch-update-objects",
      ),
    });
    expect(partial.calls).toEqual([]);

    const failing = fakeUpstream(HUBSPOT_TOOL_NAMES, {
      isError: true,
      content: [{ type: "text", text: `HubSpot API Error: 500 oops ${TOKEN}` }],
    });
    const failed = await probeHubSpot(stdio, new AbortController().signal, {
      connect: failing.connect,
    });
    expect(failed.state).toBe("error");
    expect(failed.detail).not.toContain(TOKEN);

    const down: ConnectUpstream = async () => {
      throw new Error(
        `could not connect to the http MCP server: Error POSTing to endpoint (HTTP 401) ${TOKEN}`,
      );
    };
    const refused = await probeHubSpot(stdio, new AbortController().signal, { connect: down });
    expect(refused.state).toBe("needs_auth");

    const unreachable: ConnectUpstream = async () => {
      throw new Error("could not connect to the stdio MCP server: spawn ENOENT");
    };
    await expect(
      probeHubSpot(stdio, new AbortController().signal, { connect: unreachable }),
    ).resolves.toMatchObject({ state: "error" });

    const badLaunch = { ...stdio, mcp: { ...stdioMcp, command: { command: "  ", args: [] } } };
    await expect(probeHubSpot(badLaunch, new AbortController().signal)).resolves.toMatchObject({
      state: "error",
      detail: "HubSpot MCP command is empty",
    });
  });

  it("recognises refused credentials from the error chain or the transport's message", async () => {
    const failing =
      (error: Error): ConnectUpstream =>
      async () => {
        throw error;
      };
    const signal = new AbortController().signal;
    const withStatus = Object.assign(new Error("Streamable HTTP error: Error POSTing"), {
      code: 403,
    });
    const wrapped = new Error("could not connect", { cause: withStatus });
    const rpc = new Error(
      'could not connect to the http MCP server: Streamable HTTP error: Error POSTing to endpoint: {"error":{"code":-32001,"message":"Unauthorized"}}',
    );
    for (const error of [withStatus, wrapped, rpc]) {
      await expect(probeHubSpot(stdio, signal, { connect: failing(error) })).resolves.toMatchObject(
        {
          state: "needs_auth",
        },
      );
    }
    const unavailable = new Error(
      'Error POSTing to endpoint: {"error":{"message":"Service unavailable"}}',
    );
    await expect(
      probeHubSpot(stdio, signal, { connect: failing(unavailable) }),
    ).resolves.toMatchObject({ state: "error" });
  });

  it("closes an upstream that connects after the probe was aborted", async () => {
    const controller = new AbortController();
    let closed = false;
    let finish: (upstream: Upstream) => void = () => {};
    const connect: ConnectUpstream = () =>
      new Promise<Upstream>((done) => {
        finish = done;
      });
    const pending = probeHubSpot(stdio, controller.signal, { connect });
    controller.abort(new Error("stopped"));
    await expect(pending).resolves.toMatchObject({ state: "error" });
    finish({
      client: {} as Client,
      tools: [],
      instructions: undefined,
      stderrTail: () => "",
      close: async () => {
        closed = true;
      },
    });
    await new Promise((done) => setTimeout(done, 0));
    expect(closed).toBe(true);
  });
});
