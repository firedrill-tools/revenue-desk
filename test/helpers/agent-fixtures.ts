/**
 * Minimal in-test integrations, settings and environments for the agent core
 * tests (W1). The integration definitions here are deliberately tiny stand-ins
 * shaped like the §2 profiles (W2 builds the real ones, W5 the realistic
 * fakes); they only need to exercise every connection kind and action class.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type EnvironmentRecord, loadAgentEnv } from "../../src/config/env.js";
import { secretValue } from "../../src/config/secret.js";
import type { AgentEnv } from "../../src/contracts/env.js";
import type { ConnectionPlan } from "../../src/contracts/events.js";
import {
  type ActionClass,
  type Classification,
  type ClassifierSettings,
  type ComposioAccess,
  type ComposioConnection,
  type ComposioToolkitSlug,
  type HubSpotConnection,
  INTEGRATIONS,
  type IntegrationDefinition,
  type IntegrationId,
  type OperationName,
  type StripeConnection,
  type ToolSpec,
  type WorkspaceSettings,
} from "../../src/contracts/integration.js";
import type { JsonObject } from "../../src/contracts/json.js";
import { ApiToolError, defineApiTool } from "../../src/gateway/api-server.js";
import type { IntegrationCatalog } from "../../src/gateway/catalog.js";
import { noteHttpRequest, noteHttpResponse } from "../../src/gateway/http-report.js";
import type { UpstreamConfig } from "../../src/gateway/mcp-proxy.js";

export const TEST_SETTINGS: WorkspaceSettings = {
  companyName: "Kestrel Analytics",
  agentName: "Revenue Desk",
  senderName: "Dana Reyes",
  emailSignature: "Dana Reyes\nBilling, Kestrel Analytics",
  internalEmailDomains: ["kestrel.test"],
  notifySlackChannel: "#billing",
  allowedSlackChannels: ["#billing", "#sales-ops"],
  internalCalendarIds: [],
  timezone: "America/New_York",
  currency: "USD",
  defaultModel: null,
  defaultEffort: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

export const BUSINESS_DATE = "2026-09-28";

function spec(
  name: string,
  operation: OperationName,
  title: string,
  baseClass: ActionClass,
  upstream = name,
): ToolSpec {
  return { name, upstream, operation, title, baseClass, readOnly: baseClass === "read" };
}

type Classifier = (
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
) => Classification | null;

function byBaseClass(tools: Record<string, ToolSpec>): Classifier {
  return (tool) => {
    const entry = tools[tool];
    if (entry === undefined) return null;
    if (entry.baseClass === "read" || entry.baseClass === "internal_write") {
      return { actionClass: entry.baseClass, operation: entry.operation, title: entry.title };
    }
    return {
      actionClass: entry.baseClass,
      operation: entry.operation,
      title: entry.title,
      details: { consequence: entry.title, facts: [] },
    };
  };
}

function definition<I extends IntegrationId>(
  id: I,
  tools: readonly ToolSpec[],
  classify?: Classifier,
): IntegrationDefinition<I> {
  const map = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return {
    id,
    label: INTEGRATIONS[id].label,
    kind: INTEGRATIONS[id].kind,
    profile: { id: INTEGRATIONS[id].profile, integration: id, tools: map },
    resolve: () => ({ status: "not_configured", missing: [] }),
    classify: classify ?? byBaseClass(map),
    probe: async () => ({ state: "connected", detail: "ok", accountHint: null }),
  };
}

export const STRIPE_TOOLS = [
  spec("list_charges", "stripe.charges.list", "List charges in Stripe", "read", "GET /v1/charges"),
  spec(
    "create_refund",
    "stripe.refunds.create",
    "Refund charge in Stripe",
    "financial",
    "POST /v1/refunds",
  ),
];

export const HUBSPOT_TOOLS = [
  spec("search_contacts", "hubspot.contacts.search", "Search HubSpot contacts", "read"),
  spec("create_note", "hubspot.notes.create", "Add a note in HubSpot", "internal_write"),
];

export const GMAIL_TOOLS = [
  spec("GMAIL_FETCH_EMAILS", "gmail.messages.list", "Search Gmail", "read"),
  spec(
    "GMAIL_CREATE_EMAIL_DRAFT",
    "gmail.drafts.create",
    "Draft an email in Gmail",
    "internal_write",
  ),
  spec("GMAIL_SEND_DRAFT", "gmail.drafts.send", "Send a Gmail draft", "outbound"),
];

const formatUsd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

const stripeClassifier: Classifier = (tool, input) => {
  if (tool === "list_charges") {
    return {
      actionClass: "read",
      operation: "stripe.charges.list",
      title: "List charges in Stripe",
    };
  }
  if (tool !== "create_refund") return null;
  const charge = typeof input.charge === "string" ? input.charge : "an unknown charge";
  const amount = typeof input.amount === "number" ? input.amount : null;
  return {
    actionClass: "financial",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    details: {
      consequence:
        amount === null
          ? `Refund charge ${charge} in full`
          : `Refund ${formatUsd(amount)} of ${charge}`,
      facts: [
        { label: "Charge", value: charge },
        { label: "Amount", value: amount === null ? "Full amount" : formatUsd(amount) },
      ],
      ...(amount === null ? {} : { amount: { amountMinor: amount, currency: "USD" } }),
      recordIds: [charge],
    },
  };
};

const gmailClassifier: Classifier = (tool, input, settings) => {
  const base = byBaseClass(Object.fromEntries(GMAIL_TOOLS.map((entry) => [entry.name, entry])));
  if (tool !== "GMAIL_SEND_DRAFT") return base(tool, input, settings);
  const draft = typeof input.draft_id === "string" ? input.draft_id : "unknown";
  return {
    actionClass: "outbound",
    operation: "gmail.drafts.send",
    title: "Send a Gmail draft",
    details: {
      consequence: `Send draft ${draft}`,
      facts: [{ label: "Draft", value: draft }],
      recordIds: [draft],
    },
  };
};

/** Arguments as JSON (undefined optional fields dropped). */
function plain(args: object): JsonObject {
  return JSON.parse(JSON.stringify(args)) as JsonObject;
}

