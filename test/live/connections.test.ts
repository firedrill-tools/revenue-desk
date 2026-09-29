/**
 * Live, read-only, without the model: every configured integration answers
 * the app's Check, and each connected one answers a real read through the
 * product's run gateway, the same in-process MCP servers the model calls,
 * opened with a read-only policy (so Composio offers read tools only).
 *
 * An integration that is not connected or not configured is reported with
 * the reason and its read is skipped, or fails when LIVE_REQUIRE names it;
 * nothing stands in for it. Results hold real data, so only their size is
 * printed.
 *
 * Runs only under `LIVE_E2E=1 pnpm test:live`.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import {
  type IntegrationId,
  sdkToolName,
  type WorkspaceSettings,
} from "../../src/contracts/integration.js";
import type { JsonObject } from "../../src/contracts/json.js";
import { openRunGateway, type RunGateway } from "../../src/gateway/run-gateway.js";
import {
  connectionSnapshot,
  integrations,
  type KnownConnection,
  knownFromCheck,
} from "../../src/integrations/registry.js";
import { callWithMeta, connectClient } from "../helpers/mcp-client.js";
import {
  agentEnvOf,
  cannotTest,
  checkLive,
  describeConnections,
  type LiveConnections,
  type LiveStateDir,
  liveEnvironment,
  liveStateDir,
  requireLive,
  unavailableReason,
} from "./support.js";

requireLive();

const SETTINGS: WorkspaceSettings = {
  companyName: "",
  agentName: "Revenue Desk",
  senderName: "",
  emailSignature: "",
  internalEmailDomains: [],
  notifySlackChannel: null,
  allowedSlackChannels: [],
  internalCalendarIds: [],
  timezone: "UTC",
  currency: "USD",
  defaultModel: null,
  defaultEffort: null,
  updatedAt: new Date().toISOString(),
};

/** One small read per integration, with the fewest arguments its tool takes. */
const READS: readonly (readonly [IntegrationId, string, JsonObject])[] = [
  ["gmail", "GMAIL_LIST_LABELS", {}],
  ["google_calendar", "GOOGLECALENDAR_EVENTS_LIST", { maxResults: 1 }],
  ["quickbooks", "QUICKBOOKS_GET_COMPANY_INFO", {}],
  ["slack", "SLACK_LIST_ALL_CHANNELS", { limit: 5 }],
  ["hubspot", "hubspot-get-user-details", {}],
  ["stripe", "get_balance", {}],
];

let state: LiveStateDir | undefined;
let connections: LiveConnections;
let gateway: RunGateway;

beforeAll(async () => {
  state = liveStateDir("connections");
  const env = agentEnvOf(liveEnvironment(state.dir, ["composio", "hubspot", "stripe"]));
  connections = await checkLive(env);
  console.log(`live connections: ${describeConnections(connections)}`);
  const known: { [I in IntegrationId]?: KnownConnection } = {};
  for (const status of connections.values()) {
    const check = knownFromCheck(status.state, status.detail);
    if (check !== undefined) known[status.integration] = check;
  }
  const catalog = integrations();
  gateway = await openRunGateway({
    runId: `live_connections_${Date.now().toString(36)}`,
    plans: connectionSnapshot(catalog, env, known).plans,
    catalog,
    settings: SETTINGS,
    policy: {
      read: "auto",
      internal_write: "deny",
      outbound: "deny",
      financial: "deny",
      destructive: "deny",
    },
    signal: AbortSignal.timeout(180_000),
  });
});

afterAll(async () => {
  await gateway?.close();
  state?.cleanup();
});

describe("live: the app's Check", () => {
  it("gives every integration a definite state: none failed to answer", () => {
    expect([...connections.keys()]).toHaveLength(6);
    for (const status of connections.values()) {
      expect(["error", "unknown"], `${status.integration}: ${status.detail}`).not.toContain(
        status.state,
      );
    }
  });
});

describe("live: one read per connected integration, through the run gateway", () => {
  test.for(READS)("%s answers %s", async ([integration, tool, args], context) => {
    const reason = unavailableReason(connections, integration);
    if (reason !== null) cannotTest(context, `live gateway ${integration}`, integration, reason);
    const connection = gateway.connections.find((entry) => entry.integration === integration);
    expect(connection?.availability, connection?.detail ?? "").toBe("ready");

    const offered = gateway.registry
      .names()
      .filter((name) => name.startsWith(`mcp__${integration}__`));
    expect(offered).toContain(sdkToolName(integration, tool));
    if (connection?.kind === "composio") {
      // A read-only policy opens a read-only Composio session: no write tool exists in it.
      for (const name of offered) {
        expect(gateway.registry.get(name)?.descriptor.baseClass, name).toBe("read");
      }
    }

    const server = gateway.mcpServers()[integration];
    if (server === undefined) throw new Error(`no ${integration} server`);
    const client = await connectClient(server);
    try {
      const result: CallToolResult = await callWithMeta(
        client,
        tool,
        args,
        `toolu_live_${integration}`,
      );
      const text = (result.content ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      console.log(
        `live gateway ${integration}: ${tool} answered ${result.isError ? "an error" : "a result"} of ${text.length} characters`,
      );
      expect(result.isError, `${tool} returned an error`).not.toBe(true);
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
