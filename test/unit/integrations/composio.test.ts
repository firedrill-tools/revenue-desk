import { describe, expect, it, vi } from "vitest";
import type { ComposioConnection } from "../../../src/contracts/integration.js";
import {
  ComposioConnector,
  ComposioConnectors,
  probeComposio,
} from "../../../src/integrations/composio/connector.js";
import { resolveComposioConfig } from "../../../src/integrations/composio/resolve.js";
import {
  allowedTools,
  type ComposioClientLike,
  type ComposioSessionLike,
  type ComposioToolkitState,
  type RevenueDeskSessionConfig,
} from "../../../src/integrations/composio/session.js";
import { createGmailIntegration } from "../../../src/integrations/gmail/definition.js";
import { GMAIL_PROFILE } from "../../../src/integrations/gmail/profile.js";
import { createGoogleCalendarIntegration } from "../../../src/integrations/google-calendar/definition.js";
import { GOOGLE_CALENDAR_PROFILE } from "../../../src/integrations/google-calendar/profile.js";
import { secret, testEnv } from "./helpers.js";

const API_KEY = "ak_unit_not_a_real_key_0123456789";
const USER_ID = "revenue-desk-unit-user";
const MCP_URL = "https://backend.composio.test/tool_router/trs_fake/mcp";

const GMAIL_ACTIVE: ComposioToolkitState = {
  slug: "gmail",
  isNoAuth: false,
  connection: { isActive: true, connectedAccount: { id: "ca_ABCDEFGHc6M", status: "ACTIVE" } },
};
const CALENDAR_EXPIRED: ComposioToolkitState = {
  slug: "googlecalendar",
  isNoAuth: false,
  connection: { isActive: false, connectedAccount: { id: "ca_EXPIRED123", status: "EXPIRED" } },
};

function fakeComposio(
  options: {
    mcp?: Partial<ComposioSessionLike["mcp"]>;
    toolkits?: ComposioToolkitState[] | Error;
  } = {},
) {
  const sessions: ComposioSessionLike[] = [];
  const createSession = vi.fn(async (_userId: string, _config: RevenueDeskSessionConfig) => {
    const session: ComposioSessionLike = {
      sessionId: `s${sessions.length}`,
      mcp: { url: MCP_URL, type: "http", headers: { "x-api-key": API_KEY }, ...options.mcp },
      toolkits: vi.fn(async () => {
        if (options.toolkits instanceof Error) throw options.toolkits;
        return { items: options.toolkits ?? [GMAIL_ACTIVE, CALENDAR_EXPIRED] };
      }),
      authorize: vi.fn(async () => ({
        id: "cr_1",
        redirectUrl: "https://connect.composio.test/link/1",
      })),
    };
    sessions.push(session);
    return session;
  });
  const client: ComposioClientLike = { createSession };
  return { client, createSession, sessions };
}

function gmailConnection(baseUrl = "https://backend.composio.dev"): ComposioConnection<"gmail"> {
  return {
    integration: "gmail",
    kind: "composio",
    profile: "composio",
    endpointLabel: new URL(baseUrl).host,
    composio: { apiKey: secret(API_KEY), userId: USER_ID, baseUrl, toolkit: "gmail" },
  };
}

function calendarConnection(): ComposioConnection<"google_calendar"> {
  const gmail = gmailConnection();
  return {
    ...gmail,
    integration: "google_calendar",
    composio: { ...gmail.composio, toolkit: "googlecalendar" },
  };
}

