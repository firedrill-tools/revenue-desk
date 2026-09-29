import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  allowedTools,
  buildSessionConfig,
  COMPOSIO_ALLOWLISTS,
  COMPOSIO_TOOLKITS,
  type ComposioClientLike,
  ComposioSessionError,
  type ComposioSessionLike,
  ComposioSessionManager,
  type ComposioToolkitState,
  describeEndpoint,
  maskAccountId,
  type RevenueDeskSessionConfig,
  stderrComposioLogger,
  toConnectionStatus,
} from "../../src/integrations/composio/session.js";

const API_KEY = "ak_test_not_a_real_key_0123456789";
const USER_ID = "revenue-desk-test-user";
const MCP_URL = "https://backend.composio.test/tool_router/trs_stub/mcp";

interface StubSessionOptions {
  mcp?: Partial<ComposioSessionLike["mcp"]>;
  pages?: Array<{ items: ComposioToolkitState[]; cursor?: string }>;
  redirectUrl?: string | null;
}

function stubSession(id: string, options: StubSessionOptions = {}) {
  const pages = options.pages ?? [{ items: [] }];
  let page = 0;
  const session = {
    sessionId: id,
    mcp: { url: MCP_URL, type: "http" as const, headers: { "x-api-key": API_KEY }, ...options.mcp },
    toolkits: vi.fn(async () => {
      const result = pages[Math.min(page, pages.length - 1)] ?? { items: [] };
      page += 1;
      return result;
    }),
    authorize: vi.fn(async () => ({
      id: "cr_stub_request",
      redirectUrl:
        options.redirectUrl === undefined
          ? "https://connect.composio.test/link/abc"
          : options.redirectUrl,
    })),
  };
  return session;
}

function stubClient(make: (index: number) => ComposioSessionLike | Promise<ComposioSessionLike>) {
  let index = 0;
  const createSession = vi.fn(async (_userId: string, _config: RevenueDeskSessionConfig) => {
    const current = index;
    index += 1;
    return make(current);
  });
  const client: ComposioClientLike = { createSession };
  return { client, createSession };
}

function manager(client: ComposioClientLike, extra: { now?: () => number } = {}) {
  return new ComposioSessionManager({ apiKey: API_KEY, userId: USER_ID, client, ...extra });
}

