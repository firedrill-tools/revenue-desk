// Every non-chat route of src/contracts/api.ts through app.request.

import { afterEach, describe, expect, it } from "vitest";
import type {
  ApiErrorBody,
  ConnectionView,
  ConversationDetail,
  ConversationSummary,
  Page,
  PolicyView,
  RunDetailView,
  RunSummaryView,
} from "../../../src/contracts/api.js";
import type { WorkspaceSettings } from "../../../src/contracts/integration.js";
import { insertConversation } from "../../../src/db/repos/conversations.js";
import { insertUserMessage } from "../../../src/db/repos/messages.js";
import { finishRun, insertRun } from "../../../src/db/repos/runs.js";
import {
  cleanupAll,
  createTestServer,
  heldScript,
  LIVE_OWNER,
  refundScript,
  TEST_SECRET,
  userMessage,
  waitFor,
} from "./harness.js";

afterEach(cleanupAll);

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function errorOf(response: Response): Promise<ApiErrorBody["error"]> {
  return (await json<ApiErrorBody>(response)).error;
}

describe("conversations", () => {
  it("creates one with a server id, lists, reads, renames and archives it", async () => {
    const server = createTestServer();
    const created = await server.request("POST", "/api/conversations", {
      title: "  Duplicate charge  ",
    });
    expect(created.status).toBe(201);
    const { conversation } = await json<{ conversation: ConversationSummary }>(created);
    expect(conversation).toMatchObject({
      title: "Duplicate charge",
      source: "ui",
      status: "idle",
      activeRunId: null,
      pendingApprovals: 0,
      totalCostUsd: 0,
      archivedAt: null,
    });
    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/);

    const detail = await json<ConversationDetail>(
      await server.request("GET", `/api/conversations/${conversation.id}`),
    );
    expect(detail).toEqual({ conversation, messages: [], pendingApprovals: [] });

    const renamed = await server.request("PATCH", `/api/conversations/${conversation.id}`, {
      title: "Refund Kestrel",
      archived: true,
    });
    expect(renamed.status).toBe(200);
    expect((await json<{ conversation: ConversationSummary }>(renamed)).conversation).toMatchObject(
      {
        title: "Refund Kestrel",
        archivedAt: expect.any(String),
      },
    );

    const active = await json<Page<ConversationSummary>>(
      await server.request("GET", "/api/conversations"),
    );
    expect(active.items).toEqual([]);
    const archived = await json<Page<ConversationSummary>>(
      await server.request("GET", "/api/conversations?archived=true"),
    );
    expect(archived.items.map((item) => item.id)).toEqual([conversation.id]);
  });

  it("searches, pages and validates the list query", async () => {
    const server = createTestServer();
    const now = "2026-09-28T10:00:00.000Z";
    for (let index = 0; index < 3; index += 1) {
      insertConversation(server.services.db, {
        id: `c${index}`,
        title: index === 1 ? "Weekly digest" : `Chat ${index}`,
        source: index === 2 ? "cli" : "ui",
        now: `2026-09-28T10:00:0${index}.000Z`,
      });
    }
    insertUserMessage(server.services.db, {
      id: "m0",
      conversationId: "c0",
      runId: null,
      parts: [{ type: "text", text: "Why was Kestrel charged twice?" }],
      now,
    });
    const ids = async (query: string) =>
      (
        await json<Page<ConversationSummary>>(
          await server.request("GET", `/api/conversations${query}`),
        )
      ).items.map((item) => item.id);
    expect(await ids("")).toEqual(["c2", "c1", "c0"]);
    expect(await ids("?q=digest")).toEqual(["c1"]);
    expect(await ids("?q=KESTREL")).toEqual(["c0"]);
    const first = await json<Page<ConversationSummary>>(
      await server.request("GET", "/api/conversations?limit=2"),
    );
    expect(first.items.map((item) => item.id)).toEqual(["c2", "c1"]);
    expect(first.items[0]?.source).toBe("cli");
    expect(await ids(`?limit=2&cursor=${first.nextCursor}`)).toEqual(["c0"]);

    for (const query of [
      "?limit=0",
      "?limit=abc",
      "?limit=101",
      "?archived=maybe",
      "?cursor=bogus",
    ]) {
      const response = await server.request("GET", `/api/conversations${query}`);
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code).toBe("invalid_request");
    }
  });

  it("answers 404 for unknown ids and 400 for invalid bodies", async () => {
    const server = createTestServer();
    expect((await server.request("GET", "/api/conversations/missing")).status).toBe(404);
    expect(
      (await server.request("PATCH", "/api/conversations/missing", { title: "x" })).status,
    ).toBe(404);
    const unknownKey = await server.request("POST", "/api/conversations", {
      id: "chosen-by-client",
    });
    expect(unknownKey.status).toBe(400);
    expect((await errorOf(unknownKey)).issues?.length).toBeGreaterThan(0);
    const id = await server.createConversation();
    expect(
      (await server.request("PATCH", `/api/conversations/${id}`, { archived: "yes" })).status,
    ).toBe(400);
    expect(
      (await server.request("PATCH", `/api/conversations/${id}`, { title: "x".repeat(201) }))
        .status,
    ).toBe(400);
  });
});

