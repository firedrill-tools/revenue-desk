/**
 * Explicit, local-only Revenue Desk composition for synthetic Firedrill Tools.
 * Production integrations and their pinned provider hosts are untouched. This
 * module never accepts a provider credential and never falls back to one.
 */

import { secretValue } from "../config/secret.js";
import type { IntegrationId, ToolProfile, ToolSpec } from "../contracts/integration.js";
import type { JsonObject, JsonValue } from "../contracts/json.js";
import type { IntegrationCatalog } from "../gateway/catalog.js";
import type { UpstreamConfig } from "../gateway/mcp-proxy.js";
import { createIntegrations } from "../integrations/registry.js";

export type WorldBinding = {
  readonly worldHttpUrl: string;
  readonly worldWireHttpUrl: string;
  readonly worldMcpUrl: string;
  readonly worldWireAuthorizationHeader: string;
  readonly credential: string;
  readonly expiresAtMs: number;
  readonly projectId?: string;
  readonly environmentId: string;
  readonly sessionId: string;
};

/** A single isolated test case receives connection values, not a reusable setup ID. */
export type WorldAccess = Pick<
  WorldBinding,
  | "worldHttpUrl"
  | "worldWireHttpUrl"
  | "worldMcpUrl"
  | "worldWireAuthorizationHeader"
  | "credential"
> & { readonly expiresAtMs?: number };

export type CatalogBindings = {
  readonly core?: WorldAccess;
  readonly stripe?: WorldAccess;
};

export type DemoBindings = {
  /** Gmail, Calendar, QuickBooks, Slack and HubSpot share this world. */
  readonly core: WorldBinding;
  /** Stripe is separate because its current MCP aliases conflict with QuickBooks. */
  readonly stripe: WorldBinding;
};

const OPERATIONS: Readonly<Record<string, string>> = {
  GMAIL_FETCH_EMAILS: "gmail.messages.list",
  GMAIL_FETCH_MESSAGE_BY_THREAD_ID: "gmail.threads.get",
  GMAIL_LIST_THREADS: "gmail.threads.list",
  GMAIL_LIST_LABELS: "gmail.labels.list",
  GMAIL_CREATE_EMAIL_DRAFT: "gmail.drafts.create",
  GMAIL_ADD_LABEL_TO_EMAIL: "gmail.messages.label",
  GMAIL_SEND_DRAFT: "gmail.drafts.send",
  GMAIL_REPLY_TO_THREAD: "gmail.messages.send",
  GOOGLECALENDAR_EVENTS_LIST: "google-calendar.events.list",
  GOOGLECALENDAR_FIND_FREE_SLOTS: "google-calendar.freebusy.query",
  GOOGLECALENDAR_FIND_EVENT: "google-calendar.events.search",
  GOOGLECALENDAR_CREATE_EVENT: "google-calendar.events.insert",
  GOOGLECALENDAR_UPDATE_EVENT: "google-calendar.events.patch",
  QUICKBOOKS_GET_COMPANY_INFO: "quickbooks.company-info.get",
  QUICKBOOKS_QUERY_CUSTOMERS: "quickbooks.customers.search",
  QUICKBOOKS_READ_CUSTOMER: "quickbooks.customers.get",
  QUICKBOOKS_QUERY_INVOICES: "quickbooks.invoices.search",
  QUICKBOOKS_READ_INVOICE: "quickbooks.invoices.get",
  QUICKBOOKS_QUERY_PAYMENTS: "quickbooks.payments.search",
  QUICKBOOKS_QUERY_ITEMS: "quickbooks.items.search",
  // The Tool has no aggregate AR report. Give the agent the invoices it can
  // calculate aging from, and name that distinction in the displayed title.
  QUICKBOOKS_GET_AGED_RECEIVABLES_REPORT: "quickbooks.invoices.search",
  QUICKBOOKS_CREATE_CUSTOMER: "quickbooks.customers.create",
  QUICKBOOKS_CREATE_INVOICE: "quickbooks.invoices.create",
  QUICKBOOKS_CREATE_PAYMENT: "quickbooks.payments.create",
  SLACK_FIND_CHANNELS: "slack.conversations.list",
  SLACK_LIST_ALL_CHANNELS: "slack.conversations.list",
  SLACK_FETCH_CONVERSATION_HISTORY: "slack.conversations.history",
  SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION: "slack.conversations.replies",
  SLACK_FIND_USERS: "slack.users.list",
  SLACK_ADD_REACTION_TO_AN_ITEM: "slack.reactions.add",
  SLACK_SEND_MESSAGE: "slack.chat.post-message",
};