describe("allowlists and session config", () => {
  it("names only tools of their own toolkit, once each", () => {
    for (const toolkit of COMPOSIO_TOOLKITS) {
      const slugs = COMPOSIO_ALLOWLISTS[toolkit].map((entry) => entry.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const slug of slugs) expect(slug.startsWith(`${toolkit.toUpperCase()}_`)).toBe(true);
    }
  });

  it("matches the captured Composio surface exactly", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../fixtures/surfaces/composio-direct.json", import.meta.url), "utf8"),
    ) as { toolkits: Record<string, { tools: Array<{ name: string; inputSchema: unknown }> }> };
    for (const toolkit of COMPOSIO_TOOLKITS) {
      const captured = fixture.toolkits[toolkit]?.tools.map((tool) => tool.name).sort();
      expect(captured).toEqual(allowedTools(toolkit, "outbound").sort());
      for (const tool of fixture.toolkits[toolkit]?.tools ?? []) {
        expect(tool.inputSchema).toMatchObject({ type: "object" });
      }
    }
  });

  it("defaults to all four toolkits with reads and internal writes only", () => {
    expect(buildSessionConfig()).toEqual({
      toolkits: ["gmail", "googlecalendar", "quickbooks", "slack"],
      tools: {
        gmail: {
          enable: [
            "GMAIL_FETCH_EMAILS",
            "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
            "GMAIL_LIST_THREADS",
            "GMAIL_LIST_LABELS",
            "GMAIL_CREATE_EMAIL_DRAFT",
            "GMAIL_ADD_LABEL_TO_EMAIL",
          ],
        },
        googlecalendar: {
          enable: [
            "GOOGLECALENDAR_EVENTS_LIST",
            "GOOGLECALENDAR_FIND_FREE_SLOTS",
            "GOOGLECALENDAR_FIND_EVENT",
          ],
        },
        quickbooks: {
          enable: [
            "QUICKBOOKS_GET_COMPANY_INFO",
            "QUICKBOOKS_QUERY_CUSTOMERS",
            "QUICKBOOKS_READ_CUSTOMER",
            "QUICKBOOKS_QUERY_INVOICES",
            "QUICKBOOKS_READ_INVOICE",
            "QUICKBOOKS_QUERY_PAYMENTS",
            "QUICKBOOKS_QUERY_ITEMS",
            "QUICKBOOKS_GET_AGED_RECEIVABLES_REPORT",
            "QUICKBOOKS_CREATE_CUSTOMER",
          ],
        },
        slack: {
          enable: [
            "SLACK_FIND_CHANNELS",
            "SLACK_LIST_ALL_CHANNELS",
            "SLACK_FETCH_CONVERSATION_HISTORY",
            "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
            "SLACK_FIND_USERS",
            "SLACK_ADD_REACTION_TO_AN_ITEM",
          ],
        },
      },
      sessionPreset: "direct_tools",
      manageConnections: false,
      sandbox: { enable: false },
      mcp: true,
    });
  });

  it("never enables the workbench, router meta-tools or unlisted tools", () => {
    const config = buildSessionConfig({ access: "outbound" });
    expect(config).not.toHaveProperty("workbench");
    expect(config).not.toHaveProperty("tags");
    expect(config).not.toHaveProperty("preload");
    const enabled = Object.values(config.tools ?? {}).flatMap((entry) =>
      Array.isArray(entry) ? entry : "enable" in entry ? entry.enable : [],
    );
    expect(enabled.some((slug) => slug.startsWith("COMPOSIO_"))).toBe(false);
    expect(enabled).toHaveLength(31);
  });

  it("offers outbound tools only when asked", () => {
    expect(allowedTools("gmail", "read")).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_LIST_THREADS",
      "GMAIL_LIST_LABELS",
    ]);
    expect(allowedTools("gmail")).not.toContain("GMAIL_SEND_DRAFT");
    expect(allowedTools("gmail", "outbound")).toContain("GMAIL_SEND_DRAFT");
    expect(allowedTools("googlecalendar")).not.toContain("GOOGLECALENDAR_CREATE_EVENT");
    // QuickBooks invoices and payments, and Slack posts, are outbound-level: they move
    // money or reach other people. A QuickBooks customer and a Slack reaction are internal.
    expect(allowedTools("quickbooks", "read")).not.toContain("QUICKBOOKS_CREATE_CUSTOMER");
    expect(allowedTools("quickbooks", "draft")).toContain("QUICKBOOKS_CREATE_CUSTOMER");
    expect(allowedTools("quickbooks", "draft")).not.toContain("QUICKBOOKS_CREATE_INVOICE");
    expect(allowedTools("quickbooks", "outbound")).toEqual(
      expect.arrayContaining(["QUICKBOOKS_CREATE_INVOICE", "QUICKBOOKS_CREATE_PAYMENT"]),
    );
    expect(allowedTools("slack", "draft")).toContain("SLACK_ADD_REACTION_TO_AN_ITEM");
    expect(allowedTools("slack", "draft")).not.toContain("SLACK_SEND_MESSAGE");
    expect(allowedTools("slack", "outbound")).toContain("SLACK_SEND_MESSAGE");
    // Neither toolkit's catalog can email or void an invoice, and the deprecated post is out.
    for (const access of ["read", "draft", "outbound"] as const) {
      const offered = [...allowedTools("quickbooks", access), ...allowedTools("slack", access)];
      expect(offered.some((slug) => /SEND_INVOICE|VOID|DELETE|CHAT_POST_MESSAGE/.test(slug))).toBe(
        false,
      );
    }
  });

  it("keeps a canonical toolkit order and rejects bad selections", () => {
    expect(
      buildSessionConfig({ toolkits: ["slack", "googlecalendar", "gmail", "quickbooks", "gmail"] })
        .toolkits,
    ).toEqual(["gmail", "googlecalendar", "quickbooks", "slack"]);
    expect(buildSessionConfig({ toolkits: ["googlecalendar"] }).tools).not.toHaveProperty("gmail");
    expect(() => buildSessionConfig({ toolkits: [] })).toThrow(ComposioSessionError);
    expect(() => buildSessionConfig({ toolkits: ["hubspot" as never] })).toThrow(/Unsupported/);
    expect(() => buildSessionConfig({ access: "admin" as never })).toThrow(/access level/);
    expect(() => buildSessionConfig({ access: "toString" as never })).toThrow(/access level/);
  });
});