export type StripeCall = { readonly tool: string; readonly args: JsonObject; readonly key: string };

/** A catalog whose Stripe tools record every run (with the idempotency key they received). */
/** Where the test's Composio session MCP lives, per the run's toolkits and exposure. */
export type ComposioTestSession = (
  toolkits: readonly ComposioToolkitSlug[],
  access: ComposioAccess,
) => Promise<UpstreamConfig>;

export type TestCatalogOptions = {
  readonly stripeCalls?: StripeCall[];
  readonly composio?: ComposioTestSession;
};

const noComposio: ComposioTestSession = async () => {
  throw new Error("Composio is not set up in this test.");
};

/** HubSpot over HTTP with its bearer token, or a stdio command override with the token in its env. */
function hubspotUpstream(connection: HubSpotConnection): UpstreamConfig {
  const { mcp } = connection;
  if (mcp.transport === "http") {
    return {
      transport: "http",
      url: mcp.url,
      headers: mcp.token === null ? {} : { Authorization: `Bearer ${mcp.token.reveal()}` },
    };
  }
  if (mcp.command === null) throw new Error("The test catalog launches only a command override.");
  return {
    transport: "stdio",
    command: mcp.command.command,
    args: mcp.command.args,
    env: { PRIVATE_APP_ACCESS_TOKEN: mcp.accessToken.reveal() },
  };
}

