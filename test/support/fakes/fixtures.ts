/**
 * Loads test/fixtures/business/*.json: the systems of record of Kestrel
 * Analytics, Inc., the one fictional company the fakes, scenarios and the
 * sandbox demo use. Every file is validated here, so a fake never serves a
 * malformed fixture. Each call returns a fresh deep copy: a fake may mutate
 * its state without affecting another.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export const BUSINESS_FIXTURES_DIR = resolve(import.meta.dirname, "../../fixtures/business");

const isoInstant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "ISO instant");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stringMap = z.record(z.string(), z.string());

// --- company.json ------------------------------------------------------------

const companySchema = z.object({
  asOf: isoInstant,
  businessDate: isoDate,
  company: z.object({
    name: z.string(),
    domain: z.string(),
    timezone: z.string(),
    currency: z.string(),
    product: z.string(),
  }),
  people: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.string(),
      user: z.boolean().optional(),
    }),
  ),
  workspaceSettings: z.object({
    companyName: z.string(),
    agentName: z.string(),
    senderName: z.string(),
    emailSignature: z.string(),
    internalEmailDomains: z.array(z.string()),
    notifySlackChannel: z.string().nullable(),
    allowedSlackChannels: z.array(z.string()),
    timezone: z.string(),
    currency: z.string(),
    defaultModel: z.string().nullable(),
    defaultEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
  }),
  customers: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      domain: z.string(),
      contact: z.object({ name: z.string(), email: z.string(), title: z.string() }),
      stripeCustomer: z.string().nullable(),
      quickbooksCustomer: z.string().nullable(),
      hubspotCompany: z.string().nullable(),
      hubspotContact: z.string().nullable(),
      story: z.string(),
    }),
  ),
  digestWeek: z.object({ from: isoDate, to: isoDate }),
});
export type CompanyFixture = z.infer<typeof companySchema>;

// --- stripe.json ---------------------------------------------------------------

const stripeCard = z.object({
  brand: z.string(),
  last4: z.string(),
  exp_month: z.number().int(),
  exp_year: z.number().int(),
});

const stripeSchema = z.object({
  account: z.object({ id: z.string(), defaultCurrency: z.string(), apiVersion: z.string() }),
  balance: z.object({
    available: z.array(z.object({ amount: z.number().int(), currency: z.string() })),
    pending: z.array(z.object({ amount: z.number().int(), currency: z.string() })),
  }),
  customers: z.array(
    z.object({
      id: z.string(),
      created: z.number().int(),
      email: z.string().nullable(),
      name: z.string(),
      description: z.string().optional(),
      delinquent: z.boolean().optional(),
      metadata: stringMap.optional(),
    }),
  ),
  subscriptions: z.array(
    z.object({
      id: z.string(),
      created: z.number().int(),
      customer: z.string(),
      status: z.enum(["active", "past_due", "unpaid", "canceled", "trialing", "incomplete"]),
      price: z.object({
        id: z.string(),
        product: z.string(),
        nickname: z.string(),
        unit_amount: z.number().int(),
        currency: z.string(),
        interval: z.enum(["day", "week", "month", "year"]),
      }),
      quantity: z.number().int(),
      current_period_start: z.number().int(),
      current_period_end: z.number().int(),
      latest_invoice: z.string().nullable(),
      canceled_at: z.number().int().optional(),
      ended_at: z.number().int().optional(),
    }),
  ),
  invoices: z.array(
    z.object({
      id: z.string(),
      created: z.number().int(),
      customer: z.string(),
      subscription: z.string().nullable(),
      number: z.string(),
      status: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
      amount_due: z.number().int(),
      amount_paid: z.number().int(),
      currency: z.string(),
      charge: z.string().nullable(),
      payment_intent: z.string().nullable(),
      attempt_count: z.number().int().optional(),
      next_payment_attempt: z.number().int().optional(),
      period_start: z.number().int(),
      period_end: z.number().int(),
      lines: z.array(
        z.object({
          description: z.string(),
          amount: z.number().int(),
          price: z.string(),
          quantity: z.number().int(),
        }),
      ),
    }),
  ),
  charges: z.array(
    z.object({
      id: z.string(),
      created: z.number().int(),
      customer: z.string(),
      amount: z.number().int(),
      currency: z.string(),
      status: z.enum(["succeeded", "failed", "pending"]),
      description: z.string().nullable(),
      invoice: z.string().nullable(),
      payment_intent: z.string(),
      card: stripeCard,
      metadata: stringMap.optional(),
      amount_refunded: z.number().int().optional(),
      failure_code: z.string().optional(),
      failure_message: z.string().optional(),
      decline_code: z.string().optional(),
    }),
  ),
  refunds: z.array(
    z.object({
      id: z.string(),
      created: z.number().int(),
      charge: z.string(),
      amount: z.number().int(),
      reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).nullable(),
      status: z.enum(["pending", "succeeded", "failed", "canceled"]),
      metadata: stringMap.optional(),
    }),
  ),
});
export type StripeFixture = z.infer<typeof stripeSchema>;

// --- quickbooks.json -------------------------------------------------------------

const ref = z.object({ value: z.string(), name: z.string().optional() });
const address = z.object({
  Line1: z.string(),
  City: z.string(),
  CountrySubDivisionCode: z.string(),
  PostalCode: z.string(),
  Country: z.string(),
});

const quickbooksSchema = z.object({
  realmId: z.string(),
  timezone: z.string(),
  queryPageCap: z.number().int().positive(),
  nextDocNumber: z.number().int(),
  companyInfo: z.object({
    CompanyName: z.string(),
    LegalName: z.string(),
    CompanyAddr: address,
    CustomerCommunicationAddr: address,
    Email: z.object({ Address: z.string() }),
    WebAddr: z.object({ URI: z.string() }),
    PrimaryPhone: z.object({ FreeFormNumber: z.string() }),
    CompanyStartDate: isoDate,
    FiscalYearStartMonth: z.string(),
    Country: z.string(),
    SupportedLanguages: z.string(),
  }),
  terms: z.array(z.object({ Id: z.string(), Name: z.string(), DueDays: z.number().int() })),
  items: z.array(
    z.object({ Id: z.string(), Name: z.string(), Description: z.string(), UnitPrice: z.number() }),
  ),
  customers: z.array(
    z.object({
      Id: z.string(),
      DisplayName: z.string(),
      CompanyName: z.string(),
      GivenName: z.string(),
      FamilyName: z.string(),
      PrimaryEmailAddr: z.object({ Address: z.string() }),
      BillAddr: address,
      SalesTermRef: z.object({ value: z.string() }),
      CreateTime: z.string(),
    }),
  ),
  invoices: z.array(
    z.object({
      Id: z.string(),
      DocNumber: z.string(),
      TxnDate: isoDate,
      DueDate: isoDate,
      CustomerRef: ref,
      BillEmail: z.object({ Address: z.string() }),
      SalesTermRef: ref,
      EmailStatus: z.enum(["NotSet", "NeedToSend", "EmailSent"]),
      CreateTime: z.string(),
      PrivateNote: z.string().optional(),
      Line: z.array(
        z.object({
          Description: z.string(),
          Amount: z.number(),
          ItemRef: ref,
          Qty: z.number(),
          UnitPrice: z.number(),
        }),
      ),
    }),
  ),
  payments: z.array(
    z.object({
      Id: z.string(),
      TxnDate: isoDate,
      CustomerRef: ref,
      TotalAmt: z.number(),
      PaymentRefNum: z.string(),
      PrivateNote: z.string().optional(),
      CreateTime: z.string(),
      Line: z.array(
        z.object({
          Amount: z.number(),
          LinkedTxn: z.array(z.object({ TxnId: z.string(), TxnType: z.literal("Invoice") })),
        }),
      ),
    }),
  ),
});
export type QuickBooksFixture = z.infer<typeof quickbooksSchema>;

// --- hubspot.json ------------------------------------------------------------------

export const HUBSPOT_OBJECT_TYPES = ["contacts", "companies", "deals", "notes", "tasks"] as const;
export type HubSpotObjectType = (typeof HUBSPOT_OBJECT_TYPES)[number];

const hubspotProperty = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "datetime", "date", "enumeration", "bool"]),
  fieldType: z.string(),
  groupName: z.string(),
  options: z.union([z.array(z.string()), z.literal("owners")]).optional(),
  readOnly: z.boolean().optional(),
  required: z.boolean().optional(),
});
export type HubSpotPropertyFixture = z.infer<typeof hubspotProperty>;

const hubspotRecord = z.object({
  id: z.string().regex(/^\d+$/),
  createdAt: isoInstant,
  properties: stringMap,
});

const hubspotSchema = z.object({
  portal: z.object({
    hubId: z.number().int(),
    uiDomain: z.string(),
    accountType: z.string(),
    timeZone: z.string(),
    companyCurrency: z.string(),
    utcOffset: z.string(),
    utcOffsetMilliseconds: z.number().int(),
    dataHostingLocation: z.string(),
  }),
  token: z.object({
    userId: z.number().int(),
    appId: z.number().int(),
    scopes: z.array(z.string()),
  }),
  owners: z.array(
    z.object({
      id: z.string(),
      userId: z.number().int(),
      email: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  ),
  properties: z.object({
    contacts: z.array(hubspotProperty),
    companies: z.array(hubspotProperty),
    deals: z.array(hubspotProperty),
    notes: z.array(hubspotProperty),
    tasks: z.array(hubspotProperty),
  }),
  objects: z.object({
    contacts: z.array(hubspotRecord),
    companies: z.array(hubspotRecord),
    deals: z.array(hubspotRecord),
    notes: z.array(hubspotRecord),
    tasks: z.array(hubspotRecord),
  }),
  associations: z.array(
    z.object({
      from: z.enum(HUBSPOT_OBJECT_TYPES),
      fromId: z.string(),
      to: z.enum(HUBSPOT_OBJECT_TYPES),
      toId: z.string(),
      typeId: z.number().int(),
    }),
  ),
});
export type HubSpotFixture = z.infer<typeof hubspotSchema>;

// --- gmail.json, google-calendar.json, composio.json ----------------------------------

const gmailSchema = z.object({
  mailbox: z.string(),
  labels: z.array(z.object({ id: z.string(), name: z.string(), type: z.enum(["system", "user"]) })),
  messages: z.array(
    z.object({
      id: z.string().regex(/^[0-9a-f]{16}$/),
      threadId: z.string().regex(/^[0-9a-f]{16}$/),
      labelIds: z.array(z.string()),
      from: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()).optional(),
      subject: z.string(),
      date: isoInstant,
      body: z.string(),
    }),
  ),
});
export type GmailFixture = z.infer<typeof gmailSchema>;

const calendarSchema = z.object({
  calendarId: z.string(),
  timezone: z.string(),
  workingHours: z.object({ start: z.string(), end: z.string() }),
  events: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      description: z.string().optional(),
      start: isoInstant,
      end: isoInstant,
      attendees: z.array(z.string()),
    }),
  ),
});
export type CalendarFixture = z.infer<typeof calendarSchema>;

const connectionStatus = z.enum(["ACTIVE", "INITIATED", "EXPIRED", "FAILED", "INACTIVE"]);
export type ComposioConnectionStatus = z.infer<typeof connectionStatus>;

const composioSchema = z.object({
  userId: z.string(),
  connections: z.object({
    gmail: z.object({ id: z.string(), status: connectionStatus, authConfigId: z.string() }),
    googlecalendar: z.object({
      id: z.string(),
      status: connectionStatus,
      authConfigId: z.string(),
    }),
  }),
});
export type ComposioFixture = z.infer<typeof composioSchema>;

// --- slack.json ------------------------------------------------------------------------

const slackSchema = z.object({
  team: z.object({ id: z.string(), name: z.string(), domain: z.string(), url: z.string() }),
  bot: z.object({
    userId: z.string(),
    botId: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
  }),
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      realName: z.string(),
      email: z.string(),
      title: z.string(),
    }),
  ),
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isPrivate: z.boolean(),
      isArchived: z.boolean(),
      botIsMember: z.boolean(),
      created: z.number().int(),
      topic: z.string(),
      members: z.array(z.string()),
    }),
  ),
  messages: z.array(
    z.object({
      channel: z.string(),
      ts: z.string().regex(/^\d{10}\.\d{6}$/),
      user: z.string(),
      text: z.string(),
      threadTs: z.string().optional(),
    }),
  ),
});
export type SlackFixture = z.infer<typeof slackSchema>;

// --- All of them ------------------------------------------------------------------------

export interface BusinessFixtures {
  readonly company: CompanyFixture;
  readonly stripe: StripeFixture;
  readonly quickbooks: QuickBooksFixture;
  readonly hubspot: HubSpotFixture;
  readonly gmail: GmailFixture;
  readonly calendar: CalendarFixture;
  readonly composio: ComposioFixture;
  readonly slack: SlackFixture;
}

function load<T>(file: string, schema: z.ZodType<T>): T {
  const raw: unknown = JSON.parse(readFileSync(join(BUSINESS_FIXTURES_DIR, file), "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`test/fixtures/business/${file} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** A fresh, validated copy of every business fixture. */
export function loadBusinessFixtures(): BusinessFixtures {
  return {
    company: load("company.json", companySchema),
    stripe: load("stripe.json", stripeSchema),
    quickbooks: load("quickbooks.json", quickbooksSchema),
    hubspot: load("hubspot.json", hubspotSchema),
    gmail: load("gmail.json", gmailSchema),
    calendar: load("google-calendar.json", calendarSchema),
    composio: load("composio.json", composioSchema),
    slack: load("slack.json", slackSchema),
  };
}
