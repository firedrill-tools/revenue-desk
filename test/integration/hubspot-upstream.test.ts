/**
 * The HubSpot integration against the real @hubspot/mcp-server 0.4.0 over
 * stdio: a resolved connection with a dummy token becomes the gateway's
 * upstream configuration, the server lists the 10 allowlisted tools with their
 * captured schemas, and the read-only probe reports connected or needs_auth
 * against a loopback fake of the HubSpot API. Every child preloads
 * test/support/deny-network.mjs, so nothing can reach HubSpot.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HubSpotConnection } from "../../src/contracts/integration.js";
import { connectUpstream, type UpstreamConfig } from "../../src/gateway/mcp-proxy.js";
import { classifyHubSpot } from "../../src/integrations/hubspot/classify.js";
import { type ConnectUpstream, probeHubSpot } from "../../src/integrations/hubspot/probe.js";
import { HUBSPOT_TOOL_NAMES } from "../../src/integrations/hubspot/profile.js";
import { resolveHubSpot } from "../../src/integrations/hubspot/resolve.js";
import { hubspotUpstreamConfig } from "../../src/integrations/hubspot/upstream.js";
import { createClock } from "../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../support/fakes/fixtures.js";
import { HubSpotFake } from "../support/fakes/hubspot/index.js";
import { SETTINGS, secret, testEnv } from "../unit/integrations/helpers.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const DENY_NETWORK = pathToFileURL(join(repoRoot, "test/support/deny-network.mjs")).href;
const DENY_MARKER = "[deny-network] blocked";
const GOOD_TOKEN = "integration-dummy-token";
const REVOKED_TOKEN = "integration-revoked-token";

/** The gateway's connector, with the network guard preloaded into every stdio child. */
const guardedConnect: ConnectUpstream = (config, options) =>
  connectUpstream(guarded(config), options);

function guarded(config: UpstreamConfig): UpstreamConfig {
  if (config.transport !== "stdio") return config;
  return { ...config, env: { ...config.env, NODE_OPTIONS: `--import=${DENY_NETWORK}` } };
}

function connectionFor(token: string, apiBaseUrl: string | null): HubSpotConnection {
  const resolution = resolveHubSpot(
    testEnv({ hubspot: { accessToken: secret(token), apiBaseUrl } }),
  );
  if (resolution.status !== "configured") throw new Error(`unexpected ${resolution.status}`);
  return resolution.connection;
}

let fake: Server;
let fakeUrl: string;
const seen: Array<{ path: string; authorization: string | undefined }> = [];