describe("resolveComposioConfig and the definitions' resolve", () => {
  it("needs a key and a user id, with no default user", () => {
    expect(resolveComposioConfig(testEnv())).toEqual({
      status: "not_configured",
      missing: ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID"],
    });
    expect(resolveComposioConfig(testEnv({ composio: { apiKey: secret(API_KEY) } }))).toEqual({
      status: "not_configured",
      missing: ["COMPOSIO_USER_ID"],
    });
  });

  it("refuses unsafe base URLs and odd user ids", () => {
    expect(
      resolveComposioConfig(
        testEnv({
          composio: {
            apiKey: secret(API_KEY),
            userId: USER_ID,
            baseUrl: "http://backend.composio.dev",
          },
        }),
      ),
    ).toMatchObject({ status: "invalid", problems: [{ variable: "COMPOSIO_BASE_URL" }] });
    expect(
      resolveComposioConfig(testEnv({ composio: { apiKey: secret(API_KEY), userId: " u " } })),
    ).toMatchObject({
      status: "invalid",
      problems: [{ variable: "COMPOSIO_USER_ID" }],
    });
  });

  it("resolves Gmail and Calendar to their toolkits from one configuration", () => {
    const env = testEnv({
      composio: {
        apiKey: secret(API_KEY),
        userId: USER_ID,
        baseUrl: "http://127.0.0.1:4450/composio",
      },
    });
    expect(createGmailIntegration().resolve(env)).toMatchObject({
      status: "configured",
      connection: {
        integration: "gmail",
        kind: "composio",
        profile: "composio",
        endpointLabel: "127.0.0.1:4450",
        composio: { userId: USER_ID, baseUrl: "http://127.0.0.1:4450/composio", toolkit: "gmail" },
      },
    });
    expect(createGoogleCalendarIntegration().resolve(env)).toMatchObject({
      status: "configured",
      connection: { integration: "google_calendar", composio: { toolkit: "googlecalendar" } },
    });
    expect(JSON.stringify(createGmailIntegration().resolve(env))).not.toContain(API_KEY);
  });
});

describe("profiles", () => {
  it("equal the session allowlists", () => {
    expect(Object.keys(GMAIL_PROFILE.tools)).toEqual(allowedTools("gmail", "outbound"));
    expect(Object.keys(GOOGLE_CALENDAR_PROFILE.tools)).toEqual(
      allowedTools("googlecalendar", "outbound"),
    );
    const gmail = createGmailIntegration();
    expect(gmail.allowlist("read")).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_LIST_THREADS",
      "GMAIL_LIST_LABELS",
    ]);
    expect(gmail.allowlist("draft")).not.toContain("GMAIL_SEND_DRAFT");
    expect(gmail.allowlist("outbound")).toContain("GMAIL_SEND_DRAFT");
    expect(createGoogleCalendarIntegration().allowlist("draft")).not.toContain(
      "GOOGLECALENDAR_CREATE_EVENT",
    );
  });
});