describe("ComposioSessionManager", () => {
  it("requires an API key and a user id, with no defaults", () => {
    const { client } = stubClient((i) => stubSession(`s${i}`));
    expect(() => new ComposioSessionManager({ apiKey: API_KEY, userId: "", client })).toThrow(
      /COMPOSIO_USER_ID/,
    );
    expect(() => new ComposioSessionManager({ apiKey: "", userId: USER_ID, client })).toThrow(
      /COMPOSIO_API_KEY/,
    );
  });

  it("creates one session for the configured user and reuses it", async () => {
    const { client, createSession } = stubClient((i) => stubSession(`s${i}`));
    const sessions = manager(client);
    const [a, b] = await Promise.all([sessions.getSession(), sessions.getSession()]);
    const c = await sessions.getSession();
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(USER_ID, buildSessionConfig());
  });

  it("uses the selection given at construction", async () => {
    const { client, createSession } = stubClient((i) => stubSession(`s${i}`));
    const sessions = new ComposioSessionManager({
      apiKey: API_KEY,
      userId: USER_ID,
      client,
      selection: { toolkits: ["gmail"], access: "read" },
    });
    await sessions.mcpEndpoint();
    expect(createSession).toHaveBeenCalledWith(
      USER_ID,
      buildSessionConfig({ toolkits: ["gmail"], access: "read" }),
    );
  });

  it("keeps separate sessions per access level and toolkit set", async () => {
    const { client, createSession } = stubClient((i) => stubSession(`s${i}`));
    const sessions = manager(client);
    const draft = await sessions.getSession();
    const outbound = await sessions.getSession({ access: "outbound" });
    const gmailOnly = await sessions.getSession({ toolkits: ["gmail"] });
    expect(new Set([draft, outbound, gmailOnly]).size).toBe(3);
    expect(createSession).toHaveBeenCalledTimes(3);
  });

  it("expires cached sessions after the TTL, and on fresh or reset", async () => {
    let now = 1_000;
    const { client, createSession } = stubClient((i) => stubSession(`s${i}`));
    const sessions = manager(client, { now: () => now });
    const first = await sessions.getSession();
    now += 29 * 60 * 1000;
    expect(await sessions.getSession()).toBe(first);
    now += 60 * 1000 + 1;
    const second = await sessions.getSession();
    expect(second).not.toBe(first);
    const third = await sessions.getSession(undefined, true);
    expect(third).not.toBe(second);
    sessions.reset();
    await sessions.getSession();
    expect(createSession).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failed creation and never echoes the key", async () => {
    let fail = true;
    const { client, createSession } = stubClient((i) => {
      if (fail) throw new Error(`upstream said no for key ${API_KEY}`);
      return stubSession(`s${i}`);
    });
    const sessions = manager(client);
    const error = await sessions.getSession().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComposioSessionError);
    expect((error as ComposioSessionError).code).toBe("upstream");
    expect((error as Error).message).not.toContain(API_KEY);
    expect((error as Error).message).toContain("[REDACTED]");
    fail = false;
    await expect(sessions.getSession()).resolves.toMatchObject({ sessionId: "s1" });
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("keeps Composio's status and own words from an SDK error, never its JSON or the key", async () => {
    const { client } = stubClient(() => {
      const error = new Error(
        `401 {"error":{"message":"Invalid API key: ak_**6789","code":801,"slug":"APIKey_InvalidAPIKey","status":401,"suggested_fix":"Check ${API_KEY}"}}`,
      );
      throw Object.assign(error, { status: 401 });
    });
    const error = await manager(client)
      .getSession()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComposioSessionError);
    expect(error).toMatchObject({
      code: "upstream",
      status: 401,
      message: "Composio session creation failed (HTTP 401): Invalid API key: ak_**6789",
    });
  });

  it("reports a failed connection listing with its status, the key redacted", async () => {
    const session = stubSession("s0");
    session.toolkits.mockRejectedValueOnce(
      Object.assign(new Error(`503 upstream for ${API_KEY}`), { status: 503 }),
    );
    const { client } = stubClient(() => session);
    const error = await manager(client)
      .connectionStatus()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 503,
      message: "Composio did not list the connections (HTTP 503): 503 upstream for [REDACTED]",
    });
  });

  it("reports an MCP destination rejection distinctly", async () => {
    const { client } = stubClient(() => {
      const error = new Error("The session MCP endpoint origin does not match the API origin");
      error.name = "ComposioMCPDestinationError";
      throw error;
    });
    await expect(manager(client).mcpEndpoint()).rejects.toMatchObject({ code: "destination" });
  });

  it("returns the session's MCP endpoint and a loggable description without secrets", async () => {
    const { client } = stubClient((i) => stubSession(`s${i}`));
    const endpoint = await manager(client).mcpEndpoint();
    expect(endpoint).toEqual({ type: "http", url: MCP_URL, headers: { "x-api-key": API_KEY } });
    const description = describeEndpoint(endpoint);
    expect(description).toEqual({ type: "http", host: "backend.composio.test" });
    expect(JSON.stringify(description)).not.toContain(API_KEY);
    expect(JSON.stringify(description)).not.toContain("trs_stub");
  });

  it("returns a copy of the headers", async () => {
    const session = stubSession("s0");
    const { client } = stubClient(() => session);
    const endpoint = await manager(client).mcpEndpoint();
    endpoint.headers["x-api-key"] = "changed";
    expect(session.mcp.headers["x-api-key"]).toBe(API_KEY);
  });

  it("supports Composio's SSE transport and rejects anything unsafe", async () => {
    const sse = stubClient(() => stubSession("s", { mcp: { type: "sse" } }));
    await expect(manager(sse.client).mcpEndpoint()).resolves.toMatchObject({ type: "sse" });

    const http = stubClient(() =>
      stubSession("s", { mcp: { url: "http://backend.composio.test/mcp" } }),
    );
    await expect(manager(http.client).mcpEndpoint()).rejects.toMatchObject({ code: "destination" });

    const bad = stubClient(() => stubSession("s", { mcp: { url: "not a url" } }));
    await expect(manager(bad.client).mcpEndpoint()).rejects.toMatchObject({ code: "destination" });

    const ws = stubClient(() => stubSession("s", { mcp: { type: "ws" as never } }));
    await expect(manager(ws.client).mcpEndpoint()).rejects.toMatchObject({ code: "upstream" });
  });

  it("refuses a session endpoint on this machine or a private network, HTTPS or not", async () => {
    const endpoint = (url: string) => {
      const { client } = stubClient(() => stubSession("s", { mcp: { url } }));
      return manager(client).mcpEndpoint();
    };
    for (const url of [
      "http://127.0.0.1:4450/tool_router/trs_stub/mcp",
      "https://127.0.0.1:4450/tool_router/trs_stub/mcp",
      "https://localhost/tool_router/trs_stub/mcp",
      "https://composio.localhost/tool_router/trs_stub/mcp",
      "https://0x7f.1/tool_router/trs_stub/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://172.20.0.2/tool_router/trs_stub/mcp",
      "https://[::ffff:127.0.0.1]/tool_router/trs_stub/mcp",
      "https://[fe80::1]/tool_router/trs_stub/mcp",
      "https://mcp-server/tool_router/trs_stub/mcp",
    ]) {
      await expect(endpoint(url), url).rejects.toMatchObject({ code: "destination" });
    }
    const refused = await endpoint("https://10.0.0.8/mcp").catch((error: unknown) => error);
    expect(String(refused)).toContain("points at this machine or a private network");
    await expect(endpoint(MCP_URL)).resolves.toMatchObject({ url: MCP_URL });
  });
});

