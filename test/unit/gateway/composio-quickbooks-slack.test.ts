// QuickBooks and Slack through the gateway's Composio path, with the
// production integrations (profiles, classifiers, input rules, run memory)
// and the captured Composio schemas served by a local MCP upstream in place
// of the Composio session MCP. Proves that one session serves both toolkits
// under their own servers, that a call's result reaches the run memory
// before the next call is classified, and that the input rules reject a bad
// call before any policy.

import { readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPOSIO_TOOLKIT_OF,
  type ComposioConnection,
  DEFAULT_POLICY,
} from "../../../src/contracts/integration.js";
import type { IntegrationCatalog } from "../../../src/gateway/catalog.js";
import { openRunGateway, type RunGateway } from "../../../src/gateway/run-gateway.js";
import { createIntegrations } from "../../../src/integrations/registry.js";
import { plansWith, TEST_SETTINGS } from "../../helpers/agent-fixtures.js";
import { callWithMeta, connectClient } from "../../helpers/mcp-client.js";
import { startHttpUpstream, type UpstreamToolFixture } from "../../support/upstream-mcp.js";

const TOKEN = "composio-session-token-0123456789";

const surface = JSON.parse(
  readFileSync(new URL("../../fixtures/surfaces/composio-direct.json", import.meta.url), "utf8"),
) as { toolkits: Record<string, { tools: (Tool & { catalog?: unknown })[] }> };

/** A captured Composio tool with the data Composio would answer inside `data`. */
function captured(name: string, reply: () => unknown): UpstreamToolFixture {
  for (const toolkit of Object.values(surface.toolkits)) {
    const found = toolkit.tools.find((tool) => tool.name === name);
    if (found !== undefined) {
      const { catalog: _catalog, ...tool } = found;
      return { tool, reply: () => ({ successful: true, data: reply(), error: null }) };
    }
  }
  throw new Error(`${name} is not in the captured surface`);
}

const TOOLS: readonly UpstreamToolFixture[] = [
  captured("QUICKBOOKS_QUERY_INVOICES", () => ({
    Invoice: [
      {
        Id: "151",
        DocNumber: "1051",
        TotalAmt: 1980,
        Balance: 1980,
        CustomerRef: { value: "63", name: "Meridian Labs" },
      },
    ],
  })),
  captured("QUICKBOOKS_CREATE_PAYMENT", () => ({ Id: "90", TotalAmt: "1980.00" })),
  captured("SLACK_FIND_CHANNELS", () => ({
    ok: true,
    channels: [{ id: "C0BILLING01", name: "billing", is_ext_shared: false }],
  })),
  captured("SLACK_SEND_MESSAGE", () => ({ ok: true, channel: "C0BILLING01", ts: "1.2" })),
];

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function connection<I extends "quickbooks" | "slack">(integration: I): ComposioConnection<I> {
  return {
    integration,
    kind: "composio",
    profile: "composio",
    endpointLabel: "backend.composio.dev",
    composio: {
      apiKey: { reveal: () => "ak_test", toString: () => "[redacted]", toJSON: () => "[redacted]" },
      userId: "user_test",
      baseUrl: "https://backend.composio.dev",
      toolkit: COMPOSIO_TOOLKIT_OF[integration],
    },
  } as ComposioConnection<I>;
}