describe("runs, stop and approvals", () => {
  function seedFinishedRun(
    server: ReturnType<typeof createTestServer>,
    id: string,
    source: "ui" | "cli",
  ) {
    insertConversation(server.services.db, {
      id: `c_${id}`,
      title: "",
      source,
      now: "2026-09-28T10:00:00.000Z",
    });
    insertRun(server.services.db, {
      id,
      conversationId: `c_${id}`,
      source,
      mode: source === "ui" ? "interactive" : "headless",
      model: "claude-sonnet-5",
      effort: "medium",
      userMessageId: null,
      assistantMessageId: null,
      policy: {
        read: "auto",
        internal_write: "auto",
        outbound: "ask",
        financial: "ask",
        destructive: "deny",
      },
      connections: [],
      startedAt: "2026-09-28T10:00:00.000Z",
      // Another process that is still running (a CLI, or the server's own finished runs).
      owner: LIVE_OWNER,
    });
  }

  it("lists and filters runs and returns a run's detail", async () => {
    const server = createTestServer();
    seedFinishedRun(server, "r_ui", "ui");
    seedFinishedRun(server, "r_cli", "cli");
    finishRun(server.services.db, "r_ui", {
      status: "completed",
      finishedAt: "2026-09-28T10:00:05.000Z",
      stopReason: null,
      terminalReason: "completed",
      error: null,
    });
    const all = await json<Page<RunSummaryView>>(await server.request("GET", "/api/runs"));
    expect(all.items.map((run) => run.id).sort()).toEqual(["r_cli", "r_ui"]);
    const cli = await json<Page<RunSummaryView>>(
      await server.request("GET", "/api/runs?source=cli"),
    );
    expect(cli.items.map((run) => run.id)).toEqual(["r_cli"]);
    const completed = await json<Page<RunSummaryView>>(
      await server.request("GET", "/api/runs?status=completed"),
    );
    expect(completed.items.map((run) => run.id)).toEqual(["r_ui"]);
    const byConversation = await json<Page<RunSummaryView>>(
      await server.request("GET", "/api/runs?conversationId=c_r_cli&limit=1"),
    );
    expect(byConversation.items.map((run) => run.id)).toEqual(["r_cli"]);
    expect((await server.request("GET", "/api/runs?status=paused")).status).toBe(400);

    const detail = await json<RunDetailView>(await server.request("GET", "/api/runs/r_ui"));
    expect(detail).toMatchObject({
      id: "r_ui",
      status: "completed",
      terminalReason: "completed",
      toolCalls: [],
      approvals: [],
      connections: [],
    });
    expect((await server.request("GET", "/api/runs/missing")).status).toBe(404);
  });

  it("stops only a run this server is running", async () => {
    const held = heldScript();
    const server = createTestServer({ script: held.script });
    seedFinishedRun(server, "r_done", "ui");
    finishRun(server.services.db, "r_done", {
      status: "completed",
      finishedAt: "2026-09-28T10:00:05.000Z",
      stopReason: null,
      terminalReason: null,
      error: null,
    });
    seedFinishedRun(server, "r_cli", "cli");

    expect((await server.request("POST", "/api/runs/missing/stop")).status).toBe(404);
    const done = await server.request("POST", "/api/runs/r_done/stop");
    expect(done.status).toBe(409);
    expect(await errorOf(done)).toEqual({
      code: "run_not_active",
      message: "This run is not running.",
    });
    const cli = await server.request("POST", "/api/runs/r_cli/stop");
    expect(cli.status).toBe(409);
    expect((await errorOf(cli)).message).toMatch(/another process/);
    expect((await server.request("POST", "/api/runs/r_cli/stop", { now: true })).status).toBe(400);

    const conversationId = await server.createConversation();
    const chat = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Wait for me"),
    });
    const runId = server.core?.inputs[0]?.runId ?? "";
    const stop = await server.request("POST", `/api/runs/${runId}/stop`);
    expect(stop.status).toBe(202);
    expect(await stop.json()).toEqual({ runId, status: "stopping" });
    await chat.text();
    await server.services.registry.get(runId)?.done;
    expect((await server.request("POST", `/api/runs/${runId}/stop`)).status).toBe(409);
  });

  it("decides an approval once: 200, then 409; 404 for unknown ids; 400 for bad bodies", async () => {
    const server = createTestServer({ script: refundScript });
    const conversationId = await server.createConversation();
    const chat = await server.request("POST", "/api/chat", {
      conversationId,
      message: userMessage("u1", "Refund the duplicate"),
    });
    await waitFor(() => server.gate.pendingIds().includes("apr_refund_1"));

    expect(
      (await server.request("POST", "/api/approvals/apr_refund_1", { approved: "yes" })).status,
    ).toBe(400);
    expect(
      (await server.request("POST", "/api/approvals/apr_refund_1", { approved: true, extra: 1 }))
        .status,
    ).toBe(400);
    expect(
      (
        await server.request("POST", "/api/approvals/apr_refund_1", {
          approved: false,
          reason: "x".repeat(501),
        })
      ).status,
    ).toBe(400);

    const accepted = await server.request("POST", "/api/approvals/apr_refund_1", {
      approved: true,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ status: "accepted", approvalId: "apr_refund_1" });
    const again = await server.request("POST", "/api/approvals/apr_refund_1", { approved: false });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("already_decided");
    const unknown = await server.request("POST", "/api/approvals/apr_nope", { approved: true });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");
    await chat.text();
  });
});