function assertBinding(binding: WorldAccess, label: string): void {
  for (const field of ["worldHttpUrl", "worldWireHttpUrl", "worldMcpUrl"] as const) {
    const url = new URL(binding[field]);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "world.firedrill.run" ||
      url.port !== "" ||
      url.search ||
      url.hash
    ) {
      throw new Error(`${label}: ${field} is not the issued production Firedrill URL`);
    }
  }
  if (
    binding.worldWireHttpUrl !== `${binding.worldHttpUrl}/v1/wire` ||
    binding.worldMcpUrl !== `${binding.worldHttpUrl}/v1/mcp` ||
    binding.worldWireAuthorizationHeader !== "X-Firedrill-World-Authorization" ||
    !binding.credential ||
    (binding.expiresAtMs !== undefined && binding.expiresAtMs <= Date.now())
  ) {
    throw new Error(`${label}: missing, expired, or inconsistent world binding`);
  }
}

export function validateDemoBindings(bindings: DemoBindings): void {
  assertBinding(bindings.core, "core");
  assertBinding(bindings.stripe, "stripe");
  if (
    !bindings.core.projectId ||
    !bindings.stripe.projectId ||
    bindings.core.projectId !== bindings.stripe.projectId
  ) {
    throw new Error("Core and Stripe must belong to the same Firedrill project");
  }
  if (
    bindings.core.environmentId === bindings.stripe.environmentId ||
    bindings.core.sessionId === bindings.stripe.sessionId
  ) {
    throw new Error("Core and Stripe must have different synthetic Tool sessions");
  }
}

function mcp(binding: WorldAccess): Extract<UpstreamConfig, { transport: "http" }> {
  return {
    transport: "http",
    url: binding.worldMcpUrl,
    headers: { Authorization: `Bearer ${binding.credential}` },
  };
}

function translatedProfile<I extends IntegrationId>(profile: ToolProfile<I>): ToolProfile<I> {
  const tools: Record<string, ToolSpec> = {};
  for (const [name, spec] of Object.entries(profile.tools)) {
    const upstream = OPERATIONS[name] ?? spec.upstream;
    tools[name] = {
      ...spec,
      upstream,
      ...(name === "QUICKBOOKS_GET_AGED_RECEIVABLES_REPORT"
        ? { title: "Read invoices to calculate receivables aging" }
        : {}),
    };
  }
  return { ...profile, tools };
}

