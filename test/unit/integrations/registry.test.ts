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
import { SETTINGS, secret, stubFetch, testEnv } from "./helpers.js";

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
    ["hubspot-list-owners", "hubspot.owners.list", "read"],
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
    ["QUICKBOOKS_GET_COMPANY_INFO", "quickbooks.company_info.get", "read"],
    ["QUICKBOOKS_QUERY_CUSTOMERS", "quickbooks.customers.query", "read"],
    ["QUICKBOOKS_READ_CUSTOMER", "quickbooks.customers.get", "read"],
    ["QUICKBOOKS_QUERY_INVOICES", "quickbooks.invoices.query", "read"],
    ["QUICKBOOKS_READ_INVOICE", "quickbooks.invoices.get", "read"],
    ["QUICKBOOKS_QUERY_PAYMENTS", "quickbooks.payments.query", "read"],
    ["QUICKBOOKS_QUERY_ITEMS", "quickbooks.items.query", "read"],
    ["QUICKBOOKS_GET_AGED_RECEIVABLES_REPORT", "quickbooks.reports.aged_receivables", "read"],
    ["QUICKBOOKS_CREATE_CUSTOMER", "quickbooks.customers.create", "internal_write"],
    ["QUICKBOOKS_CREATE_INVOICE", "quickbooks.invoices.create", "financial"],
    ["QUICKBOOKS_CREATE_PAYMENT", "quickbooks.payments.create", "financial"],
  ],
  slack: [
    ["SLACK_FIND_CHANNELS", "slack.conversations.find", "read"],
    ["SLACK_LIST_ALL_CHANNELS", "slack.conversations.list", "read"],
    ["SLACK_FETCH_CONVERSATION_HISTORY", "slack.conversations.history", "read"],
    ["SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", "slack.conversations.replies", "read"],
    ["SLACK_FIND_USERS", "slack.users.find", "read"],
    ["SLACK_ADD_REACTION_TO_AN_ITEM", "slack.reactions.add", "internal_write"],
    ["SLACK_SEND_MESSAGE", "slack.chat.post_message", "outbound"],
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
    expect(describeTool("mcp__quickbooks__QUICKBOOKS_CREATE_INVOICE")).toMatchObject({
      integration: "quickbooks",
      connectionKind: "composio",
      upstream: "QUICKBOOKS_CREATE_INVOICE",
      baseClass: "financial",
    });
    expect(describeTool("mcp__slack__SLACK_SEND_MESSAGE")).toMatchObject({
      integration: "slack",
      connectionKind: "composio",
      upstream: "SLACK_SEND_MESSAGE",
    });
    // The retired REST tools are no longer anywhere in a profile.
    expect(describeTool("mcp__quickbooks__send_invoice")).toBeNull();
    expect(describeTool("mcp__slack__post_message")).toBeNull();
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
      classifyCall(
        set,
        "mcp__slack__SLACK_SEND_MESSAGE",
        { channel: "#general", markdown_text: "hi" },
        SETTINGS,
      ),
    ).toMatchObject({
      descriptor: { integration: "slack", name: "SLACK_SEND_MESSAGE" },
      classification: { actionClass: "outbound" },
    });
    expect(
      classifyCall(
        set,
        "mcp__slack__SLACK_SEND_MESSAGE",
        { channel: "billing", markdown_text: "Refunded." },
        SETTINGS,
      ),
    ).toMatchObject({ classification: { actionClass: "internal_write" } });
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
    stripe: { secretKey: secret(STRIPE_KEY), apiBaseUrl: "https://proxy.example" },
    composio: { apiKey: secret("ak_registry_key"), userId: "u1" },
  });

  it("resolves all six from the snapshot; one Composio configuration serves four", () => {
    const resolutions = resolveAll(createIntegrations(), env);
    expect(Object.keys(resolutions)).toEqual([...INTEGRATION_IDS]);
    expect(resolutions.stripe.status).toBe("configured");
    expect(resolutions.gmail.status).toBe("configured");
    expect(resolutions.google_calendar.status).toBe("configured");
    expect(resolutions.quickbooks).toMatchObject({
      status: "configured",
      connection: {
        integration: "quickbooks",
        kind: "composio",
        profile: "composio",
        endpointLabel: "backend.composio.dev",
        composio: { userId: "u1", toolkit: "quickbooks" },
      },
    });
    expect(resolutions.slack).toMatchObject({
      status: "configured",
      connection: { kind: "composio", composio: { toolkit: "slack" } },
    });
    expect(resolutions.hubspot).toEqual({
      status: "not_configured",
      missing: ["HUBSPOT_ACCESS_TOKEN"],
    });
    expect(
      available(createIntegrations(), env).map((connection) => connection.integration),
    ).toEqual(["gmail", "google_calendar", "stripe", "quickbooks", "slack"]);
    expect(resolveAll(createIntegrations(), testEnv()).quickbooks).toEqual({
      status: "not_configured",
      missing: ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID"],
    });
  });

  it("describes unconfigured and refused integrations by variable name only", () => {
    expect(
      statusFromResolution("quickbooks", {
        status: "not_configured",
        missing: ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID"],
      }),
    ).toEqual({
      integration: "quickbooks",
      kind: "composio",
      profile: "composio",
      state: "not_configured",
      detail: "Not configured. Set COMPOSIO_API_KEY and COMPOSIO_USER_ID.",
      endpointLabel: null,
      accountHint: null,
      missing: ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID"],
      checkedAt: null,
    });
    const refusedEnv = testEnv({
      composio: { apiKey: secret("ak_registry_key_value"), userId: " u1" },
    });
    const refused = statusFromResolution(
      "slack",
      resolveAll(createIntegrations(), refusedEnv).slack,
    );
    expect(refused).toMatchObject({
      kind: "composio",
      state: "invalid",
      detail: "COMPOSIO_USER_ID contains whitespace or control characters.",
      missing: [],
    });
    expect(JSON.stringify(refused)).not.toContain("ak_registry_key_value");
  });
});

