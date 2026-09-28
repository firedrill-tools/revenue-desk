/**
 * The HubSpot fake with the real, pinned @hubspot/mcp-server 0.4.0:
 * - Streamable HTTP (HUBSPOT_MCP_URL): the fake's endpoint lists exactly the
 *   10 profile tools with the captured 0.4.0 schemas and serves them through
 *   the vendor code;
 * - stdio (the product default): the vendor server launched the way the
 *   product launches it, pointed at the fake's REST API.
 * Every vendor child runs with network access denied outside loopback.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHubSpotStdioLaunch } from "../../../src/integrations/hubspot/launch.js";
import { createClock } from "../../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";
import { HUBSPOT_PROFILE_TOOL_NAMES, HubSpotFake } from "../../support/fakes/hubspot/index.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const DENY_NETWORK = pathToFileURL(join(repoRoot, "test/support/deny-network.mjs")).href;
const captured = JSON.parse(
  readFileSync(join(repoRoot, "test/fixtures/surfaces/hubspot-mcp-0.4.0.json"), "utf8"),
) as { tools: Tool[] };

let hubspot: HubSpotFake;

beforeAll(async () => {
  const fixtures = loadBusinessFixtures();
  hubspot = await HubSpotFake.start({
    fixture: fixtures.hubspot,
    clock: createClock(fixtures.company.asOf),
    accessToken: FAKE_CREDENTIALS.hubspotAccessToken,
    mcpToken: FAKE_CREDENTIALS.hubspotMcpToken,
    prefix: "/hubspot",
    mcp: true,
  });
}, 60_000);

afterAll(async () => {
  await hubspot?.close();
});

const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

async function httpClient(token: string = FAKE_CREDENTIALS.hubspotMcpToken): Promise<Client> {
  const client = new Client({ name: "hubspot-fake-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(hubspot.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("HubSpot fake over Streamable HTTP MCP", () => {
  it("lists exactly the 10 profile tools, byte for byte as captured from 0.4.0", async () => {
    const client = await httpClient();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...HUBSPOT_PROFILE_TOOL_NAMES]);
      const byName = new Map(captured.tools.map((tool) => [tool.name, tool]));
      for (const tool of listed.tools) expect(tool).toEqual(byName.get(tool.name));
    } finally {
      await client.close();
    }
  });

  it("serves calls through the vendor code against the fake CRM", async () => {
    const client = await httpClient();
    try {
      const search = (await client.callTool({
        name: "hubspot-search-objects",
        arguments: { objectType: "contacts", query: "dana@harborpine.test" },
      })) as CallToolResult;
      expect(search.isError).not.toBe(true);
      const parsed = JSON.parse(text(search)) as {
        results: { id: string; properties: Record<string, string> }[];
      };
      expect(parsed.results.map((result) => result.id)).toEqual(["51011001"]);

      const user = (await client.callTool({
        name: "hubspot-get-user-details",
        arguments: {},
      })) as CallToolResult;
      expect(text(user)).toContain('"email": "maya@kestrel.test"');
      expect(text(user)).toContain('"portalId": 48213377');

      const created = (await client.callTool({
        name: "hubspot-batch-create-objects",
        arguments: {
          objectType: "notes",
          inputs: [
            {
              properties: {
                hs_note_body: "Duplicate charge refunded.",
                hs_timestamp: "2026-09-28T13:00:00Z",
              },
              associations: [
                {
                  to: { id: "51011001" },
                  types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
                },
              ],
            },
          ],
        },
      })) as CallToolResult;
      expect(created.isError).not.toBe(true);
      expect(JSON.parse(text(created))).toMatchObject({
        status: "COMPLETE",
        results: [{ properties: { hs_note_body: "Duplicate charge refunded." } }],
      });
      expect(hubspot.crm.created("notes", hubspot.crm.firstCreatedId)).toHaveLength(1);

      const invalid = (await client.callTool({
        name: "hubspot-batch-create-objects",
        arguments: {
          objectType: "notes",
          inputs: [{ properties: { hs_note_body: "no timestamp" } }],
        },
      })) as CallToolResult;
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain("REQUIRED_PROPERTY");

      expect(hubspot.mcpCalls.map((call) => [call.tool, call.isError])).toEqual([
        ["hubspot-search-objects", false],
        ["hubspot-get-user-details", false],
        ["hubspot-batch-create-objects", false],
        ["hubspot-batch-create-objects", true],
      ]);
    } finally {
      await client.close();
    }
  });

  it("refuses tools outside the profile without reaching the vendor", async () => {
    const client = await httpClient();
    const before = hubspot.mcpCalls.length;
    try {
      await expect(
        client.callTool({ name: "hubspot-create-property", arguments: { objectType: "deals" } }),
      ).rejects.toThrow(/not found/);
    } finally {
      await client.close();
    }
    expect(hubspot.mcpCalls.length).toBe(before);
  });

  it("requires the MCP bearer token and can be down at start", async () => {
    await expect(httpClient("wrong-token")).rejects.toThrow();
    hubspot.setMcpAvailable(false);
    try {
      await expect(httpClient()).rejects.toThrow();
    } finally {
      hubspot.setMcpAvailable(true);
    }
    const client = await httpClient();
    await client.close();
  });
});

describe("HubSpot fake behind the product's stdio launch", () => {
  it("runs the pinned vendor server against the fake REST API with no other network", async () => {
    const env = hubspot.stdioEnv();
    const launch = buildHubSpotStdioLaunch({
      accessToken: env.HUBSPOT_ACCESS_TOKEN,
      apiBaseUrl: env.HUBSPOT_API_BASE_URL,
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
      stderr += chunk.toString("utf8");
    });
    const client = new Client({ name: "hubspot-stdio-test", version: "0.0.0" });
    await client.connect(transport);
    const before = hubspot.requests.length;
    try {
      const listed = await client.listTools();
      expect(listed.tools).toEqual(captured.tools);
      const deals = (await client.callTool({
        name: "hubspot-list-objects",
        arguments: { objectType: "deals", limit: 10, properties: ["dealname", "dealstage"] },
      })) as CallToolResult;
      expect(deals.isError).not.toBe(true);
      expect(text(deals)).toContain("Solstice Energy – Enterprise annual");
      const associations = (await client.callTool({
        name: "hubspot-list-associations",
        arguments: { objectType: "deals", objectId: "90011004", toObjectType: "contacts" },
      })) as CallToolResult;
      expect(JSON.parse(text(associations))).toEqual({
        results: [
          {
            toObjectId: 51011007,
            associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 3, label: null }],
          },
        ],
      });
    } finally {
      await client.close();
    }
    const paths = hubspot.requests.slice(before).map((entry) => `${entry.method} ${entry.path}`);
    expect(paths).toEqual([
      "GET /crm/v3/objects/deals",
      "GET /crm/v4/objects/deals/90011004/associations/contacts",
    ]);
    expect(stderr).not.toContain("[deny-network] blocked");
  });
});
