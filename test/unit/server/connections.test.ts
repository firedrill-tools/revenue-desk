// The server's ConnectionService over the production integrations
// (createIntegrations) with a stub Composio client: statuses, checks and run
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

function composioClient(
  options: { readonly failAuthorize?: string; readonly linkOrigin?: string } = {},
) {
  const authorize = vi.fn(async (toolkit: string, request?: { callbackUrl?: string }) => {
    if (options.failAuthorize !== undefined) throw new Error(options.failAuthorize);
    const origin = options.linkOrigin ?? "https://connect.composio.test";
    return {
      id: "cr_1",
      redirectUrl: `${origin}/link/${toolkit}?next=${request?.callbackUrl ?? ""}`,
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
    composio: { apiKey: secret(TEST_SECRET), userId: "user_test" },
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
    const stub = composioClient();
    const { connections, catalog, env } = service(stub.client);
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
    expect(stub.authorize).not.toHaveBeenCalled();
  });

  it("connects through the integration's connector, on the session its checks use", async () => {
    const stub = composioClient();
    const { connections } = service(stub.client);
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
    expect(stub.authorize).toHaveBeenCalledTimes(1);
    expect(stub.authorize).toHaveBeenCalledWith("googlecalendar", {
      callbackUrl: "http://127.0.0.1:4320/connections?connected=google_calendar",
    });
    // One Composio session, shared by the check and Connect: no second session manager.
    expect(stub.createSession).toHaveBeenCalledTimes(1);
  });

  it("a check that finds a newly connected account starts the next use on a fresh Composio session", async () => {
    const stub = composioClient();
    const { connections } = service(stub.client);
    await connections.check("google_calendar");
    expect(connections.get("google_calendar").state).toBe("needs_auth");
    expect(stub.createSession).toHaveBeenCalledTimes(1);

    // Still not connected: the cached session is kept.
    await connections.check("google_calendar");
    expect(stub.createSession).toHaveBeenCalledTimes(1);

    // The user connects Calendar through Composio; the next check sees it and drops the cache.
    const connectedCalendar: ComposioToolkitState = {
      slug: "googlecalendar",
      isNoAuth: false,
      connection: { isActive: true, connectedAccount: { id: "ca_cal_000333", status: "ACTIVE" } },
    };
    stub.toolkits.mockResolvedValue({
      items: [CONNECTED_GMAIL, connectedCalendar, UNCONNECTED_QUICKBOOKS, CONNECTED_SLACK],
    });
    await connections.check("google_calendar");
    expect(connections.get("google_calendar").state).toBe("connected");
    expect(stub.createSession).toHaveBeenCalledTimes(1);

    // The next use builds a fresh session, which then stays cached while nothing changes.
    await connections.check("google_calendar");
    expect(stub.createSession).toHaveBeenCalledTimes(2);
    await connections.check("google_calendar");
    expect(stub.createSession).toHaveBeenCalledTimes(2);
  });

  it("connects QuickBooks and Slack through Composio like Gmail and Calendar", async () => {
    const stub = composioClient();
    const { connections } = service(stub.client);
    for (const [integration, toolkit] of [
      ["quickbooks", "quickbooks"],
      ["slack", "slack"],
    ] as const) {
      const callback = `http://127.0.0.1:4320/connections?connected=${integration}`;
      expect(await connections.connect(integration, callback)).toEqual({
        ok: true,
        redirectUrl: `https://connect.composio.test/link/${toolkit}?next=${callback}`,
      });
      expect(stub.authorize).toHaveBeenLastCalledWith(toolkit, { callbackUrl: callback });
    }
    expect(stub.authorize).toHaveBeenCalledTimes(2);
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

  it("never hands the browser a sign-in link on this machine or a private network", async () => {
    for (const linkOrigin of ["https://127.0.0.1:4390", "https://localhost", "https://10.0.0.4"]) {
      const stub = composioClient({ linkOrigin });
      const outcome = await service(stub.client).connections.connect(
        "gmail",
        "http://127.0.0.1:4320/connections?connected=gmail",
      );
      expect(outcome, linkOrigin).toEqual({
        ok: false,
        code: "upstream_error",
        message:
          "Composio could not start the sign-in: Composio returned a sign-in link for Gmail that points at this machine or a private network; Revenue Desk does not open it",
      });
    }
  });
});
