import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ComposioAccess,
  DEFAULT_POLICY,
  INTEGRATION_IDS,
} from "../../../src/contracts/integration.js";
import type { UpstreamConnector } from "../../../src/gateway/mcp-proxy.js";
import { openRunGateway, type RunGateway } from "../../../src/gateway/run-gateway.js";
import type { GatewayCallResult } from "../../../src/gateway/types.js";
import { GmailDraftMemory } from "../../../src/integrations/gmail/run-memory.js";
import {
  type ComposioTestSession,
  gmailConnection,
  hubspotHttpConnection,
  plansWith,
  stripeConnection,
  TEST_SETTINGS,
  testCatalog,
} from "../../helpers/agent-fixtures.js";
import { callWithMeta, connectClient } from "../../helpers/mcp-client.js";

// The gateway's own logic (which tools it offers, how it routes, classifies
// and reports), with its upstream MCP connections made in memory: each
// upstream below is a minimal MCP server local to this file that lists a few
// tools and echoes what it received. Nothing here is a copy of a vendor's
// service; the real upstreams are exercised by `pnpm test:live`.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CRM_TOKEN = `crm-token-${"x".repeat(20)}`;
const MAIL_TOKEN = `mail-token-${"y".repeat(20)}`;

const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
});

/** The tools each in-memory upstream lists, by the host of its URL. */
const UPSTREAM_TOOLS: Readonly<Record<string, readonly Tool[]>> = {
  crm: [
    { name: "search_contacts", inputSchema: object({ query: { type: "string" } }, ["query"]) },
    {
      name: "create_note",
      inputSchema: object({ contact_id: { type: "string" }, body: { type: "string" } }, [
        "contact_id",
        "body",
      ]),
    },
  ],
  mail: [
    { name: "GMAIL_FETCH_EMAILS", inputSchema: object({ query: { type: "string" } }) },
    {
      name: "GMAIL_CREATE_EMAIL_DRAFT",
      inputSchema: object(
        {
          recipient_email: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        ["recipient_email", "subject", "body"],
      ),
    },
    {
      name: "GMAIL_SEND_DRAFT",
      inputSchema: object({ draft_id: { type: "string" } }, ["draft_id"]),
    },
  ],
};

type Call = { readonly tool: string; readonly arguments: Record<string, unknown> };

/**
 * An UpstreamConnector that serves `memory://crm/…` and `memory://mail/…` in
 * process, recording each call and the headers the gateway sent.
 */
function memoryUpstreams() {
  const calls: Record<string, Call[]> = { crm: [], mail: [] };
  const headers: Record<string, Readonly<Record<string, string>>> = {};
  const connect: UpstreamConnector = async (config) => {
    if (config.transport !== "http") throw new Error("only http upstreams are served here");
    const name = new URL(config.url).host;
    const tools = UPSTREAM_TOOLS[name];
    if (tools === undefined) throw new Error(`could not connect to the http MCP server ${name}`);
    headers[name] = { ...config.headers };
    const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }));
    server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
      const args = request.params.arguments ?? {};
      calls[name]?.push({ tool: request.params.name, arguments: args });
      const reply = request.params.name === "GMAIL_CREATE_EMAIL_DRAFT" ? { draft_id: "r_1" } : {};
      return { content: [{ type: "text", text: JSON.stringify({ ...reply, received: args }) }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "revenue-desk-gateway", version: "1.0.0" });
    await client.connect(clientSide);
    const listed = await client.listTools();
    return {
      client,
      tools: listed.tools,
      instructions: client.getInstructions(),
      stderrTail: () => "",
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  };
  const selections: { toolkits: readonly string[]; access: ComposioAccess }[] = [];
  const composio: ComposioTestSession = async (toolkits, access) => {
    selections.push({ toolkits, access });
    return {
      transport: "http",
      url: "memory://mail/mcp",
      headers: { Authorization: `Bearer ${MAIL_TOKEN}` },
    };
  };
  return {
    connect,
    calls,
    headers,
    composio,
    catalog: testCatalog({ composio }),
    selections,
    crmUrl: "memory://crm/mcp",
  };
}