/** Adapt native Tool inputs to the existing classifier's approval vocabulary. */
function policyInput(tool: string, input: JsonObject): JsonObject {
  const output: Record<string, JsonValue> = { ...input };
  if (tool === "GMAIL_CREATE_EMAIL_DRAFT") {
    const to = Array.isArray(input.to)
      ? input.to.filter((value): value is string => typeof value === "string")
      : [];
    output.recipient_email = to[0] ?? null;
    output.extra_recipients = to.slice(1);
    output.thread_id = input.threadId ?? null;
    output.user_id = input.userId ?? "me";
  } else if (tool === "GMAIL_SEND_DRAFT") {
    output.draft_id = input.draftId ?? input.id ?? null;
    output.user_id = input.userId ?? "me";
  } else if (tool === "GMAIL_ADD_LABEL_TO_EMAIL") {
    output.message_id = input.messageId ?? null;
    output.add_label_ids = input.addLabelIds ?? [];
    output.remove_label_ids = input.removeLabelIds ?? [];
    output.user_id = input.userId ?? "me";
  } else if (tool === "GMAIL_REPLY_TO_THREAD") {
    output.thread_id = input.threadId ?? null;
    output.message_body = input.body ?? null;
    output.recipient_email = Array.isArray(input.to) ? (input.to[0] ?? null) : null;
    output.extra_recipients = Array.isArray(input.to) ? input.to.slice(1) : [];
    output.user_id = input.userId ?? "me";
  } else if (tool === "SLACK_SEND_MESSAGE") {
    output.markdown_text = input.text ?? input.markdownText ?? null;
  } else if (tool === "GOOGLECALENDAR_CREATE_EVENT" || tool === "GOOGLECALENDAR_UPDATE_EVENT") {
    output.calendar_id = input.calendarId ?? "primary";
    output.event_id = input.eventId ?? null;
    output.start_datetime = input.startTime ?? null;
    output.end_datetime = input.endTime ?? null;
    output.timezone = input.timeZone ?? null;
    output.send_updates =
      input.notificationLevel === "NONE"
        ? "none"
        : input.notificationLevel === "EXTERNAL_ONLY"
          ? "externalOnly"
          : "all";
    output.attendees = input.attendees ?? input.attendeeEmails ?? null;
  } else if (tool === "QUICKBOOKS_CREATE_CUSTOMER") {
    const customer = input.customer as JsonObject | undefined;
    if (customer !== undefined) Object.assign(output, customer);
    output.display_name = customer?.DisplayName ?? customer?.displayName ?? null;
  } else if (tool === "QUICKBOOKS_CREATE_INVOICE") {
    output.customer_id = input.customer_ref ?? null;
    output.lines = Array.isArray(input.line_items)
      ? input.line_items.map((line) => {
          if (line === null || typeof line !== "object" || Array.isArray(line)) return line;
          const item = line as JsonObject;
          const quantity = typeof item.qty === "number" ? item.qty : 0;
          const unitPrice = typeof item.unit_price === "number" ? item.unit_price : 0;
          return {
            DetailType: "SalesItemLineDetail",
            Amount: quantity * unitPrice,
            Description: item.description ?? null,
            SalesItemLineDetail: {
              ItemRef: { value: item.item_ref ?? null },
              Qty: quantity,
              UnitPrice: unitPrice,
            },
          };
        })
      : [];
  } else if (tool === "QUICKBOOKS_CREATE_PAYMENT") {
    output.customer_id = input.customer_ref ?? null;
    output.currency_ref_value = input.currency_ref ?? null;
    output.lines = Array.isArray(input.line)
      ? input.line.map((line) => {
          if (line === null || typeof line !== "object" || Array.isArray(line)) return line;
          const paymentLine = line as JsonObject;
          return {
            Amount: paymentLine.amount ?? null,
            LinkedTxn: Array.isArray(paymentLine.linked_txn)
              ? paymentLine.linked_txn.map((link) => {
                  if (link === null || typeof link !== "object" || Array.isArray(link)) return link;
                  const linked = link as JsonObject;
                  return { TxnId: linked.txn_id ?? null, TxnType: linked.txn_type ?? null };
                })
              : [],
          };
        })
      : [];
  }
  return output;
}

/** Native shapes the original approval cards cannot yet describe are denied. */
function supportedPolicyShape(tool: string, input: JsonObject): boolean {
  if (
    (tool === "GMAIL_CREATE_EMAIL_DRAFT" || tool === "GMAIL_REPLY_TO_THREAD") &&
    (input.raw !== undefined || input.attachments !== undefined || input.htmlBody !== undefined)
  ) {
    return false;
  }
  if (
    tool === "GOOGLECALENDAR_UPDATE_EVENT" &&
    (input.addedAttendees !== undefined || input.removedAttendeeEmails !== undefined)
  ) {
    return false;
  }
  return true;
}

function memoryOutput(tool: string, output: JsonValue): JsonValue {
  if (
    (tool === "GOOGLECALENDAR_EVENTS_LIST" || tool === "GOOGLECALENDAR_FIND_EVENT") &&
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const record = output as JsonObject;
    if (Array.isArray(record.events)) return { ...record, items: record.events };
  }
  return output;
}

/** Only a fixed provider origin is accepted; no fetch can reach that origin. */
/** @internal Exported for the no-real-provider egress contract test. */
export function syntheticFetch(binding: WorldAccess): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (
      url.protocol !== "https:" ||
      !["api.stripe.com", "api.hubapi.com"].includes(url.hostname) ||
      url.port !== "" ||
      !url.pathname.startsWith("/")
    ) {
      throw new Error("Synthetic mode refused a non-provider or non-HTTPS request");
    }
    const headers = new Headers(init?.headers);
    headers.set(binding.worldWireAuthorizationHeader, `Bearer ${binding.credential}`);
    // The synthetic provider route verifies the same actor-scoped world
    // credential in its provider-shaped Authorization carrier as well.
    headers.set("Authorization", `Bearer ${binding.credential}`);
    const route = `${binding.worldWireHttpUrl}${url.pathname}${url.search}`;
    return fetch(route, { ...init, headers, redirect: "error" });
  };
}