describe("ComposioConnector", () => {
  it("creates a session per (toolkits, access) and returns its MCP endpoint with allowlists", async () => {
    const fake = fakeComposio();
    const connector = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "https://backend.composio.dev" },
      { client: fake.client },
    );
    const upstream = await connector.upstream(["gmail", "googlecalendar"], "outbound");
    expect(upstream).toEqual({
      config: { transport: "http", url: MCP_URL, headers: { "x-api-key": API_KEY } },
      allowlists: {
        gmail: allowedTools("gmail", "outbound"),
        googlecalendar: allowedTools("googlecalendar", "outbound"),
      },
      endpointLabel: "backend.composio.test",
    });
    expect(fake.createSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ toolkits: ["gmail", "googlecalendar"] }),
    );

    const readOnly = await connector.upstream(["gmail"], "read");
    expect(readOnly.allowlists).toEqual({ gmail: allowedTools("gmail", "read") });
    expect(fake.createSession).toHaveBeenLastCalledWith(
      USER_ID,
      expect.objectContaining({
        toolkits: ["gmail"],
        tools: { gmail: { enable: allowedTools("gmail", "read") } },
      }),
    );
    await connector.upstream(["gmail", "googlecalendar"], "outbound");
    expect(fake.createSession).toHaveBeenCalledTimes(2);
  });

  it("refuses an SSE endpoint, which the gateway does not connect to", async () => {
    const fake = fakeComposio({ mcp: { type: "sse" } });
    const connector = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "https://backend.composio.dev" },
      { client: fake.client },
    );
    await expect(connector.upstream(["gmail"], "read")).rejects.toMatchObject({ code: "upstream" });
  });

  it("allows a loopback http endpoint only when the base URL is loopback", async () => {
    const loopbackMcp = "http://127.0.0.1:4450/tool_router/trs_1/mcp";
    const local = fakeComposio({ mcp: { url: loopbackMcp } });
    const fakes = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "http://127.0.0.1:4450" },
      { client: local.client },
    );
    await expect(fakes.upstream(["gmail"], "read")).resolves.toMatchObject({
      config: { url: loopbackMcp },
      endpointLabel: "127.0.0.1:4450",
    });
    const production = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "https://backend.composio.dev" },
      { client: fakeComposio({ mcp: { url: loopbackMcp } }).client },
    );
    await expect(production.upstream(["gmail"], "read")).rejects.toMatchObject({
      code: "destination",
    });
  });

  it("reports per-toolkit status from a read-only session and probes map it", async () => {
    const fake = fakeComposio();
    const connector = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "https://backend.composio.dev" },
      { client: fake.client },
    );
    const signal = new AbortController().signal;
    await expect(probeComposio(connector, "gmail", signal)).resolves.toEqual({
      state: "connected",
      detail: "Gmail connected",
      accountHint: "ca_…c6M",
    });
    await expect(probeComposio(connector, "googlecalendar", signal)).resolves.toMatchObject({
      state: "expired",
    });
    // A toolkit Composio reports without a connected account needs a sign-in.
    await expect(probeComposio(connector, "quickbooks", signal)).resolves.toMatchObject({
      state: "needs_auth",
    });
    await expect(probeComposio(connector, "slack", signal)).resolves.toMatchObject({
      state: "needs_auth",
    });
    expect(fake.createSession).toHaveBeenCalledTimes(1);
    expect(fake.createSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        toolkits: ["gmail", "googlecalendar", "quickbooks", "slack"],
        tools: {
          gmail: { enable: allowedTools("gmail", "read") },
          googlecalendar: { enable: allowedTools("googlecalendar", "read") },
          quickbooks: { enable: allowedTools("quickbooks", "read") },
          slack: { enable: allowedTools("slack", "read") },
        },
      }),
    );
    expect(fake.sessions[0]?.authorize).not.toHaveBeenCalled();
  });

  it("reports a failed check as error without the key", async () => {
    const fake = fakeComposio({ toolkits: new Error(`boom ${API_KEY}`) });
    const connector = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "https://backend.composio.dev" },
      { client: fake.client },
    );
    const result = await probeComposio(connector, "gmail", new AbortController().signal);
    expect(result.state).toBe("error");
    const failing: ComposioClientLike = {
      createSession: async () => {
        throw new Error(`denied for ${API_KEY}`);
      },
    };
    const broken = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "https://backend.composio.dev" },
      { client: failing },
    );
    const failed = await probeComposio(broken, "gmail", new AbortController().signal);
    expect(failed.state).toBe("error");
    expect(failed.detail).not.toContain(API_KEY);
  });

  it("starts a sign-in only through authorize, with the given callback", async () => {
    const fake = fakeComposio();
    const connector = new ComposioConnector(
      { apiKey: secret(API_KEY), userId: USER_ID, baseUrl: "https://backend.composio.dev" },
      { client: fake.client },
    );
    await expect(
      connector.authorize(
        "googlecalendar",
        "http://127.0.0.1:4320/api/connections/google_calendar/callback",
      ),
    ).resolves.toEqual({
      redirectUrl: "https://connect.composio.test/link/1",
      connectionRequestId: "cr_1",
    });
    expect(fake.sessions[0]?.authorize).toHaveBeenCalledWith("googlecalendar", {
      callbackUrl: "http://127.0.0.1:4320/api/connections/google_calendar/callback",
    });
  });
});

describe("ComposioConnectors", () => {
  it("shares one connector between Gmail and Calendar for the same configuration", async () => {
    const fake = fakeComposio();
    const connectors = new ComposioConnectors({ client: fake.client });
    const gmail = createGmailIntegration(connectors);
    const calendar = createGoogleCalendarIntegration(connectors);
    expect(gmail.connector(gmailConnection())).toBe(calendar.connector(calendarConnection()));
    const signal = new AbortController().signal;
    await expect(gmail.probe(gmailConnection(), signal)).resolves.toMatchObject({
      state: "connected",
    });
    await expect(calendar.probe(calendarConnection(), signal)).resolves.toMatchObject({
      state: "expired",
    });
    expect(fake.createSession).toHaveBeenCalledTimes(1);
  });

  it("keeps separate connectors for different users, keys or base URLs", () => {
    const connectors = new ComposioConnectors({ client: fakeComposio().client });
    const base = gmailConnection();
    const other = connectors.forConnection({
      ...base,
      composio: { ...base.composio, userId: "someone-else" },
    });
    const otherKey = connectors.forConnection({
      ...base,
      composio: { ...base.composio, apiKey: secret("ak_other_key_000000") },
    });
    const otherUrl = connectors.forConnection(gmailConnection("http://127.0.0.1:4450"));
    expect(new Set([connectors.forConnection(base), other, otherKey, otherUrl]).size).toBe(4);
  });
});