async function openGateway(): Promise<{ gateway: RunGateway; toolkits: readonly string[][] }> {
  const upstream = await startHttpUpstream({ token: TOKEN, tools: TOOLS, name: "composio" });
  cleanups.push(() => upstream.close());
  const toolkits: string[][] = [];
  const connector = () => ({
    upstream: async (requested: readonly string[]) => {
      toolkits.push([...requested]);
      return {
        config: {
          transport: "http" as const,
          url: upstream.url,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      };
    },
  });
  const production = createIntegrations();
  const catalog: IntegrationCatalog = {
    ...production,
    quickbooks: { ...production.quickbooks, connector },
    slack: { ...production.slack, connector },
  };
  const gateway = await openRunGateway({
    runId: "run_qbo_slack",
    catalog,
    settings: TEST_SETTINGS,
    policy: DEFAULT_POLICY,
    signal: new AbortController().signal,
    plans: plansWith([
      { integration: "quickbooks", status: "available", connection: connection("quickbooks") },
      { integration: "slack", status: "available", connection: connection("slack") },
    ]),
  });
  cleanups.push(() => gateway.close());
  return { gateway, toolkits };
}

describe("QuickBooks and Slack through the Composio session", () => {
  it("offers each toolkit's captured tools under its own server, from one session", async () => {
    const { gateway, toolkits } = await openGateway();
    expect(toolkits).toEqual([["quickbooks", "slack"]]);
    expect(gateway.registry.names().sort()).toEqual(
      [
        "mcp__quickbooks__QUICKBOOKS_CREATE_PAYMENT",
        "mcp__quickbooks__QUICKBOOKS_QUERY_INVOICES",
        "mcp__slack__SLACK_FIND_CHANNELS",
        "mcp__slack__SLACK_SEND_MESSAGE",
      ].sort(),
    );
    expect(
      gateway.registry.get("mcp__quickbooks__QUICKBOOKS_CREATE_PAYMENT")?.descriptor,
    ).toMatchObject({
      connectionKind: "composio",
      baseClass: "financial",
      upstream: "QUICKBOOKS_CREATE_PAYMENT",
    });
    const byId = new Map(gateway.connections.map((entry) => [entry.integration, entry]));
    expect(byId.get("quickbooks")).toMatchObject({ kind: "composio", availability: "ready" });
    expect(byId.get("slack")).toMatchObject({ kind: "composio", availability: "ready" });
    expect(Object.keys(gateway.mcpServers()).sort()).toEqual(["quickbooks", "slack"]);
  });

  it("names the invoice and customer on a payment card once the run read them", async () => {
    const { gateway } = await openGateway();
    const payment = gateway.registry.get("mcp__quickbooks__QUICKBOOKS_CREATE_PAYMENT");
    if (payment === undefined) throw new Error("payment tool not offered");
    const input = {
      customer_id: "63",
      total_amt: 1980,
      lines: [{ Amount: 1980, LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] }],
    };
    expect(payment.validate(input)).toEqual([]);
    expect(payment.classify(input)?.details?.consequence).toBe(
      "Record a $1,980.00 payment from QuickBooks customer 63 against QuickBooks invoice 151",
    );
    const server = gateway.mcpServers().quickbooks;
    if (server === undefined) throw new Error("quickbooks server missing");
    const result = await callWithMeta(
      await connectClient(server),
      "QUICKBOOKS_QUERY_INVOICES",
      { status: "Overdue" },
      "toolu_invoices",
    );
    expect(result.isError).not.toBe(true);
    expect(payment.classify(input)).toMatchObject({
      actionClass: "financial",
      details: {
        consequence: "Record a $1,980.00 payment from Meridian Labs against invoice 1051",
        amount: { amountMinor: 198_000, currency: "USD" },
      },
    });
    // A payment that would charge a card is rejected before any policy, with what to fix.
    expect(payment.validate({ ...input, process_payment: true })).toEqual([
      expect.objectContaining({ path: "/process_payment" }),
    ]);
  });

  it("lets a post to an allowlisted channel id run once a channel search named it", async () => {
    const { gateway } = await openGateway();
    const post = gateway.registry.get("mcp__slack__SLACK_SEND_MESSAGE");
    if (post === undefined) throw new Error("post tool not offered");
    const input = { channel: "C0BILLING01", markdown_text: "Refunded the duplicate charge." };
    expect(post.classify(input)?.actionClass).toBe("outbound");
    const server = gateway.mcpServers().slack;
    if (server === undefined) throw new Error("slack server missing");
    await callWithMeta(
      await connectClient(server),
      "SLACK_FIND_CHANNELS",
      { query: "billing" },
      "toolu_channels",
    );
    expect(post.classify(input)).toMatchObject({
      actionClass: "internal_write",
      title: "Post to #billing in Slack",
    });
    // Mentions that notify nobody and Block Kit are rejected before any policy.
    expect(post.validate({ channel: "#billing", markdown_text: "Thanks @Sam" })).toHaveLength(1);
    expect(
      post.validate({ channel: "#billing", markdown_text: "x", blocks: [{ type: "divider" }] }),
    ).toEqual([expect.objectContaining({ path: "/blocks" })]);
  });
});
