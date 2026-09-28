/**
 * Tool calls as the model makes them: model-visible names
 * (`mcp__<integration>__<tool>`, docs/ARCHITECTURE.md §2) and argument names
 * from the offered schemas: the captured Composio and HubSpot 0.4.0 surfaces,
 * and the zod shapes of src/integrations/{stripe,quickbooks,slack}/schemas.ts.
 *
 * This is the only file that knows argument names. When an integration's
 * schema changes, the scenario responder reports the drifted call (it checks
 * every call against the schema the agent offered) and the fix lands here.
 */
import type { JsonObject } from "../../src/contracts/json.js";
import { call, type ScriptedCall } from "./script.js";

type Options = { readonly expectInvalid?: boolean; readonly expectNotOffered?: boolean };

/** Drops undefined fields so inputs stay JSON. */
function input(fields: Readonly<Record<string, JsonObject[string] | undefined>>): JsonObject {
  const out: Record<string, JsonObject[string]> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}

// --- Gmail and Google Calendar (Composio direct_tools slugs) --------------------

export const gmail = {
  fetchEmails: (
    id: string,
    args: { query?: string; max_results?: number; label_ids?: string[] },
    options?: Options,
  ): ScriptedCall => call(id, "mcp__gmail__GMAIL_FETCH_EMAILS", input(args), options),
  fetchThread: (id: string, threadId: string): ScriptedCall =>
    call(id, "mcp__gmail__GMAIL_FETCH_MESSAGE_BY_THREAD_ID", { thread_id: threadId }),
  createDraft: (
    id: string,
    args: {
      recipient_email: string;
      body: string;
      subject?: string;
      thread_id?: string;
      cc?: string[];
    },
  ): ScriptedCall => call(id, "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT", input(args)),
  sendDraft: (id: string, draftId: string): ScriptedCall =>
    call(id, "mcp__gmail__GMAIL_SEND_DRAFT", { draft_id: draftId }),
  replyToThread: (
    id: string,
    args: { thread_id: string; recipient_email: string; message_body: string },
  ): ScriptedCall => call(id, "mcp__gmail__GMAIL_REPLY_TO_THREAD", input(args)),
};

export const calendar = {
  findFreeSlots: (
    id: string,
    args: { time_min: string; time_max: string; timezone: string },
  ): ScriptedCall => call(id, "mcp__google_calendar__GOOGLECALENDAR_FIND_FREE_SLOTS", input(args)),
  createEvent: (
    id: string,
    args: {
      summary: string;
      start_datetime: string;
      timezone: string;
      event_duration_minutes?: number;
      event_duration_hour?: number;
      attendees: string[];
      description?: string;
      send_updates?: "all" | "externalOnly" | "none";
    },
  ): ScriptedCall => call(id, "mcp__google_calendar__GOOGLECALENDAR_CREATE_EVENT", input(args)),
};

// --- HubSpot (@hubspot/mcp-server 0.4.0 tools) --------------------------------------

type Filter = { propertyName: string; operator: string; value?: string; values?: string[] };
type Association = {
  to: { id: string };
  types: { associationCategory: "HUBSPOT_DEFINED"; associationTypeId: number }[];
};

export const hubspot = {
  search: (
    id: string,
    args: {
      objectType: string;
      query?: string;
      filterGroups?: { filters: Filter[] }[];
      properties?: string[];
      limit?: number;
    },
    options?: Options,
  ): ScriptedCall => call(id, "mcp__hubspot__hubspot-search-objects", input(args), options),
  listAssociations: (
    id: string,
    args: { objectType: string; objectId: string; toObjectType: string },
  ): ScriptedCall => call(id, "mcp__hubspot__hubspot-list-associations", input(args)),
  batchRead: (
    id: string,
    args: { objectType: string; ids: string[]; properties?: string[] },
  ): ScriptedCall =>
    call(
      id,
      "mcp__hubspot__hubspot-batch-read-objects",
      input({
        objectType: args.objectType,
        inputs: args.ids.map((value) => ({ id: value })),
        properties: args.properties,
      }),
    ),
  createNote: (
    id: string,
    args: { body: string; timestamp: string; ownerId?: string; associations: Association[] },
  ): ScriptedCall =>
    call(id, "mcp__hubspot__hubspot-batch-create-objects", {
      objectType: "notes",
      inputs: [
        {
          properties: input({
            hs_note_body: args.body,
            hs_timestamp: args.timestamp,
            hubspot_owner_id: args.ownerId,
          }),
          associations: args.associations,
        },
      ],
    }),
  /** A note as a model writes it before it learns HubSpot's rules: no hs_timestamp. */
  createUntimedNote: (id: string, args: { body: string; associations: Association[] }) =>
    call(id, "mcp__hubspot__hubspot-batch-create-objects", {
      objectType: "notes",
      inputs: [{ properties: { hs_note_body: args.body }, associations: args.associations }],
    }),
  createTask: (
    id: string,
    args: {
      subject: string;
      body: string;
      due: string;
      ownerId: string;
      priority: "LOW" | "MEDIUM" | "HIGH";
      type: "TODO" | "CALL" | "EMAIL";
      associations: Association[];
    },
  ): ScriptedCall =>
    call(id, "mcp__hubspot__hubspot-batch-create-objects", {
      objectType: "tasks",
      inputs: [
        {
          properties: {
            hs_task_subject: args.subject,
            hs_task_body: args.body,
            hs_task_status: "NOT_STARTED",
            hs_task_priority: args.priority,
            hs_task_type: args.type,
            hs_timestamp: args.due,
            hubspot_owner_id: args.ownerId,
          },
          associations: args.associations,
        },
      ],
    }),
};

