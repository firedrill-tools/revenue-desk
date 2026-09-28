import { describe, expect, it } from "vitest";
import {
  type ActionClass,
  INTEGRATION_IDS,
  INTEGRATIONS,
} from "../../../src/contracts/integration.js";
import {
  available,
  checkConnection,
  checkConnections,
  classifyCall,
  connectionSnapshot,
  createIntegrations,
  describeTool,
  integrations,
  PROFILE_ALLOWLISTS,
  PROFILES,
  resolveAll,
  statusFromResolution,
  toolDescriptors,
} from "../../../src/integrations/registry.js";
import { mockFetch, SETTINGS, secret, testEnv } from "./helpers.js";

/** docs/ARCHITECTURE.md §2, the frozen tool tables: name, operation, base class. */
const SECTION_2: {
  readonly [I in keyof typeof PROFILES]: ReadonlyArray<readonly [string, string, ActionClass]>;
} = {
  gmail: [
    ["GMAIL_FETCH_EMAILS", "gmail.messages.list", "read"],
    ["GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "gmail.threads.get", "read"],
    ["GMAIL_LIST_THREADS", "gmail.threads.list", "read"],
    ["GMAIL_LIST_LABELS", "gmail.labels.list", "read"],
    ["GMAIL_CREATE_EMAIL_DRAFT", "gmail.drafts.create", "internal_write"],
    ["GMAIL_ADD_LABEL_TO_EMAIL", "gmail.messages.label", "internal_write"],
    ["GMAIL_SEND_DRAFT", "gmail.drafts.send", "outbound"],
    ["GMAIL_REPLY_TO_THREAD", "gmail.threads.reply", "outbound"],
  ],
  google_calendar: [
    ["GOOGLECALENDAR_EVENTS_LIST", "google_calendar.events.list", "read"],
    ["GOOGLECALENDAR_FIND_FREE_SLOTS", "google_calendar.freebusy.query", "read"],
    ["GOOGLECALENDAR_FIND_EVENT", "google_calendar.events.find", "read"],
    ["GOOGLECALENDAR_CREATE_EVENT", "google_calendar.events.create", "outbound"],
    ["GOOGLECALENDAR_UPDATE_EVENT", "google_calendar.events.update", "outbound"],
  ],
  hubspot: [
    ["hubspot-get-user-details", "hubspot.account.get", "read"],
    ["hubspot-list-objects", "hubspot.objects.list", "read"],
    ["hubspot-search-objects", "hubspot.objects.search", "read"],
    ["hubspot-batch-read-objects", "hubspot.objects.batch_read", "read"],
    ["hubspot-list-associations", "hubspot.associations.list", "read"],
    ["hubspot-get-association-definitions", "hubspot.associations.definitions", "read"],
    ["hubspot-list-properties", "hubspot.properties.list", "read"],
    ["hubspot-get-property", "hubspot.properties.get", "read"],
    ["hubspot-batch-create-objects", "hubspot.objects.create", "internal_write"],
    ["hubspot-batch-update-objects", "hubspot.objects.update", "internal_write"],
  ],
  stripe: [
    ["find_customers", "stripe.customers.list", "read"],
    ["get_customer", "stripe.customers.retrieve", "read"],
    ["list_charges", "stripe.charges.list", "read"],
    ["list_payment_intents", "stripe.payment_intents.list", "read"],
    ["list_invoices", "stripe.invoices.list", "read"],
    ["get_invoice", "stripe.invoices.retrieve", "read"],
    ["list_subscriptions", "stripe.subscriptions.list", "read"],
    ["list_refunds", "stripe.refunds.list", "read"],
    ["get_balance", "stripe.balance.retrieve", "read"],
    ["create_refund", "stripe.refunds.create", "financial"],
    ["cancel_subscription", "stripe.subscriptions.cancel", "financial"],
  ],
  quickbooks: [
    ["get_company_info", "quickbooks.company_info.get", "read"],
    ["find_customers", "quickbooks.customers.query", "read"],
    ["get_customer", "quickbooks.customers.get", "read"],
    ["list_invoices", "quickbooks.invoices.query", "read"],
    ["get_invoice", "quickbooks.invoices.get", "read"],
    ["list_payments", "quickbooks.payments.query", "read"],
    ["create_customer", "quickbooks.customers.create", "internal_write"],
    ["create_invoice", "quickbooks.invoices.create", "financial"],
    ["send_invoice", "quickbooks.invoices.send", "financial"],
    ["record_payment", "quickbooks.payments.create", "financial"],
    ["void_invoice", "quickbooks.invoices.void", "financial"],
  ],
  slack: [
    ["list_channels", "slack.conversations.list", "read"],
    ["read_channel", "slack.conversations.history", "read"],
    ["read_thread", "slack.conversations.replies", "read"],
    ["find_user", "slack.users.lookup", "read"],
    ["post_message", "slack.chat.post_message", "outbound"],
    ["add_reaction", "slack.reactions.add", "internal_write"],
  ],
};

const STRIPE_KEY = "sk_test_registry_0123456789";

describe("definitions and profiles", () => {
  it("define the six integrations with the decided kinds and profiles", () => {
    const set = createIntegrations();
    for (const id of INTEGRATION_IDS) {
      const definition = set[id];
      expect(definition.id).toBe(id);
      expect(definition.label).toBe(INTEGRATIONS[id].label);
      expect(definition.kind).toBe(INTEGRATIONS[id].kind);
      expect(definition.profile.id).toBe(INTEGRATIONS[id].profile);
      expect(definition.profile.integration).toBe(id);
      expect(definition.profile).toBe(PROFILES[id]);
    }
    expect(integrations()).toBe(integrations());
  });

  it("equal the §2 tables exactly", () => {
    for (const id of INTEGRATION_IDS) {
      const specs = Object.values(PROFILES[id].tools).map((spec) => [
        spec.name,
        spec.operation,
        spec.baseClass,
      ]);
      expect(specs, id).toEqual(SECTION_2[id].map((row) => [...row]));
      expect(PROFILE_ALLOWLISTS[id]).toEqual(SECTION_2[id].map(([name]) => name));
      for (const spec of Object.values(PROFILES[id].tools)) {
        expect(spec.readOnly).toBe(spec.baseClass === "read");
        expect(spec.title.length).toBeGreaterThan(5);
        expect(spec.upstream.length).toBeGreaterThan(3);
      }
    }
  });

  it("describe tools by their model-visible names", () => {
    expect(describeTool("mcp__stripe__create_refund")).toMatchObject({
      name: "create_refund",
      integration: "stripe",
      connectionKind: "api",
      sdkName: "mcp__stripe__create_refund",
      baseClass: "financial",
      upstream: "POST /v1/refunds",
    });
    expect(describeTool("mcp__google_calendar__GOOGLECALENDAR_CREATE_EVENT")).toMatchObject({
      connectionKind: "composio",
    });
    expect(describeTool("mcp__hubspot__hubspot-batch-create-associations")).toBeNull();
    expect(describeTool("mcp__stripe__toString")).toBeNull();
    expect(describeTool("mcp__other__x")).toBeNull();
    expect(describeTool("Bash")).toBeNull();
    expect(toolDescriptors("slack").map((tool) => tool.sdkName)).toEqual(
      SECTION_2.slack.map(([name]) => `mcp__slack__${name}`),
    );
  });

  it("classify calls through the owning integration", () => {
    const set = createIntegrations();
    expect(
      classifyCall(set, "mcp__slack__post_message", { channel: "#general", text: "hi" }, SETTINGS),
    ).toMatchObject({
      descriptor: { integration: "slack", name: "post_message" },
      classification: { actionClass: "outbound" },
    });
    expect(
      classifyCall(set, "mcp__stripe__create_refund", { charge: "ch_1" }, SETTINGS),
    ).toMatchObject({
      descriptor: { name: "create_refund" },
      classification: null,
    });
    expect(classifyCall(set, "mcp__stripe__delete_everything", {}, SETTINGS)).toBeNull();
  });
});

describe("resolution and availability", () => {
  const env = testEnv({
    stripe: { secretKey: secret(STRIPE_KEY), apiBaseUrl: "http://127.0.0.1:4410" },
    slack: { botToken: secret("xoxp-not-a-bot") },
    composio: { apiKey: secret("ak_registry_key"), userId: "u1" },
  });

  it("resolves all six from the snapshot", () => {
    const resolutions = resolveAll(createIntegrations(), env);
    expect(Object.keys(resolutions)).toEqual([...INTEGRATION_IDS]);
    expect(resolutions.stripe.status).toBe("configured");
    expect(resolutions.gmail.status).toBe("configured");
    expect(resolutions.google_calendar.status).toBe("configured");
    expect(resolutions.slack.status).toBe("invalid");
    expect(resolutions.hubspot).toEqual({
      status: "not_configured",
      missing: ["HUBSPOT_ACCESS_TOKEN"],
    });
    expect(
      available(createIntegrations(), env).map((connection) => connection.integration),
    ).toEqual(["gmail", "google_calendar", "stripe"]);
  });

  it("describes unconfigured and refused integrations by variable name only", () => {
    expect(
      statusFromResolution("quickbooks", {
        status: "not_configured",
        missing: ["QBO_ACCESS_TOKEN", "QBO_REALM_ID"],
      }),
    ).toEqual({
      integration: "quickbooks",
      kind: "api",
      profile: "quickbooks-api",
      state: "not_configured",
      detail: "Not configured. Set QBO_ACCESS_TOKEN and QBO_REALM_ID.",
      endpointLabel: null,
      accountHint: null,
      missing: ["QBO_ACCESS_TOKEN", "QBO_REALM_ID"],
      checkedAt: null,
    });
    const refused = statusFromResolution("slack", resolveAll(createIntegrations(), env).slack);
    expect(refused).toMatchObject({
      state: "invalid",
      detail: "SLACK_BOT_TOKEN must be a bot token (xoxb-…).",
      missing: [],
    });
    expect(JSON.stringify(refused)).not.toContain("xoxp-not-a-bot");
  });
});

describe("checking connections", () => {
  const env = testEnv({
    stripe: { secretKey: secret(STRIPE_KEY), apiBaseUrl: "http://127.0.0.1:4410" },
  });
  const now = () => new Date("2026-09-28T12:00:00Z");

  it("probes a configured integration and stamps the check", async () => {
    const mock = mockFetch(() => ({ json: { livemode: false } }));
    const status = await checkConnection(
      createIntegrations({ http: mock.http }),
      "stripe",
      env,
      new AbortController().signal,
      now,
    );
    expect(status).toEqual({
      integration: "stripe",
      kind: "api",
      profile: "stripe-api",
      state: "connected",
      detail: "Stripe test-mode key accepted; balance is readable.",
      endpointLabel: "127.0.0.1:4410",
      accountHint: null,
      missing: [],
      checkedAt: "2026-09-28T12:00:00.000Z",
    });
    expect(mock.requests.map((request) => request.url.pathname)).toEqual(["/v1/balance"]);
  });

  it("never contacts an unconfigured integration, and turns a throwing probe into an error", async () => {
    const mock = mockFetch(() => ({ json: {} }));
    const set = createIntegrations({ http: mock.http });
    await expect(
      checkConnection(set, "slack", env, new AbortController().signal, now),
    ).resolves.toMatchObject({
      state: "not_configured",
      checkedAt: null,
    });
    expect(mock.requests).toHaveLength(0);
    const throwing = {
      ...set,
      stripe: {
        ...set.stripe,
        probe: async () => {
          throw new Error("unexpected");
        },
      },
    };
    await expect(
      checkConnection(throwing, "stripe", env, new AbortController().signal, now),
    ).resolves.toMatchObject({
      state: "error",
      detail: "The check failed: unexpected",
      checkedAt: "2026-09-28T12:00:00.000Z",
    });
  });

  it("checks all six in the fixed order", async () => {
    const mock = mockFetch(() => ({ json: { livemode: false } }));
    const statuses = await checkConnections(
      createIntegrations({ http: mock.http }),
      env,
      new AbortController().signal,
      now,
    );
    expect(statuses.map((status) => [status.integration, status.state])).toEqual([
      ["gmail", "not_configured"],
      ["google_calendar", "not_configured"],
      ["hubspot", "not_configured"],
      ["stripe", "connected"],
      ["quickbooks", "not_configured"],
      ["slack", "not_configured"],
    ]);
  });
});

describe("connectionSnapshot", () => {
  const env = testEnv({
    composio: { apiKey: secret("ak_registry_key"), userId: "u1" },
    stripe: { secretKey: secret(STRIPE_KEY) },
    slack: { botToken: secret("xoxb-ok"), apiBaseUrl: "http://slack.example" },
  });

  it("plans one entry per integration and snapshots the run's connections", () => {
    const { plans, connections } = connectionSnapshot(createIntegrations(), env, {
      gmail: { state: "connected", detail: "Gmail connected" },
      google_calendar: { state: "needs_auth", detail: "Google Calendar is not connected" },
      stripe: { state: "error", detail: "Stripe check failed: timeout" },
    });
    expect(plans.map((plan) => [plan.integration, plan.status])).toEqual([
      ["gmail", "available"],
      ["google_calendar", "unavailable"],
      ["hubspot", "unavailable"],
      ["stripe", "available"],
      ["quickbooks", "unavailable"],
      ["slack", "unavailable"],
    ]);
    expect(plans[1]).toEqual({
      integration: "google_calendar",
      status: "unavailable",
      state: "needs_auth",
      detail: "Google Calendar is not connected",
    });
    expect(plans[5]).toMatchObject({ status: "unavailable", state: "invalid" });
    expect(connections).toEqual([
      {
        integration: "gmail",
        kind: "composio",
        profile: "composio",
        availability: "ready",
        state: "connected",
        detail: null,
        endpointLabel: "backend.composio.dev",
      },
      {
        integration: "google_calendar",
        kind: "composio",
        profile: "composio",
        availability: "unavailable",
        state: "needs_auth",
        detail: "Google Calendar is not connected",
        endpointLabel: "backend.composio.dev",
      },
      {
        integration: "hubspot",
        kind: "mcp",
        profile: "hubspot-mcp-0.4",
        availability: "unavailable",
        state: "not_configured",
        detail: "Not configured. Set HUBSPOT_ACCESS_TOKEN.",
        endpointLabel: null,
      },
      {
        integration: "stripe",
        kind: "api",
        profile: "stripe-api",
        availability: "ready",
        state: "error",
        detail: null,
        endpointLabel: "api.stripe.com",
      },
      {
        integration: "quickbooks",
        kind: "api",
        profile: "quickbooks-api",
        availability: "unavailable",
        state: "not_configured",
        detail: "Not configured. Set QBO_ACCESS_TOKEN and QBO_REALM_ID.",
        endpointLabel: null,
      },
      {
        integration: "slack",
        kind: "api",
        profile: "slack-api",
        availability: "unavailable",
        state: "invalid",
        detail:
          "SLACK_API_BASE_URL must use https (plain http is accepted only for loopback hosts).",
        endpointLabel: null,
      },
    ]);
  });

  it("keeps a configured but never-checked integration available, and expired ones out", () => {
    const { plans, connections } = connectionSnapshot(createIntegrations(), env, {
      gmail: { state: "expired", detail: "Gmail sign-in expired; reconnect to continue" },
    });
    expect(plans[0]).toMatchObject({ status: "unavailable", state: "expired" });
    expect(plans[3]).toMatchObject({ status: "available", connection: { integration: "stripe" } });
    expect(connections[3]).toMatchObject({ availability: "ready", state: "unknown" });
  });
});