export function testCatalog(options: TestCatalogOptions = {}): IntegrationCatalog {
  const stripeCalls = options.stripeCalls ?? [];
  const composio = options.composio ?? noComposio;
  const connector = () => ({
    upstream: async (toolkits: readonly ComposioToolkitSlug[], access: ComposioAccess) => ({
      config: await composio(toolkits, access),
    }),
  });
  const listCharges = defineApiTool({
    name: "list_charges",
    description: "List a Stripe customer's charges, newest first. Amounts are minor units.",
    input: {
      customer: z.string().describe("Stripe customer id, cus_…"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
    run: async (args, context) => {
      stripeCalls.push({ tool: "list_charges", args: plain(args), key: context.idempotencyKey });
      // As the HTTP layer reports a read: its status, no key (src/gateway/http-report.ts).
      noteHttpResponse(200);
      return {
        data: [
          { id: "ch_1", amount: 4900, currency: "usd", customer: args.customer },
          { id: "ch_2", amount: 4900, currency: "usd", customer: args.customer },
        ],
        has_more: false,
      };
    },
  });
  const createRefund = defineApiTool({
    name: "create_refund",
    description: "Refund a Stripe charge, fully or partly. Amount in minor units.",
    input: {
      charge: z.string(),
      amount: z.number().int().positive().optional(),
      reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
    },
    readOnly: false,
    run: async (args, context) => {
      stripeCalls.push({ tool: "create_refund", args: plain(args), key: context.idempotencyKey });
      // As the HTTP layer reports a write: the key it sent and the response's status.
      noteHttpRequest(context.idempotencyKey);
      noteHttpResponse(args.charge === "ch_declined" ? 400 : 200);
      if (args.charge === "ch_declined") {
        throw new ApiToolError("stripe", "Charge ch_declined has already been refunded.", {
          status: 400,
          code: "charge_already_refunded",
        });
      }
      return {
        id: "re_1",
        object: "refund",
        status: "succeeded",
        charge: args.charge,
        amount: args.amount ?? 4900,
      };
    },
  });
  return {
    gmail: { ...definition("gmail", GMAIL_TOOLS, gmailClassifier), connector },
    google_calendar: {
      ...definition("google_calendar", [
        spec(
          "GOOGLECALENDAR_EVENTS_LIST",
          "google_calendar.events.list",
          "List calendar events",
          "read",
        ),
      ]),
      connector,
    },
    hubspot: { ...definition("hubspot", HUBSPOT_TOOLS), upstream: hubspotUpstream },
    stripe: {
      ...definition("stripe", STRIPE_TOOLS, stripeClassifier),
      tools: () => [listCharges, createRefund],
    },
    quickbooks: {
      ...definition("quickbooks", [
        spec(
          "QUICKBOOKS_GET_COMPANY_INFO",
          "quickbooks.company_info.get",
          "Get company info from QuickBooks",
          "read",
        ),
      ]),
      connector,
    },
    slack: {
      ...definition("slack", [
        spec("SLACK_LIST_ALL_CHANNELS", "slack.conversations.list", "List Slack channels", "read"),
      ]),
      connector,
    },
  };
}

export const STRIPE_KEY = `sk_test_${"s".repeat(24)}`;

export function stripeConnection(): StripeConnection {
  return {
    integration: "stripe",
    kind: "api",
    profile: "stripe-api",
    endpointLabel: "api.stripe.test",
    api: {
      baseUrl: "http://127.0.0.1:9",
      secretKey: secretValue(STRIPE_KEY),
      keyMode: "test",
      apiVersion: null,
    },
  };
}

export function hubspotHttpConnection(url: string, token: string): HubSpotConnection {
  return {
    integration: "hubspot",
    kind: "mcp",
    profile: "hubspot-mcp-0.4",
    endpointLabel: new URL(url).host,
    mcp: { transport: "http", url, token: secretValue(token) },
  };
}

export function gmailConnection(): ComposioConnection<"gmail"> {
  return {
    integration: "gmail",
    kind: "composio",
    profile: "composio",
    endpointLabel: "backend.composio.test",
    composio: {
      apiKey: secretValue(`composio-key-${"c".repeat(20)}`),
      userId: "user_kestrel",
      baseUrl: "http://127.0.0.1:9",
      toolkit: "gmail",
    },
  };
}

/** One plan per integration: the given ones available, the rest not configured. */
export function plansWith(available: readonly ConnectionPlan[]): ConnectionPlan[] {
  return (Object.keys(INTEGRATIONS) as IntegrationId[]).map(
    (integration) =>
      available.find((plan) => plan.integration === integration) ?? {
        integration,
        status: "unavailable",
        state: "not_configured",
        detail: `${INTEGRATIONS[integration].label} is not configured.`,
      },
  );
}

/** A fresh state directory, removed by the returned cleanup. */
export function tempStateDir(prefix = "revenue-desk-w1-"): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A snapshot from an environment record; throws on configuration problems. */
export function testEnv(environment: EnvironmentRecord): AgentEnv {
  const result = loadAgentEnv(environment, { cwd: "/" });
  if (!result.ok) throw new Error(`test env refused: ${JSON.stringify(result.problems)}`);
  return result.env;
}