describe("connections", () => {
  it("lists every integration with its configuration state and missing names", async () => {
    const server = createTestServer({
      integrations: {
        configuration: { gmail: "configured", stripe: "invalid", slack: "configured" },
      },
    });
    const { items } = await json<{ items: ConnectionView[] }>(
      await server.request("GET", "/api/connections"),
    );
    expect(items.map((item) => [item.integration, item.state, item.canConnect])).toEqual([
      ["gmail", "unknown", true],
      ["google_calendar", "not_configured", false],
      ["hubspot", "not_configured", false],
      ["stripe", "invalid", false],
      ["quickbooks", "not_configured", false],
      ["slack", "unknown", false],
    ]);
    expect(items[1]).toMatchObject({
      label: "Google Calendar",
      kind: "composio",
      profile: "composio",
      missing: ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID"],
      detail: "Not configured. Set COMPOSIO_API_KEY and COMPOSIO_USER_ID.",
      endpointLabel: null,
    });
    expect(items[3]?.detail).toBe("STRIPE_SECRET_KEY: Live keys are refused.");
    expect(items[0]).toMatchObject({
      endpointLabel: "backend.composio.dev",
      detail: "Not checked yet.",
    });
    expect(JSON.stringify(items)).not.toContain(TEST_SECRET);
  });

  it("checks with the read-only probe and stores the result; a throwing probe is an error state", async () => {
    const server = createTestServer({
      integrations: {
        configuration: {
          gmail: "configured",
          google_calendar: "configured",
          hubspot: "configured",
        },
        probes: {
          google_calendar: {
            state: "needs_auth",
            detail: "Google Calendar is not connected",
            accountHint: null,
          },
          hubspot: new Error(`upstream said Bearer ${TEST_SECRET}`),
        },
      },
    });
    const check = async (integration: string) =>
      server.request("POST", `/api/connections/${integration}/check`);

    const gmail = await json<{ connection: ConnectionView }>(await check("gmail"));
    expect(gmail.connection).toMatchObject({
      state: "connected",
      canConnect: false,
      checkedAt: expect.any(String),
    });
    const calendar = await json<{ connection: ConnectionView }>(await check("google_calendar"));
    expect(calendar.connection).toMatchObject({ state: "needs_auth", canConnect: true });
    const hubspot = await json<{ connection: ConnectionView }>(await check("hubspot"));
    expect(hubspot.connection.state).toBe("error");
    expect(hubspot.connection.detail).toMatch(/^The check failed: /);
    expect(hubspot.connection.detail).not.toContain(TEST_SECRET);

    // Not configured: no probe, the configuration state is returned.
    const slack = await json<{ connection: ConnectionView }>(await check("slack"));
    expect(slack.connection.state).toBe("not_configured");
    expect(server.integrations.probeCalls.get("slack")).toBeUndefined();

    const { items } = await json<{ items: ConnectionView[] }>(
      await server.request("GET", "/api/connections"),
    );
    expect(items.find((item) => item.integration === "google_calendar")?.state).toBe("needs_auth");
    expect((await check("salesforce")).status).toBe(404);
  });

  it("starts Composio's sign-in through the integration's connector, with a callback on the server's own origin", async () => {
    const server = createTestServer({
      integrations: {
        configuration: { gmail: "configured", stripe: "configured" },
        authorize: async () => ({ redirectUrl: "https://connect.composio.test/link/abc" }),
      },
    });
    const calls = server.integrations.authorizeCalls;
    // Listing, checking and planning never start a sign-in: only the click does.
    await server.request("GET", "/api/connections");
    await server.request("POST", "/api/connections/gmail/check");
    server.services.connections.plans();
    expect(calls).toEqual([]);
    const response = await server.request(
      "POST",
      "/api/connections/gmail/connect",
      {},
      {
        host: "localhost:4321",
        origin: "http://localhost:4321",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirectUrl: "https://connect.composio.test/link/abc",
    });
    expect(calls).toEqual([
      { toolkit: "gmail", callbackUrl: "http://localhost:4321/connections?connected=gmail" },
    ]);

    for (const integration of ["stripe", "google_calendar"]) {
      const refused = await server.request("POST", `/api/connections/${integration}/connect`);
      expect(refused.status, integration).toBe(409);
      expect((await errorOf(refused)).code).toBe("not_supported");
    }
    expect(calls).toHaveLength(1);
  });

  it("reports a failing Composio sign-in as 502 without the secret", async () => {
    const server = createTestServer({
      integrations: {
        configuration: { google_calendar: "configured" },
        authorize: async () => {
          throw new Error(`denied for key ${TEST_SECRET}`);
        },
      },
    });
    const response = await server.request("POST", "/api/connections/google_calendar/connect");
    expect(response.status).toBe(502);
    const error = await errorOf(response);
    expect(error.code).toBe("upstream_error");
    expect(error.message).not.toContain(TEST_SECRET);
  });
});