describe("connection status", () => {
  const active: ComposioToolkitState = {
    slug: "gmail",
    isNoAuth: false,
    connection: { isActive: true, connectedAccount: { id: "ca_ABCDEFGHc6M", status: "ACTIVE" } },
  };

  it("maps Composio states onto connected, needs_auth and expired", () => {
    expect(toConnectionStatus("gmail", active)).toEqual({
      toolkit: "gmail",
      state: "connected",
      accountStatus: "active",
      accountHint: "ca_…c6M",
      detail: "Gmail connected",
    });
    expect(
      toConnectionStatus("googlecalendar", {
        slug: "googlecalendar",
        isNoAuth: false,
        connection: {
          isActive: false,
          connectedAccount: { id: "ca_EXPIRED123", status: "EXPIRED" },
        },
      }),
    ).toMatchObject({ state: "expired", accountStatus: "expired" });
    for (const status of ["INITIATED", "INITIALIZING", "FAILED", "INACTIVE", "REVOKED"]) {
      expect(
        toConnectionStatus("gmail", {
          slug: "gmail",
          isNoAuth: false,
          connection: { isActive: false, connectedAccount: { id: "ca_PENDING123", status } },
        }),
      ).toMatchObject({ state: "needs_auth", accountStatus: status.toLowerCase() });
    }
    expect(
      toConnectionStatus("gmail", {
        slug: "gmail",
        isNoAuth: false,
        connection: { isActive: false },
      }),
    ).toMatchObject({ state: "needs_auth", accountStatus: null, accountHint: null });
    expect(toConnectionStatus("gmail", { slug: "gmail", isNoAuth: false })).toMatchObject({
      state: "needs_auth",
    });
    expect(toConnectionStatus("gmail", undefined)).toMatchObject({ state: "needs_auth" });
    expect(toConnectionStatus("gmail", { slug: "gmail", isNoAuth: true })).toMatchObject({
      state: "connected",
    });
  });

  it("names each toolkit and whose sign-in Composio holds for it", () => {
    expect(toConnectionStatus("quickbooks", { slug: "quickbooks", isNoAuth: false })).toEqual({
      toolkit: "quickbooks",
      state: "needs_auth",
      accountStatus: null,
      accountHint: null,
      detail: "QuickBooks Online is not connected. Click Connect in Connections to sign in.",
    });
    expect(
      toConnectionStatus("quickbooks", {
        slug: "quickbooks",
        isNoAuth: false,
        connection: {
          isActive: false,
          connectedAccount: { id: "ca_QBOEXPIRED1", status: "EXPIRED" },
        },
      }).detail,
    ).toBe(
      "QuickBooks Online's Intuit sign-in expired. Click Connect in Connections to sign in again.",
    );
    expect(
      toConnectionStatus("slack", {
        slug: "slack",
        isNoAuth: false,
        connection: {
          isActive: false,
          connectedAccount: { id: "ca_SLACKINIT1", status: "INITIATED" },
        },
      }).detail,
    ).toBe("Slack's Slack sign-in is initiated. Click Connect in Connections to finish it.");
    expect(
      toConnectionStatus("slack", {
        slug: "slack",
        isNoAuth: false,
        connection: { isActive: true, connectedAccount: { id: "ca_SLACKOK123", status: "ACTIVE" } },
      }),
    ).toMatchObject({ state: "connected", detail: "Slack connected", accountHint: "ca_…123" });
    expect(toConnectionStatus("googlecalendar", undefined).detail).toBe(
      "Google Calendar was not reported by Composio for this session",
    );
  });

  it("does not treat an active flag with a non-active account as connected", () => {
    expect(
      toConnectionStatus("gmail", {
        slug: "gmail",
        isNoAuth: false,
        connection: { isActive: true, connectedAccount: { id: "ca_ODDSTATE1", status: "EXPIRED" } },
      }),
    ).toMatchObject({ state: "expired" });
  });

  it("masks account ids", () => {
    expect(maskAccountId("ca_1234567890c6M")).toBe("ca_…c6M");
    expect(maskAccountId("short")).toBe("…");
  });

  it("reads every page for the session's toolkits and never starts a sign-in", async () => {
    const session = stubSession("s0", {
      pages: [
        { items: [active], cursor: "next" },
        {
          items: [
            {
              slug: "googlecalendar",
              isNoAuth: false,
              connection: {
                isActive: false,
                connectedAccount: { id: "ca_EXPIRED123", status: "EXPIRED" },
              },
            },
          ],
        },
      ],
    });
    const { client } = stubClient(() => session);
    const status = await manager(client).connectionStatus();
    expect(status.gmail.state).toBe("connected");
    expect(status.googlecalendar.state).toBe("expired");
    expect(status.quickbooks.state).toBe("needs_auth");
    expect(status.slack.state).toBe("needs_auth");
    const all = ["gmail", "googlecalendar", "quickbooks", "slack"];
    expect(session.toolkits).toHaveBeenNthCalledWith(1, { toolkits: all });
    expect(session.toolkits).toHaveBeenNthCalledWith(2, { toolkits: all, cursor: "next" });
    expect(session.authorize).not.toHaveBeenCalled();
  });
});

