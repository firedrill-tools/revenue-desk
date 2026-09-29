/**
 * The Composio fake driven by the real @composio/core 0.21 client, through
 * Revenue Desk's own ComposioSessionManager: session creation, connection
 * state, Connect links, and the session MCP endpoint serving the captured
 * direct_tools surface on the local mailbox and calendar.
 */
import type { ComposioLogger } from "@composio/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import {
  allowedTools,
  ComposioSessionManager,
} from "../../../src/integrations/composio/session.js";
import { ComposioFake, capturedComposioTools } from "../../support/fakes/composio/index.js";
import { createClock } from "../../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";

const KEY = FAKE_CREDENTIALS.composioApiKey;
const silent: ComposioLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
let composio: ComposioFake;

beforeEach(async () => {
  const fixtures = loadBusinessFixtures();
  composio = await ComposioFake.start({
    composio: fixtures.composio,
    gmail: fixtures.gmail,
    calendar: fixtures.calendar,
    clock: createClock(fixtures.company.asOf),
    apiKey: KEY,
    prefix: "/composio",
  });
});

afterEach(async () => {
  await composio.close();
});

function manager(userId = "kestrel-maya", access: "read" | "draft" | "outbound" = "outbound") {
  return new ComposioSessionManager({
    apiKey: KEY,
    userId,
    baseURL: composio.baseUrl,
    logger: silent,
    selection: { access },
  });
}

