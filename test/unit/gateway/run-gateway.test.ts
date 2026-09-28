import { afterEach, describe, expect, it } from "vitest";
import {
  type ComposioAccess,
  DEFAULT_POLICY,
  INTEGRATION_IDS,
} from "../../../src/contracts/integration.js";
import { openRunGateway, type RunGateway } from "../../../src/gateway/run-gateway.js";
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
import { CRM_TOOLS, MAIL_TOOLS, startHttpUpstream } from "../../support/upstream-mcp.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CRM_TOKEN = `crm-token-${"x".repeat(20)}`;
const MAIL_TOKEN = `mail-token-${"y".repeat(20)}`;

async function upstreams() {
  const crm = await startHttpUpstream({ token: CRM_TOKEN, tools: CRM_TOOLS, name: "crm" });
  const mail = await startHttpUpstream({ token: MAIL_TOKEN, tools: MAIL_TOOLS, name: "mail" });
  cleanups.push(
    () => crm.close(),
    () => mail.close(),
  );
  const selections: { toolkits: readonly string[]; access: ComposioAccess }[] = [];
  const composio: ComposioTestSession = async (toolkits, access) => {
    selections.push({ toolkits, access });
    return {
      transport: "http",
      url: mail.url,
      headers: { Authorization: `Bearer ${MAIL_TOKEN}` },
    };
  };
  return { crm, mail, composio, catalog: testCatalog({ composio }), selections };
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
    const { crm, catalog } = await upstreams();
    const gateway = await open({
      plans: plansWith([
        { integration: "stripe", status: "available", connection: stripeConnection() },
        {
          integration: "hubspot",
          status: "available",
          connection: hubspotHttpConnection(crm.url, CRM_TOKEN),
        },
        { integration: "gmail", status: "available", connection: gmailConnection() },
      ]),
      catalog,
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
      endpointLabel: "api.stripe.test",
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
    const { crm, catalog, mail } = await upstreams();
    const gateway = await open({
      plans: plansWith([
        {
          integration: "hubspot",
          status: "available",
          connection: hubspotHttpConnection(crm.url, CRM_TOKEN),
        },
        { integration: "gmail", status: "available", connection: gmailConnection() },
      ]),
      catalog,
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
    expect(crm.calls).toEqual([{ tool: "search_contacts", arguments: { query: "ana" } }]);
    expect(mail.calls).toEqual([{ tool: "GMAIL_FETCH_EMAILS", arguments: { query: "x" } }]);
    expect(crm.unauthorized + mail.unauthorized).toBe(0);
  });

  it("asks Composio for one session covering the run's toolkits at the policy's exposure", async () => {
    const cases: [typeof DEFAULT_POLICY, ComposioAccess][] = [
      [DEFAULT_POLICY, "outbound"],
      [{ ...DEFAULT_POLICY, outbound: "deny" }, "draft"],
    ];
    for (const [policy, access] of cases) {
      const { catalog, selections } = await upstreams();
      const calendar = { ...gmailConnection(), integration: "google_calendar" as const };
      await open({
        policy,
        catalog,
        plans: plansWith([
          { integration: "gmail", status: "available", connection: gmailConnection() },
          {
            integration: "google_calendar",
            status: "available",
            connection: {
              ...calendar,
              composio: { ...calendar.composio, toolkit: "googlecalendar" },
            },
          },
        ]),
      });
      expect(selections).toEqual([{ toolkits: ["gmail", "googlecalendar"], access }]);
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
    const { crm } = await upstreams();
    const gateway = await open({
      plans: plansWith([
        {
          integration: "hubspot",
          status: "available",
          connection: hubspotHttpConnection(crm.url, CRM_TOKEN),
        },
      ]),
    });
    await gateway.close();
    await gateway.close();
  });
});