async function open(
  options: Partial<Parameters<typeof openRunGateway>[0]> & {
    readonly plans: Parameters<typeof openRunGateway>[0]["plans"];
  },
): Promise<RunGateway> {
  const gateway = await openRunGateway({
    runId: "run_1",
    catalog: testCatalog(),
    settings: TEST_SETTINGS,
    policy: DEFAULT_POLICY,
    signal: new AbortController().signal,
    ...options,
  });
  cleanups.push(() => gateway.close());
  return gateway;
}

describe("openRunGateway", () => {
  it("connects every kind, registers the offered tools and reports all six integrations", async () => {
    const { crmUrl, catalog, connect } = memoryUpstreams();
    const gateway = await open({
      plans: plansWith([
        { integration: "stripe", status: "available", connection: stripeConnection() },
        {
          integration: "hubspot",
          status: "available",
          connection: hubspotHttpConnection(crmUrl, CRM_TOKEN),
        },
        { integration: "gmail", status: "available", connection: gmailConnection() },
      ]),
      catalog,
      connectUpstream: connect,
    });
    expect(gateway.connections.map((connection) => connection.integration)).toEqual([
      ...INTEGRATION_IDS,
    ]);
    expect(
      gateway.connections.map((connection) => [
        connection.integration,
        connection.availability,
        connection.state,
      ]),
    ).toEqual([
      ["gmail", "ready", "connected"],
      ["google_calendar", "unavailable", "not_configured"],
      ["hubspot", "ready", "connected"],
      ["stripe", "ready", "connected"],
      ["quickbooks", "unavailable", "not_configured"],
      ["slack", "unavailable", "not_configured"],
    ]);
    expect(
      gateway.connections.find((connection) => connection.integration === "stripe"),
    ).toMatchObject({
      kind: "api",
      profile: "stripe-api",
      endpointLabel: "api.stripe.com",
      detail: null,
    });
    expect(gateway.registry.names().sort()).toEqual(
      [
        "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT",
        "mcp__gmail__GMAIL_FETCH_EMAILS",
        "mcp__gmail__GMAIL_SEND_DRAFT",
        "mcp__hubspot__create_note",
        "mcp__hubspot__search_contacts",
        "mcp__stripe__create_refund",
        "mcp__stripe__list_charges",
      ].sort(),
    );
    expect(Object.keys(gateway.mcpServers()).sort()).toEqual(["gmail", "hubspot", "stripe"]);
  });

  it("classifies and validates through the registry", async () => {
    const gateway = await open({
      plans: plansWith([
        { integration: "stripe", status: "available", connection: stripeConnection() },
      ]),
    });
    const refund = gateway.registry.get("mcp__stripe__create_refund");
    expect(refund?.descriptor).toMatchObject({
      integration: "stripe",
      connectionKind: "api",
      baseClass: "financial",
      readOnly: false,
    });
    expect(refund?.classify({ charge: "ch_2", amount: 4900 })).toMatchObject({
      actionClass: "financial",
      details: { consequence: "Refund $49.00 of ch_2" },
    });
    expect(refund?.validate({ charge: "ch_2", amount: "x" })).toHaveLength(1);
    expect(gateway.registry.get("mcp__stripe__delete_everything")).toBeUndefined();
  });

  it("routes each server's calls to its own integration", async () => {
    const { crmUrl, catalog, connect, calls, headers } = memoryUpstreams();
    const gateway = await open({
      plans: plansWith([
        {
          integration: "hubspot",
          status: "available",
          connection: hubspotHttpConnection(crmUrl, CRM_TOKEN),
        },
        { integration: "gmail", status: "available", connection: gmailConnection() },
      ]),
      catalog,
      connectUpstream: connect,
    });
    const servers = gateway.mcpServers();
    const hubspot = servers.hubspot;
    const gmail = servers.gmail;
    if (hubspot === undefined || gmail === undefined) throw new Error("servers missing");
    await callWithMeta(
      await connectClient(hubspot),
      "search_contacts",
      { query: "ana" },
      "toolu_1",
    );
    await callWithMeta(await connectClient(gmail), "GMAIL_FETCH_EMAILS", { query: "x" }, "toolu_2");
    expect(calls.crm).toEqual([{ tool: "search_contacts", arguments: { query: "ana" } }]);
    expect(calls.mail).toEqual([{ tool: "GMAIL_FETCH_EMAILS", arguments: { query: "x" } }]);
    // Each upstream received its own credential, and only that one.
    expect(headers.crm).toEqual({ Authorization: `Bearer ${CRM_TOKEN}` });
    expect(headers.mail).toEqual({ Authorization: `Bearer ${MAIL_TOKEN}` });
  });

  it("feeds an integration's run memory every finished call, so a later call is classified with it", async () => {
    const { catalog, connect } = memoryUpstreams();
    const memory = new GmailDraftMemory();
    const finished: GatewayCallResult[] = [];
    const gateway = await open({
      plans: plansWith([
        { integration: "gmail", status: "available", connection: gmailConnection() },
      ]),
      catalog: { ...catalog, gmail: { ...catalog.gmail, runMemory: () => memory } },
      observer: { callFinished: (result) => finished.push(result) },
      connectUpstream: connect,
    });
    const send = gateway.registry.get("mcp__gmail__GMAIL_SEND_DRAFT");
    if (send === undefined) throw new Error("send not registered");
    // Before the run created the draft, nothing vouches for its recipients.
    expect(send.classify({ draft_id: "r_1" })?.details?.recipients).toBeUndefined();

    const gmail = gateway.mcpServers().gmail;
    if (gmail === undefined) throw new Error("gmail server missing");
    await callWithMeta(
      await connectClient(gmail),
      "GMAIL_CREATE_EMAIL_DRAFT",
      { recipient_email: "jamie@fabrikam.example", subject: "Your charge", body: "Hi Jamie," },
      "toolu_draft",
    );
    // The run's own observer still sees the call.
    expect(finished.map((result) => result.call.tool)).toEqual(["GMAIL_CREATE_EMAIL_DRAFT"]);
    expect(memory.drafts.get("r_1")?.recipients.to).toEqual(["jamie@fabrikam.example"]);
    expect(send.classify({ draft_id: "r_1" })).toMatchObject({
      actionClass: "outbound",
      details: {
        consequence: "Send the Gmail draft to jamie@fabrikam.example",
        recipients: ["jamie@fabrikam.example"],
      },
    });
    // Each run starts with an empty memory.
    const other = await open({
      plans: plansWith([
        { integration: "gmail", status: "available", connection: gmailConnection() },
      ]),
      catalog: { ...catalog, gmail: { ...catalog.gmail, runMemory: () => new GmailDraftMemory() } },
      connectUpstream: connect,
    });
    expect(
      other.registry.get("mcp__gmail__GMAIL_SEND_DRAFT")?.classify({ draft_id: "r_1" })?.details
        ?.recipients,
    ).toBeUndefined();
  });

  it("asks Composio for one session covering the run's toolkits at the policy's exposure", async () => {
    const cases: [typeof DEFAULT_POLICY, ComposioAccess][] = [
      [DEFAULT_POLICY, "outbound"],
      [{ ...DEFAULT_POLICY, outbound: "deny" }, "outbound"],
      [{ ...DEFAULT_POLICY, outbound: "deny", financial: "deny" }, "draft"],
    ];
    for (const [policy, access] of cases) {
      const { catalog, selections, connect } = memoryUpstreams();
      const composio = gmailConnection().composio;
      const base = {
        kind: "composio",
        profile: "composio",
        endpointLabel: "backend.composio.dev",
      } as const;
      await open({
        policy,
        catalog,
        connectUpstream: connect,
        plans: plansWith([
          { integration: "gmail", status: "available", connection: gmailConnection() },
          {
            integration: "google_calendar",
            status: "available",
            connection: {
              ...base,
              integration: "google_calendar",
              composio: { ...composio, toolkit: "googlecalendar" },
            },
          },
          {
            integration: "quickbooks",
            status: "available",
            connection: {
              ...base,
              integration: "quickbooks",
              composio: { ...composio, toolkit: "quickbooks" },
            },
          },
          {
            integration: "slack",
            status: "available",
            connection: {
              ...base,
              integration: "slack",
              composio: { ...composio, toolkit: "slack" },
            },
          },
        ]),
      });
      expect(selections).toEqual([
        { toolkits: ["gmail", "googlecalendar", "quickbooks", "slack"], access },
      ]);
    }
  });

  it("makes an integration unavailable when its upstream cannot be reached, never falling back", async () => {
    const catalog = testCatalog({
      composio: async () => {
        throw new Error(`Composio session creation failed: bad key composio-key-${"c".repeat(20)}`);
      },
    });
    const gateway = await open({
      plans: plansWith([
        { integration: "stripe", status: "available", connection: stripeConnection() },
        {
          integration: "hubspot",
          status: "available",
          connection: hubspotHttpConnection("http://127.0.0.1:9/mcp", CRM_TOKEN),
        },
        { integration: "gmail", status: "available", connection: gmailConnection() },
      ]),
      catalog,
      redact: (text) => text.replaceAll(`composio-key-${"c".repeat(20)}`, "[redacted]"),
      connectTimeoutMs: 2_000,
    });
    const byId = new Map(
      gateway.connections.map((connection) => [connection.integration, connection]),
    );
    expect(byId.get("hubspot")).toMatchObject({ availability: "unavailable", state: "error" });
    expect(byId.get("hubspot")?.detail).toMatch(/^HubSpot could not be reached for this run: /);
    expect(byId.get("gmail")).toMatchObject({ availability: "unavailable", state: "error" });
    expect(byId.get("gmail")?.detail).toContain("[redacted]");
    expect(byId.get("gmail")?.detail).not.toContain("composio-key-");
    expect(byId.get("stripe")?.availability).toBe("ready");
    expect(gateway.registry.names().every((name) => name.startsWith("mcp__stripe__"))).toBe(true);
  });

  it("reports an integration that offers none of its tools", async () => {
    const catalog = testCatalog();
    const gateway = await open({
      catalog: { ...catalog, stripe: { ...catalog.stripe, tools: () => [] } },
      plans: plansWith([
        { integration: "stripe", status: "available", connection: stripeConnection() },
      ]),
    });
    expect(
      gateway.connections.find((connection) => connection.integration === "stripe"),
    ).toMatchObject({
      availability: "unavailable",
      state: "error",
      detail: "Stripe offered none of its tools.",
    });
    expect(gateway.registry.size).toBe(0);
  });

  it("keeps the caller's unavailable plans and marks missing plans unknown", async () => {
    const gateway = await open({
      plans: [
        {
          integration: "gmail",
          status: "unavailable",
          state: "needs_auth",
          detail: "Gmail is not connected.",
        },
      ],
    });
    expect(gateway.connections[0]).toMatchObject({
      integration: "gmail",
      availability: "unavailable",
      state: "needs_auth",
      detail: "Gmail is not connected.",
      endpointLabel: null,
    });
    expect(gateway.connections[3]).toMatchObject({ integration: "stripe", state: "unknown" });
  });

  it("closes its upstream connections once", async () => {
    const { crmUrl, connect } = memoryUpstreams();
    const gateway = await open({
      plans: plansWith([
        {
          integration: "hubspot",
          status: "available",
          connection: hubspotHttpConnection(crmUrl, CRM_TOKEN),
        },
      ]),
      connectUpstream: connect,
    });
    await gateway.close();
    await gateway.close();
  });
});
