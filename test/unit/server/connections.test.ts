// The server's ConnectionService over the production integrations
// (createIntegrations) with a fake Composio client: statuses, checks and run
// plans come from the integrations' registry rules, and Connect goes through
// each Composio integration's own connector (Gmail, Calendar, QuickBooks,
// Slack), sharing its Composio session with the checks. Nothing but Connect
// ever starts a sign-in.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEnv } from "../../../src/contracts/env.js";
import type {
  ComposioClientLike,
  ComposioSessionLike,
  ComposioToolkitState,
  RevenueDeskSessionConfig,
} from "../../../src/integrations/composio/session.js";
import { connectionSnapshot, createIntegrations } from "../../../src/integrations/registry.js";
import { ConnectionService } from "../../../src/server/connections.js";
import {
  cleanupAll,
  openTestDatabase,
  secret,
  TEST_SECRET,
  tempStateDir,
  testEnv,
  testRedact,
} from "./harness.js";

afterEach(cleanupAll);

const NOW = new Date("2026-09-28T12:00:00.000Z");

const CONNECTED_GMAIL: ComposioToolkitState = {
  slug: "gmail",
  isNoAuth: false,
  connection: { isActive: true, connectedAccount: { id: "ca_gmail_000111", status: "ACTIVE" } },
};
const UNCONNECTED_CALENDAR: ComposioToolkitState = { slug: "googlecalendar", isNoAuth: false };
const UNCONNECTED_QUICKBOOKS: ComposioToolkitState = { slug: "quickbooks", isNoAuth: false };
const CONNECTED_SLACK: ComposioToolkitState = {
  slug: "slack",
  isNoAuth: false,
  connection: { isActive: true, connectedAccount: { id: "ca_slack_000222", status: "ACTIVE" } },
};

function composioClient(options: { readonly failAuthorize?: string } = {}) {
  const authorize = vi.fn(async (toolkit: string, request?: { callbackUrl?: string }) => {
    if (options.failAuthorize !== undefined) throw new Error(options.failAuthorize);
    return {
      id: "cr_1",
      redirectUrl: `https://connect.composio.test/link/${toolkit}?next=${request?.callbackUrl ?? ""}`,
    };
  });
  const toolkits = vi.fn(async () => ({
    items: [CONNECTED_GMAIL, UNCONNECTED_CALENDAR, UNCONNECTED_QUICKBOOKS, CONNECTED_SLACK],
  }));
  const session: ComposioSessionLike = {
    sessionId: "trs_1",
    mcp: { url: "https://backend.composio.test/mcp", type: "http", headers: {} },
    toolkits,
    authorize,
  };
  const createSession = vi.fn(
    async (_userId: string, _config: RevenueDeskSessionConfig) => session,
  );
  const client: ComposioClientLike = { createSession };
  return { client, createSession, authorize, toolkits };
}

function composioEnv(): AgentEnv {
  const env = testEnv(tempStateDir());
  return {
    ...env,
    composio: {
      apiKey: secret(TEST_SECRET),
      userId: "user_test",
      baseUrl: "https://backend.composio.dev",
    },
  };
}

function service(client: ComposioClientLike, env = composioEnv()) {
  const catalog = createIntegrations({ composio: { client } });
  const connections = new ConnectionService({
    db: openTestDatabase().db,
    env,
    integrations: Object.values(catalog),
    redact: testRedact,
    now: () => NOW,
  });
  return { connections, catalog, env };
}