describe("authorize", () => {
  it("returns the redirect URL for the user to open", async () => {
    const session = stubSession("s0");
    const { client } = stubClient(() => session);
    const result = await manager(client).authorize(
      "googlecalendar",
      "http://127.0.0.1:4320/api/connections/composio/callback",
    );
    expect(result).toEqual({
      redirectUrl: "https://connect.composio.test/link/abc",
      connectionRequestId: "cr_stub_request",
    });
    expect(session.authorize).toHaveBeenCalledWith("googlecalendar", {
      callbackUrl: "http://127.0.0.1:4320/api/connections/composio/callback",
    });
  });

  it("rejects bad callbacks, unknown toolkits and toolkits outside the session", async () => {
    const session = stubSession("s0");
    const { client } = stubClient(() => session);
    const sessions = manager(client);
    await expect(sessions.authorize("gmail", "javascript:alert(1)")).rejects.toMatchObject({
      code: "config",
    });
    await expect(sessions.authorize("gmail", "not a url")).rejects.toMatchObject({
      code: "config",
    });
    await expect(sessions.authorize("hubspot" as never, "https://x.test/cb")).rejects.toThrow(
      /Unsupported/,
    );
    const gmailOnly = new ComposioSessionManager({
      apiKey: API_KEY,
      userId: USER_ID,
      client,
      selection: { toolkits: ["gmail"] },
    });
    await expect(gmailOnly.authorize("googlecalendar", "https://x.test/cb")).rejects.toThrow(
      /not in this session/,
    );
    expect(session.authorize).not.toHaveBeenCalled();
  });

  it("refuses a sign-in link that is not HTTPS on a public host", async () => {
    for (const link of [
      "http://connect.composio.test/link/abc",
      "https://127.0.0.1:4390/link/abc",
      "https://localhost/link/abc",
      "https://192.168.1.20/link/abc",
      "https://[::1]/link/abc",
      "https://user:pw@connect.composio.test/link/abc",
      "javascript:alert(1)",
    ]) {
      const session = stubSession("s0", { redirectUrl: link });
      const { client } = stubClient(() => session);
      await expect(
        manager(client).authorize("gmail", "https://x.test/cb"),
        link,
      ).rejects.toMatchObject({ code: "destination" });
    }
  });

  it("fails clearly when Composio returns no link", async () => {
    const { client } = stubClient(() => stubSession("s0", { redirectUrl: null }));
    await expect(manager(client).authorize("gmail", "https://x.test/cb")).rejects.toMatchObject({
      code: "no_redirect",
    });
  });
});

describe("stderr logger", () => {
  it("writes Composio log lines to stderr, never stdout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write");
    stderrComposioLogger.info("Upgrade available %s", "x");
    stderrComposioLogger.warn("warned");
    expect(stderr).toHaveBeenCalledWith("Upgrade available x\n");
    expect(stderr).toHaveBeenCalledWith("warned\n");
    expect(stdout).not.toHaveBeenCalled();
  });
});