describe("checking connections", () => {
  const env = testEnv({
    stripe: { secretKey: secret(STRIPE_KEY), apiBaseUrl: "https://proxy.example" },
  });
  const now = () => new Date("2026-09-28T12:00:00Z");

  it("probes a configured integration and stamps the check", async () => {
    const mock = stubFetch(() => ({ json: { livemode: false } }));
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
      endpointLabel: "proxy.example",
      accountHint: null,
      missing: [],
      checkedAt: "2026-09-28T12:00:00.000Z",
    });
    expect(mock.requests.map((request) => request.url.pathname)).toEqual(["/v1/balance"]);
  });

  it("never contacts an unconfigured integration, and turns a throwing probe into an error", async () => {
    const mock = stubFetch(() => ({ json: {} }));
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
    const mock = stubFetch(() => ({ json: { livemode: false } }));
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
  });

  it("plans one entry per integration and snapshots the run's connections", () => {
    const { plans, connections } = connectionSnapshot(createIntegrations(), env, {
      gmail: { state: "connected", detail: "Gmail connected" },
      google_calendar: { state: "needs_auth", detail: "Google Calendar is not connected" },
      stripe: { state: "error", detail: "Stripe check failed: timeout" },
      quickbooks: {
        state: "needs_auth",
        detail: "QuickBooks Online is not connected. Click Connect in Connections to sign in.",
      },
    });
    expect(plans.map((plan) => [plan.integration, plan.status])).toEqual([
      ["gmail", "available"],
      ["google_calendar", "unavailable"],
      ["hubspot", "unavailable"],
      ["stripe", "available"],
      ["quickbooks", "unavailable"],
      ["slack", "available"],
    ]);
    expect(plans[1]).toEqual({
      integration: "google_calendar",
      status: "unavailable",
      state: "needs_auth",
      detail: "Google Calendar is not connected",
    });
    expect(plans[5]).toMatchObject({
      status: "available",
      connection: { integration: "slack", kind: "composio" },
    });
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
        kind: "composio",
        profile: "composio",
        availability: "unavailable",
        state: "needs_auth",
        detail: "QuickBooks Online is not connected. Click Connect in Connections to sign in.",
        endpointLabel: "backend.composio.dev",
      },
      {
        integration: "slack",
        kind: "composio",
        profile: "composio",
        availability: "ready",
        state: "unknown",
        detail: null,
        endpointLabel: "backend.composio.dev",
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