describe("settings and policies", () => {
  it("reads and updates settings with normalisation", async () => {
    const server = createTestServer();
    const initial = await json<{ settings: WorkspaceSettings }>(
      await server.request("GET", "/api/settings"),
    );
    expect(initial.settings).toMatchObject({
      companyName: "",
      agentName: "Revenue Desk",
      currency: "USD",
    });

    const response = await server.request("PATCH", "/api/settings", {
      companyName: " Kestrel Ops ",
      internalEmailDomains: ["Kestrel.TEST", "@kestrel.test", "ops.kestrel.test"],
      allowedSlackChannels: ["Billing", "#billing", "C0123ABC"],
      notifySlackChannel: "#Sales-Ops",
      currency: "eur",
      timezone: "Europe/London",
      defaultModel: "claude-opus-5",
      defaultEffort: "high",
    });
    expect(response.status).toBe(200);
    const { settings } = await json<{ settings: WorkspaceSettings }>(response);
    expect(settings).toMatchObject({
      companyName: "Kestrel Ops",
      internalEmailDomains: ["kestrel.test", "ops.kestrel.test"],
      allowedSlackChannels: ["#billing", "C0123ABC"],
      notifySlackChannel: "#sales-ops",
      currency: "EUR",
      timezone: "Europe/London",
      defaultModel: "claude-opus-5",
      defaultEffort: "high",
    });
    const cleared = await json<{ settings: WorkspaceSettings }>(
      await server.request("PATCH", "/api/settings", {
        defaultModel: null,
        notifySlackChannel: null,
      }),
    );
    expect(cleared.settings).toMatchObject({
      defaultModel: null,
      notifySlackChannel: null,
      companyName: "Kestrel Ops",
    });
  });

  it.each([
    [{ timezone: "Mars/Olympus" }],
    [{ currency: "DOLLARS" }],
    [{ internalEmailDomains: ["not a domain"] }],
    [{ allowedSlackChannels: ["#has space"] }],
    [{ defaultEffort: "extreme" }],
    [{ agentName: "" }],
    [{ updatedAt: "2026-01-01T00:00:00.000Z" }],
  ])("refuses the invalid settings update %j", async (body) => {
    const server = createTestServer();
    const response = await server.request("PATCH", "/api/settings", body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid_request");
  });

  it("reads and saves policies, and refuses classes AGENT_POLICY locks", async () => {
    const server = createTestServer({ runtime: { policyOverrides: { financial: "deny" } } });
    const initial = await json<{ policies: PolicyView[] }>(
      await server.request("GET", "/api/policies"),
    );
    expect(initial.policies.find((view) => view.actionClass === "financial")).toEqual({
      actionClass: "financial",
      mode: "deny",
      source: "environment",
      locked: true,
    });

    const saved = await server.request("PATCH", "/api/policies", { modes: { outbound: "auto" } });
    expect(saved.status).toBe(200);
    const { policies } = await json<{ policies: PolicyView[] }>(saved);
    expect(policies.find((view) => view.actionClass === "outbound")).toEqual({
      actionClass: "outbound",
      mode: "auto",
      source: "saved",
      locked: false,
    });

    const locked = await server.request("PATCH", "/api/policies", {
      modes: { financial: "auto", outbound: "ask" },
    });
    expect(locked.status).toBe(409);
    expect((await errorOf(locked)).code).toBe("policy_locked");
    const after = await json<{ policies: PolicyView[] }>(
      await server.request("GET", "/api/policies"),
    );
    expect(after.policies.find((view) => view.actionClass === "outbound")?.mode).toBe("auto");

    for (const body of [
      { modes: { financial: "maybe" } },
      { modes: { payroll: "auto" } },
      { outbound: "auto" },
    ]) {
      expect((await server.request("PATCH", "/api/policies", body)).status).toBe(400);
    }
  });
});