export function createFiredrillDemoCatalog(bindings: CatalogBindings): IntegrationCatalog {
  const { core, stripe } = bindings;
  if (!core && !stripe) throw new Error("Select a synthetic Tool binding for this run");
  if (core) assertBinding(core, "core");
  if (stripe) assertBinding(stripe, "stripe");
  const base = createIntegrations();
  const providerFetch = async (input: string, init: RequestInit): Promise<Response> => {
    const host = new URL(input).hostname;
    if (host === "api.stripe.com" && stripe) return syntheticFetch(stripe)(input, init);
    if (host === "api.hubapi.com" && core) return syntheticFetch(core)(input, init);
    throw new Error("Synthetic mode refused a request outside its declared provider routes");
  };
  const http = { fetch: providerFetch };
  const synthetic = createIntegrations({ http });
  const probe = async (binding: WorldAccess, signal: AbortSignal) => {
    try {
      const response = await fetch(`${binding.worldHttpUrl}/v1/world/canary`, {
        headers: { Authorization: `Bearer ${binding.credential}` },
        signal,
      });
      if (!response.ok) throw new Error(`Firedrill returned HTTP ${response.status}`);
      return {
        state: "connected" as const,
        detail: "Synthetic Tool connection is ready.",
        accountHint: null,
      };
    } catch {
      return {
        state: "error" as const,
        detail: "Synthetic Tool connection is unavailable.",
        accountHint: null,
      };
    }
  };
  const composio = (id: "gmail" | "google_calendar" | "quickbooks" | "slack") => {
    const binding = core;
    if (!binding) throw new Error("This test case has no core Tool binding");
    const original = base[id];
    const toolkit = original.toolkit;
    return {
      ...original,
      profile: translatedProfile(original.profile),
      resolve: () => ({
        status: "configured" as const,
        connection: {
          integration: id,
          kind: "composio" as const,
          profile: "composio" as const,
          endpointLabel: "world.firedrill.run",
          composio: { apiKey: secretValue("synthetic-only"), userId: "local-demo", toolkit },
        },
      }),
      probe: (_connection: unknown, signal: AbortSignal) => probe(binding, signal),
      connector: () => ({
        upstream: async () => ({ config: mcp(binding) }),
        authorize: async () => {
          throw new Error("Synthetic Tools require no provider sign-in");
        },
        reset: () => {},
      }),
      classify: (
        tool: string,
        input: JsonObject,
        settings: Parameters<typeof original.classify>[2],
      ) =>
        supportedPolicyShape(tool, input)
          ? original.classify(tool, policyInput(tool, input), settings)
          : null,
      checkInput: (tool: string, input: JsonObject) =>
        original.checkInput?.(tool, policyInput(tool, input)) ?? [],
      runMemory: (settings: Parameters<NonNullable<typeof original.runMemory>>[0]) => {
        const memory = original.runMemory?.(settings);
        if (memory === undefined) return undefined;
        return {
          record: (
            tool: string,
            input: JsonObject,
            output: JsonValue,
            isError: boolean,
            failure?: Parameters<typeof memory.record>[4],
          ) =>
            memory.record(
              tool,
              policyInput(tool, input),
              memoryOutput(tool, output),
              isError,
              failure,
            ),
          refine: (
            tool: string,
            input: JsonObject,
            classification: Parameters<typeof memory.refine>[2],
          ) => memory.refine(tool, policyInput(tool, input), classification),
        };
      },
    };
  };
  return {
    gmail: core ? composio("gmail") : base.gmail,
    google_calendar: core ? composio("google_calendar") : base.google_calendar,
    quickbooks: core ? composio("quickbooks") : base.quickbooks,
    slack: core ? composio("slack") : base.slack,
    hubspot: core
      ? {
          ...synthetic.hubspot,
          resolve: () => ({
            status: "configured",
            connection: {
              integration: "hubspot",
              kind: "mcp",
              profile: "hubspot-mcp-0.4",
              endpointLabel: "world.firedrill.run",
              mcp: { transport: "stdio", accessToken: secretValue("synthetic-only") },
            },
          }),
          probe: (_connection, signal) => probe(core, signal),
          upstream: () => mcp(core),
        }
      : base.hubspot,
    stripe: stripe
      ? {
          ...synthetic.stripe,
          resolve: () => ({
            status: "configured",
            connection: {
              integration: "stripe",
              kind: "api",
              profile: "stripe-api",
              endpointLabel: "world.firedrill.run",
              api: {
                secretKey: secretValue("sk_test_firedrill_synthetic_only"),
                keyMode: "test",
                apiVersion: null,
              },
            },
          }),
          probe: (_connection, signal) => probe(stripe, signal),
        }
      : base.stripe,
  } as IntegrationCatalog;
}

export const FIREDRILL_NATIVE_UPSTREAMS = OPERATIONS;