async function mcp(sessions: ComposioSessionManager): Promise<Client> {
  const endpoint = await sessions.mcpEndpoint();
  const client = new Client({ name: "composio-fake-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: endpoint.headers },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return {
    isError: result.isError === true,
    body: JSON.parse(text) as { successful: boolean; data: JsonObject; error: string | null },
  };
}

describe("Composio fake with the real @composio/core client", () => {
  it("creates a direct_tools session whose MCP endpoint is on the fake's own origin", async () => {
    const sessions = manager();
    const endpoint = await sessions.mcpEndpoint();
    expect(endpoint.type).toBe("http");
    expect(endpoint.url).toMatch(new RegExp(`^${composio.baseUrl}/tool_router/trs_RD\\d{4}/mcp$`));
    expect(endpoint.headers["x-api-key"]).toBe(KEY);
    const [session] = [...composio.sessions.values()];
    expect(session?.config).toMatchObject({
      user_id: "kestrel-maya",
      tools: {
        gmail: { enable: allowedTools("gmail", "outbound") },
        googlecalendar: { enable: allowedTools("googlecalendar", "outbound") },
      },
    });
    expect(JSON.stringify(composio.requests)).not.toContain(KEY);
  });

  it("reports connection state per toolkit, including expired and missing connections", async () => {
    expect(await manager().connectionStatus()).toMatchObject({
      gmail: { state: "connected", accountHint: "ca_…001" },
      googlecalendar: { state: "connected" },
    });
    composio.setConnection("googlecalendar", "EXPIRED");
    composio.setConnection("gmail", null);
    expect(await manager().connectionStatus()).toMatchObject({
      gmail: { state: "needs_auth" },
      googlecalendar: { state: "expired" },
    });
    expect(await manager("someone-else").connectionStatus()).toMatchObject({
      gmail: { state: "needs_auth" },
    });
  });

  it("returns a Connect link that completes locally and returns to the callback", async () => {
    composio.setConnection("googlecalendar", null);
    const sessions = manager();
    const { redirectUrl } = await sessions.authorize(
      "googlecalendar",
      "http://127.0.0.1:4320/connections?connected=googlecalendar",
    );
    expect(redirectUrl.startsWith(`${composio.baseUrl}/fake-connect/`)).toBe(true);
    const response = await fetch(redirectUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:4320/connections?connected=googlecalendar",
    );
    sessions.reset();
    expect(await sessions.connectionStatus()).toMatchObject({
      googlecalendar: { state: "connected" },
    });
    expect(composio.links).toMatchObject([{ toolkit: "googlecalendar", completed: true }]);
  });

  it("fails session creation with Composio's error envelope when told to", async () => {
    composio.failSessions({
      status: 403,
      slug: "Project_Suspended",
      message: "This project is suspended.",
    });
    await expect(manager().mcpEndpoint()).rejects.toMatchObject({ code: "upstream" });
    await expect(manager().mcpEndpoint()).rejects.toThrow(/suspended/);
    composio.failSessions(null);
    await expect(manager().mcpEndpoint()).resolves.toMatchObject({ type: "http" });
  });

  it("refuses a wrong API key", async () => {
    const sessions = new ComposioSessionManager({
      apiKey: "ak_wrong",
      userId: "kestrel-maya",
      baseURL: composio.baseUrl,
      logger: silent,
    });
    await expect(sessions.mcpEndpoint()).rejects.toThrow(/Invalid API key/);
  });
});

describe("Composio fake session MCP", () => {
  it("lists exactly the session's allowlisted slugs with the captured schemas", async () => {
    const captured = capturedComposioTools();
    for (const access of ["read", "draft", "outbound"] as const) {
      const client = await mcp(manager("kestrel-maya", access));
      try {
        const listed = await client.listTools();
        const expected = [
          ...allowedTools("gmail", access),
          ...allowedTools("googlecalendar", access),
          ...allowedTools("quickbooks", access),
          ...allowedTools("slack", access),
        ];
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...expected].sort());
        const all = [
          ...captured.gmail,
          ...captured.googlecalendar,
          ...captured.quickbooks,
          ...captured.slack,
        ];
        for (const tool of listed.tools)
          expect(tool).toEqual(all.find((entry) => entry.name === tool.name));
      } finally {
        await client.close();
      }
    }
  });

  it("reads the inbox with Gmail search syntax and schema defaults", async () => {
    const client = await mcp(manager());
    try {
      const one = await call(client, "GMAIL_FETCH_EMAILS", {
        query: "from:dana@harborpine.test is:unread",
      });
      expect(one.body.successful).toBe(true);
      expect(one.body.data.messages).toMatchObject([
        {
          messageId: "199a1e0c4b7f2001",
          threadId: "199a1e0c4b7f2001",
          subject: "Charged twice for September?",
          messageText: expect.stringContaining("two charges of $490.00"),
        },
      ]);
      const inbox = await call(client, "GMAIL_FETCH_EMAILS", {
        query: "in:inbox -category:updates",
        max_results: 10,
      });
      expect((inbox.body.data.messages as JsonObject[]).map((message) => message.subject)).toEqual([
        "Charged twice for September?",
        "Solstice signed – please invoice",
        "Partial payment for invoice 1055",
        "Payment for invoice 1051",
        "Re: Invoice 1048 from Kestrel Analytics",
      ]);
      const paged = await call(client, "GMAIL_FETCH_EMAILS", { query: "invoice", max_results: 2 });
      expect(paged.body.data.nextPageToken).toEqual(expect.any(String));
      const thread = await call(client, "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {
        thread_id: "1990d6a2c3e41002",
      });
      expect((thread.body.data.messages as JsonObject[]).map((message) => message.sender)).toEqual([
        "Maya Lindqvist <maya@kestrel.test>",
        "Omar Haddad <omar@tidewater.test>",
      ]);
      const threads = await call(client, "GMAIL_LIST_THREADS", { query: "label:billing" });
      expect((threads.body.data.threads as JsonObject[]).map((entry) => entry.id)).toEqual(
        ["1993a4f1b2c64004", "1994b5c6d7e88008"].sort().reverse(),
      );
    } finally {
      await client.close();
    }
  });

  it("drafts a reply in the thread, sends it only on request, and records the outbox", async () => {
    const client = await mcp(manager());
    try {
      const draft = await call(client, "GMAIL_CREATE_EMAIL_DRAFT", {
        recipient_email: "dana@harborpine.test",
        body: "Hi Dana, we refunded the duplicate $490.00 charge.",
        thread_id: "199a1e0c4b7f2001",
      });
      expect(draft.body.data).toMatchObject({
        id: expect.stringMatching(/^r-/),
        message: { threadId: "199a1e0c4b7f2001", labelIds: ["DRAFT"] },
      });
      expect(composio.gmail.outbox).toEqual([]);
      expect(composio.gmail.draftList()).toMatchObject([
        { to: ["dana@harborpine.test"], subject: "Re: Charged twice for September?" },
      ]);

      const sent = await call(client, "GMAIL_SEND_DRAFT", { draft_id: String(draft.body.data.id) });
      expect(sent.body.data).toMatchObject({ threadId: "199a1e0c4b7f2001", labelIds: ["SENT"] });
      expect(composio.gmail.outbox).toMatchObject([
        { to: ["dana@harborpine.test"], via: "draft", subject: "Re: Charged twice for September?" },
      ]);
      expect(composio.gmail.draftList()).toEqual([]);

      const again = await call(client, "GMAIL_SEND_DRAFT", {
        draft_id: String(draft.body.data.id),
      });
      expect(again).toMatchObject({ isError: true, body: { successful: false } });
    } finally {
      await client.close();
    }
  });

  it("validates arguments against the captured schema and needs an active connection", async () => {
    const client = await mcp(manager());
    try {
      const missing = await call(client, "GMAIL_SEND_DRAFT", {});
      expect(missing).toMatchObject({
        isError: true,
        body: { successful: false, error: expect.stringContaining("draft_id") },
      });
      const extra = await call(client, "GMAIL_SEND_DRAFT", { draft_id: "r-1", to: "x@y.test" });
      expect(extra.body.error).toContain("unexpected property");
      const noRecipient = await call(client, "GMAIL_CREATE_EMAIL_DRAFT", {
        subject: "x",
        body: "y",
      });
      expect(noRecipient.body.error).toContain("recipient");
      composio.setConnection("googlecalendar", "EXPIRED");
      const expired = await call(client, "GOOGLECALENDAR_EVENTS_LIST", {});
      expect(expired.body.error).toContain("EXPIRED");
      await expect(
        client.callTool({ name: "GMAIL_DELETE_MESSAGE", arguments: {} }),
      ).rejects.toThrow(/not found/);
    } finally {
      await client.close();
    }
    expect(composio.toolCalls.map((entry) => [entry.tool, entry.successful])).toEqual([
      ["GMAIL_SEND_DRAFT", false],
      ["GMAIL_SEND_DRAFT", false],
      ["GMAIL_CREATE_EMAIL_DRAFT", false],
      ["GOOGLECALENDAR_EVENTS_LIST", false],
    ]);
  });

  it("serves the calendar: events, free slots, and invitations recorded on create", async () => {
    const client = await mcp(manager());
    try {
      const events = await call(client, "GOOGLECALENDAR_EVENTS_LIST", {
        timeMin: "2026-09-30T00:00:00-04:00",
        timeMax: "2026-10-01T00:00:00-04:00",
        singleEvents: true,
        orderBy: "startTime",
      });
      expect((events.body.data.items as JsonObject[]).map((event) => event.summary)).toEqual([
        "Board prep",
        "Month-end close",
      ]);
      expect((events.body.data.items as JsonObject[])[0]?.start).toEqual({
        dateTime: "2026-09-30T09:00:00-04:00",
        timeZone: "America/New_York",
      });

      const slots = await call(client, "GOOGLECALENDAR_FIND_FREE_SLOTS", {
        time_min: "2026-09-30T09:00:00",
        time_max: "2026-09-30T17:00:00",
        timezone: "America/New_York",
      });
      expect((slots.body.data.calendars as JsonObject).primary).toEqual({
        busy: [
          { start: "2026-09-30T09:00:00-04:00", end: "2026-09-30T12:00:00-04:00" },
          { start: "2026-09-30T15:00:00-04:00", end: "2026-09-30T17:00:00-04:00" },
        ],
        free: [{ start: "2026-09-30T12:00:00-04:00", end: "2026-09-30T15:00:00-04:00" }],
      });

      const created = await call(client, "GOOGLECALENDAR_CREATE_EVENT", {
        summary: "Copperleaf: invoice 1043",
        start_datetime: "2026-09-30T13:00:00",
        timezone: "America/New_York",
        attendees: ["theo@copperleaf.test", { email: "jordan@kestrel.test", optional: true }],
      });
      expect(created.body.data.response_data).toMatchObject({
        summary: "Copperleaf: invoice 1043",
        start: { dateTime: "2026-09-30T13:00:00-04:00" },
        end: { dateTime: "2026-09-30T13:30:00-04:00" },
        hangoutLink: expect.stringContaining("meet.google.test"),
      });
      expect(composio.calendar.invitations.map((entry) => entry.email)).toEqual([
        "theo@copperleaf.test",
        "jordan@kestrel.test",
      ]);

      const quiet = await call(client, "GOOGLECALENDAR_CREATE_EVENT", {
        summary: "Prep",
        start_datetime: "2026-09-30T12:00:00-04:00",
        event_duration_minutes: 15,
        attendees: ["theo@copperleaf.test"],
        send_updates: "none",
      });
      expect(quiet.body.successful).toBe(true);
      expect(composio.calendar.invitations).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