beforeAll(async () => {
  fake = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({ path, authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
        res.statusCode = 401;
        res.end(
          JSON.stringify({ status: "error", message: "Authentication credentials not found." }),
        );
      } else if (path.endsWith("/oauth/v2/private-apps/get/access-token-info")) {
        res.end(
          JSON.stringify({
            userId: 101,
            hubId: 20211234,
            appId: 303,
            scopes: ["crm.objects.contacts.read"],
          }),
        );
      } else if (path.endsWith("/account-info/v3/details")) {
        res.end(JSON.stringify({ portalId: 20211234, uiDomain: "app.hubspot.test" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: "error", message: "not found" }));
      }
    });
  });
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/hubspot`;
});

afterAll(async () => {
  await new Promise<void>((done) => fake.close(() => done()));
});

describe("HubSpot stdio upstream", () => {
  it("lists the 10 allowlisted tools with their captured schemas, with a dummy token and no network", async () => {
    const fixture = JSON.parse(
      readFileSync(join(repoRoot, "test/fixtures/surfaces/hubspot-mcp-0.4.0.json"), "utf8"),
    ) as { tools: Tool[] };
    const upstream = await guardedConnect(hubspotUpstreamConfig(connectionFor(GOOD_TOKEN, null)), {
      timeoutMs: 30_000,
    });
    try {
      const allowed = upstream.tools.filter((tool) => HUBSPOT_TOOL_NAMES.includes(tool.name));
      expect(allowed.map((tool) => tool.name).sort()).toEqual([...HUBSPOT_TOOL_NAMES].sort());
      const captured = new Map(fixture.tools.map((tool) => [tool.name, tool]));
      for (const tool of allowed)
        expect(tool.inputSchema).toEqual(captured.get(tool.name)?.inputSchema);
      expect(upstream.tools).toHaveLength(21);
    } finally {
      await upstream.close();
    }
    expect(upstream.stderrTail()).not.toContain(DENY_MARKER);
  });

  it("probes connected through the real server against a loopback HubSpot fake", async () => {
    seen.length = 0;
    const result = await probeHubSpot(
      connectionFor(GOOD_TOKEN, fakeUrl),
      AbortSignal.timeout(30_000),
      {
        connect: guardedConnect,
      },
    );
    expect(result).toEqual({
      state: "connected",
      detail: "HubSpot MCP server lists all 10 profile tools; the token is accepted.",
      accountHint: "…234",
    });
    expect(seen.map((entry) => entry.path)).toContain(
      "/hubspot/oauth/v2/private-apps/get/access-token-info",
    );
    for (const entry of seen) expect(entry.authorization).toBe(`Bearer ${GOOD_TOKEN}`);
  });

  it("probes needs_auth when HubSpot rejects the token, and never shows it", async () => {
    const result = await probeHubSpot(
      connectionFor(REVOKED_TOKEN, fakeUrl),
      AbortSignal.timeout(30_000),
      {
        connect: guardedConnect,
      },
    );
    expect(result.state).toBe("needs_auth");
    expect(JSON.stringify(result)).not.toContain(REVOKED_TOKEN);
  });
});

describe("HubSpot against the HubSpot fake", () => {
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
  });

  afterAll(async () => {
    await hubspot?.close();
  });

  const httpConnection = (token: string | null) => {
    const resolution = resolveHubSpot(
      testEnv({
        hubspot: { mcpUrl: hubspot.mcpUrl, mcpToken: token === null ? null : secret(token) },
      }),
    );
    if (resolution.status !== "configured") throw new Error(`unexpected ${resolution.status}`);
    return resolution.connection;
  };

  it("probes the Streamable HTTP MCP endpoint with its bearer token", async () => {
    const connection = httpConnection(FAKE_CREDENTIALS.hubspotMcpToken);
    expect(connection.mcp.transport).toBe("http");
    await expect(
      probeHubSpot(connection, AbortSignal.timeout(30_000), { connect: guardedConnect }),
    ).resolves.toMatchObject({ state: "connected" });
    expect(hubspot.mcpCalls.map((call) => call.tool)).toContain("hubspot-get-user-details");
  });

  it("reports a rejected MCP bearer token as needs_auth and a down server as error", async () => {
    const wrong = await probeHubSpot(httpConnection("wrong-token"), AbortSignal.timeout(30_000), {
      connect: guardedConnect,
    });
    expect(wrong.state).toBe("needs_auth");
    expect(JSON.stringify(wrong)).not.toContain("wrong-token");
    hubspot.setMcpAvailable(false);
    try {
      await expect(
        probeHubSpot(
          httpConnection(FAKE_CREDENTIALS.hubspotMcpToken),
          AbortSignal.timeout(30_000),
          {
            connect: guardedConnect,
          },
        ),
      ).resolves.toMatchObject({ state: "error" });
    } finally {
      hubspot.setMcpAvailable(true);
    }
  });

  it("runs the stdio server against the fake's CRM API and creates a note in one call", async () => {
    const env = hubspot.stdioEnv();
    const connection = connectionFor(env.HUBSPOT_ACCESS_TOKEN, env.HUBSPOT_API_BASE_URL);
    await expect(
      probeHubSpot(connection, AbortSignal.timeout(30_000), { connect: guardedConnect }),
    ).resolves.toMatchObject({ state: "connected" });

    const input = {
      objectType: "notes",
      inputs: [
        {
          properties: {
            hs_note_body: "Refunded duplicate charge ch_KAhp_0922b ($490.00).",
            hs_timestamp: "2026-09-28T13:00:00Z",
          },
          associations: [],
        },
      ],
    };
    expect(classifyHubSpot("hubspot-batch-create-objects", input, SETTINGS)).toMatchObject({
      actionClass: "internal_write",
      operation: "hubspot.notes.create",
    });
    const upstream = await guardedConnect(hubspotUpstreamConfig(connection), { timeoutMs: 30_000 });
    try {
      const before = hubspot.writes().length;
      const result = await upstream.client.callTool({
        name: "hubspot-batch-create-objects",
        arguments: input,
      });
      expect(result.isError).not.toBe(true);
      expect(hubspot.writes()).toHaveLength(before + 1);
    } finally {
      await upstream.close();
    }
  });
});
