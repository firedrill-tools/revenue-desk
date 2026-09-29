import { describe, expect, it } from "vitest";
import type { HubSpotConnection } from "../../../src/contracts/integration.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import { classifyHubSpot } from "../../../src/integrations/hubspot/classify.js";
import { createHubSpotIntegration } from "../../../src/integrations/hubspot/definition.js";
import {
  createHubSpotApiTools,
  HUBSPOT_DEFAULT_API_BASE_URL,
  OWNERS_TOOL,
} from "../../../src/integrations/hubspot/owners.js";
import { callContext, type Reply, SETTINGS, secret, stubFetch } from "./helpers.js";

const TOKEN = "pat-na1-owners-unit-token";

const stdio = (apiBaseUrl: string | null): HubSpotConnection => ({
  integration: "hubspot",
  kind: "mcp",
  profile: "hubspot-mcp-0.4",
  endpointLabel: "hubspot.test",
  mcp: { transport: "stdio", accessToken: secret(TOKEN), apiBaseUrl },
});

const JORDAN = {
  id: "71001",
  email: "jordan@example.test",
  firstName: "Jordan",
  lastName: "Reyes",
  userId: 9101,
  archived: false,
  teams: [{ id: "1", name: "Sales", primary: true }],
  createdAt: "2025-10-01T14:00:00.000Z",
};

function setup(
  reply: (index: number) => Reply,
  apiBaseUrl: string | null = "http://127.0.0.1:4455/hs",
) {
  const mock = stubFetch((_, index) => reply(index));
  const [tool] = createHubSpotApiTools(stdio(apiBaseUrl), mock.http);
  if (tool === undefined) throw new Error("no owners tool");
  const run = (args: JsonObject) => tool.run(args, callContext());
  return { mock, tool, run };
}

describe("HubSpot owners lookup", () => {
  it("gets one owner by id and names them", async () => {
    const { mock, run } = setup(() => ({ json: JORDAN }));
    await expect(run({ owner_id: "71001" })).resolves.toEqual({
      owners: [
        {
          id: "71001",
          name: "Jordan Reyes",
          email: "jordan@example.test",
          user_id: 9101,
          archived: false,
          teams: ["Sales"],
        },
      ],
      next_after: null,
    });
    const request = mock.requests[0];
    expect(request?.method).toBe("GET");
    // The base URL's path prefix is kept, and the token goes only in the header.
    expect(request?.url.pathname).toBe("/hs/crm/v3/owners/71001");
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("lists owners, filtered by email, and pages with after", async () => {
    const { mock, run } = setup(() => ({
      json: { results: [JORDAN], paging: { next: { after: "71002" } } },
    }));
    await expect(run({ email: "jordan@example.test", limit: 10 })).resolves.toMatchObject({
      owners: [{ id: "71001", name: "Jordan Reyes" }],
      next_after: "71002",
    });
    expect(Object.fromEntries(mock.requests[0]?.url.searchParams ?? [])).toEqual({
      email: "jordan@example.test",
      limit: "10",
    });
  });

  it("says plainly when an owner does not exist, without echoing the token", async () => {
    const { run } = setup(() => ({
      status: 404,
      json: {
        status: "error",
        message: `Owner not found for ${TOKEN}`,
        category: "OBJECT_NOT_FOUND",
      },
    }));
    const failure = run({ owner_id: "79999" });
    await expect(failure).rejects.toMatchObject({
      provider: "hubspot",
      status: 404,
      code: "OBJECT_NOT_FOUND",
      message: "HubSpot has no active owner with that id.",
    });
  });

  it("uses the stdio server's default host, and is not offered over an HTTP MCP server", async () => {
    const { mock, run } = setup(() => ({ json: JORDAN }), null);
    await run({ owner_id: "71001" });
    expect(mock.requests[0]?.url.origin).toBe(HUBSPOT_DEFAULT_API_BASE_URL);
    const http: HubSpotConnection = {
      ...stdio(null),
      mcp: { transport: "http", url: "https://mcp.hubspot.test/mcp", token: secret("t") },
    };
    expect(createHubSpotApiTools(http)).toEqual([]);
    expect(createHubSpotIntegration().apiTools(http)).toEqual([]);
    expect(
      createHubSpotIntegration()
        .apiTools(stdio(null))
        .map((tool) => tool.name),
    ).toEqual([OWNERS_TOOL]);
  });

  it("is a read, described so the agent names owners instead of showing ids", () => {
    const { tool } = setup(() => ({ json: JORDAN }));
    expect(tool.readOnly).toBe(true);
    expect(tool.description).toContain("hubspot_owner_id");
    expect(classifyHubSpot(OWNERS_TOOL, { owner_id: "71001" }, SETTINGS)).toEqual({
      actionClass: "read",
      operation: "hubspot.owners.list",
      title: "List HubSpot owners",
    });
  });
});