/** HUBSPOT_DEFINED association type ids used by the scenarios. */
export const ASSOCIATION = {
  noteToContact: 202,
  noteToCompany: 190,
  noteToDeal: 214,
  taskToContact: 204,
  taskToCompany: 192,
  taskToDeal: 216,
} as const;

export function associate(id: string, typeId: number): Association {
  return {
    to: { id },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }],
  };
}

// --- Stripe --------------------------------------------------------------------------

export const stripe = {
  findCustomers: (id: string, args: { email: string } | { name: string }): ScriptedCall =>
    call(id, "mcp__stripe__find_customers", input(args)),
  listCharges: (
    id: string,
    args: { customer?: string; created_after?: string; created_before?: string; limit?: number },
  ): ScriptedCall => call(id, "mcp__stripe__list_charges", input(args)),
  listRefunds: (
    id: string,
    args: { charge?: string; created_after?: string; limit?: number },
  ): ScriptedCall => call(id, "mcp__stripe__list_refunds", input(args)),
  createRefund: (
    id: string,
    args: {
      charge: string;
      amount: number;
      reason?: "duplicate" | "fraudulent" | "requested_by_customer";
      metadata?: Record<string, string>;
    },
    options?: Options,
  ): ScriptedCall => call(id, "mcp__stripe__create_refund", input(args), options),
};

// --- QuickBooks ------------------------------------------------------------------------

type InvoiceLine = {
  description?: string;
  quantity?: number;
  unit_price_minor: number;
  item_id?: string;
};

export const quickbooks = {
  companyInfo: (id: string): ScriptedCall => call(id, "mcp__quickbooks__get_company_info", {}),
  findCustomers: (id: string, args: { name?: string; email?: string }): ScriptedCall =>
    call(id, "mcp__quickbooks__find_customers", input(args)),
  listInvoices: (
    id: string,
    args: {
      customer_id?: string;
      status?: "open" | "paid" | "all";
      due_before?: string;
      issued_from?: string;
      as_of?: string;
    },
  ): ScriptedCall => call(id, "mcp__quickbooks__list_invoices", input(args)),
  listPayments: (
    id: string,
    args: { customer_id?: string; received_from?: string },
  ): ScriptedCall => call(id, "mcp__quickbooks__list_payments", input(args)),
  createCustomer: (
    id: string,
    args: {
      display_name: string;
      company_name?: string;
      given_name?: string;
      family_name?: string;
      email?: string;
    },
  ): ScriptedCall => call(id, "mcp__quickbooks__create_customer", input(args)),
  createInvoice: (
    id: string,
    args: { customer_id: string; lines: InvoiceLine[]; due_date?: string; customer_memo?: string },
  ): ScriptedCall =>
    call(
      id,
      "mcp__quickbooks__create_invoice",
      input({ ...args, lines: args.lines.map((line) => input(line)) }),
    ),
  sendInvoice: (id: string, args: { invoice_id: string; send_to?: string }): ScriptedCall =>
    call(id, "mcp__quickbooks__send_invoice", input(args)),
};

// --- Slack --------------------------------------------------------------------------------

export const slack = {
  postMessage: (
    id: string,
    args: { channel: string; text: string; thread_ts?: string },
  ): ScriptedCall => call(id, "mcp__slack__post_message", input(args)),
  readChannel: (id: string, args: { channel: string; limit?: number }): ScriptedCall =>
    call(id, "mcp__slack__read_channel", input(args)),
};