describe("ConnectionService over the production integrations", () => {
  it("checks Composio through the integration and plans runs with the registry's rule", async () => {
    const fake = composioClient();
    const { connections, catalog, env } = service(fake.client);
    connections.syncConfiguration();
    expect(connections.get("gmail")).toMatchObject({
      state: "unknown",
      detail: "Not checked yet.",
      canConnect: true,
    });
    expect(connections.get("stripe")).toMatchObject({
      state: "not_configured",
      detail: "Not configured. Set STRIPE_SECRET_KEY.",
      missing: ["STRIPE_SECRET_KEY"],
      canConnect: false,
    });

    await connections.checkAll();
    expect(connections.get("gmail")).toMatchObject({
      state: "connected",
      accountHint: "ca_…111",
      checkedAt: NOW.toISOString(),
      canConnect: false,
    });
    expect(connections.get("google_calendar")).toMatchObject({
      state: "needs_auth",
      canConnect: true,
    });
    // QuickBooks and Slack are Composio toolkits of the same session.
    expect(connections.get("quickbooks")).toMatchObject({
      kind: "composio",
      state: "needs_auth",
      detail: "QuickBooks Online is not connected. Click Connect in Connections to sign in.",
      canConnect: true,
    });
    expect(connections.get("slack")).toMatchObject({
      kind: "composio",
      state: "connected",
      accountHint: "ca_…222",
      canConnect: false,
    });

    // The run plan equals the registry's snapshot for the same checks.
    const { plans, snapshot } = connections.plans();
    const expected = connectionSnapshot(catalog, env, {
      gmail: { state: "connected", detail: "Gmail connected" },
      google_calendar: {
        state: "needs_auth",
        detail: "Google Calendar is not connected. Click Connect in Connections to sign in.",
      },
      quickbooks: {
        state: "needs_auth",
        detail: "QuickBooks Online is not connected. Click Connect in Connections to sign in.",
      },
      slack: { state: "connected", detail: "Slack connected" },
    });
    expect(plans).toEqual(expected.plans);
    expect(snapshot).toEqual(expected.connections);
    expect(plans.find((plan) => plan.integration === "google_calendar")).toMatchObject({
      status: "unavailable",
      state: "needs_auth",
    });
    expect(fake.authorize).not.toHaveBeenCalled();
  });

  it("connects through the integration's connector, on the session its checks use", async () => {
    const fake = composioClient();
    const { connections } = service(fake.client);
    await connections.check("google_calendar");
    const outcome = await connections.connect(
      "google_calendar",
      "http://127.0.0.1:4320/connections?connected=google_calendar",
    );
    expect(outcome).toEqual({
      ok: true,
      redirectUrl:
        "https://connect.composio.test/link/googlecalendar?next=http://127.0.0.1:4320/connections?connected=google_calendar",
    });
    expect(fake.authorize).toHaveBeenCalledTimes(1);
    expect(fake.authorize).toHaveBeenCalledWith("googlecalendar", {
      callbackUrl: "http://127.0.0.1:4320/connections?connected=google_calendar",
    });
    // One Composio session, shared by the check and Connect: no second session manager.
    expect(fake.createSession).toHaveBeenCalledTimes(1);
  });

  it("connects QuickBooks and Slack through Composio like Gmail and Calendar", async () => {
    const fake = composioClient();
    const { connections } = service(fake.client);
    for (const [integration, toolkit] of [
      ["quickbooks", "quickbooks"],
      ["slack", "slack"],
    ] as const) {
      const callback = `http://127.0.0.1:4320/connections?connected=${integration}`;
      expect(await connections.connect(integration, callback)).toEqual({
        ok: true,
        redirectUrl: `https://connect.composio.test/link/${toolkit}?next=${callback}`,
      });
      expect(fake.authorize).toHaveBeenLastCalledWith(toolkit, { callbackUrl: callback });
    }
    expect(fake.authorize).toHaveBeenCalledTimes(2);
  });

  it("offers Connect only for configured Composio integrations and reports failures redacted", async () => {
    const refused = composioClient();
    const { connections } = service(refused.client);
    expect(await connections.connect("stripe", "http://127.0.0.1:4320/connections")).toMatchObject({
      ok: false,
      code: "not_supported",
    });
    const unconfigured = service(composioClient().client, testEnv(tempStateDir())).connections;
    expect(await unconfigured.connect("gmail", "http://127.0.0.1:4320/connections")).toMatchObject({
      ok: false,
      code: "not_supported",
    });
    expect(refused.authorize).not.toHaveBeenCalled();

    const failing = composioClient({ failAuthorize: `rejected key ${TEST_SECRET}` });
    const outcome = await service(failing.client).connections.connect(
      "gmail",
      "http://127.0.0.1:4320/connections",
    );
    expect(outcome).toMatchObject({ ok: false, code: "upstream_error" });
    expect(JSON.stringify(outcome)).not.toContain(TEST_SECRET);
  });
});
