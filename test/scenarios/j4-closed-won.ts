/**
 * J4 Closed-won handoff: the Solstice Energy deal closed won in HubSpot.
 * The agent reads the deal and its contact, finds no QuickBooks customer and
 * creates one (automatic), creates the invoice (financial: approval), sends
 * it (financial: approval) and posts to #sales-ops (allowlisted: automatic).
 */
import type { Fakes } from "../support/fakes/index.js";
import { Checks, expectedIdempotencyKey, firstLine, SOLSTICE } from "./facts.js";
import { type Scenario, type Step, type StepContext, text } from "./script.js";
import { hubspot, quickbooks, slack } from "./tools.js";

export const J4_PROMPT =
  "Solstice Energy closed-won this week. Set them up in QuickBooks, invoice them, send the invoice and tell #sales-ops.";

const findDeal: Step = () => [
  text("Finding the closed-won deal in HubSpot."),
  hubspot.search("j4_deals", {
    objectType: "deals",
    filterGroups: [
      {
        filters: [
          { propertyName: "dealstage", operator: "EQ", value: "closedwon" },
          { propertyName: "closedate", operator: "GTE", value: "2026-09-21T00:00:00Z" },
        ],
      },
    ],
    properties: ["dealname", "amount", "closedate", "description", "hubspot_owner_id"],
  }),
];

const contactAndCustomer: Step = (context) => [
  hubspot.listAssociations("j4_deal_contacts", {
    objectType: "deals",
    objectId: context.pick("j4_deals", /"id":\s*"(\d+)"/, SOLSTICE.hubspotDeal),
    toObjectType: "contacts",
  }),
  quickbooks.findCustomers("j4_existing", { name: "Solstice" }),
];

const readContact: Step = (context) => [
  hubspot.batchRead("j4_contact", {
    objectType: "contacts",
    ids: [context.pick("j4_deal_contacts", /"toObjectId":\s*(\d+)/, SOLSTICE.hubspotContact)],
    properties: ["firstname", "lastname", "email", "jobtitle"],
  }),
];

const createCustomer: Step = () => [
  text(
    "Solstice Energy Cooperative is not a QuickBooks customer yet; creating it with Marco Bellini as the billing contact.",
  ),
  quickbooks.createCustomer("j4_customer", {
    display_name: SOLSTICE.name,
    company_name: SOLSTICE.name,
    given_name: SOLSTICE.givenName,
    family_name: SOLSTICE.familyName,
    email: SOLSTICE.contactEmail,
  }),
];

const createInvoice: Step = (context) => [
  text(
    "Creating the invoice: Enterprise plan (annual), $18,000.00, due October 28 (Net 30). This needs your approval.",
  ),
  quickbooks.createInvoice("j4_invoice", {
    customer_id: context.pick("j4_customer", /"id":\s*"(\d+)"/, SOLSTICE.expectedCustomerId),
    lines: [
      {
        description: "Kestrel Enterprise plan, annual (Oct 2026 – Sep 2027)",
        quantity: 1,
        unit_price_minor: SOLSTICE.amountMinor,
        item_id: SOLSTICE.quickbooksItem,
      },
    ],
    due_date: SOLSTICE.dueDate,
    customer_memo: "Thank you for choosing Kestrel Analytics.",
  }),
];

const sendInvoice: Step = (context) => {
  const invoice = context.result("j4_invoice");
  if (invoice === undefined || invoice.isError) {
    return [
      text(
        `QuickBooks refused the invoice: ${firstLine(invoice?.text)} The Solstice customer was created; no invoice was created or sent, and #sales-ops was not told.`,
      ),
    ];
  }
  return [
    text(
      `Invoice ${context.pick("j4_invoice", /"doc_number":\s*"(\d+)"/, SOLSTICE.expectedDocNumber)} is created. Sending it to marco@solstice.test needs your approval.`,
    ),
    quickbooks.sendInvoice("j4_send", {
      invoice_id: context.pick("j4_invoice", /"id":\s*"(\d+)"/, SOLSTICE.expectedInvoiceId),
    }),
  ];
};

const announce: Step = (context) => {
  const sent = context.result("j4_send");
  if (sent === undefined || sent.isError) {
    return [
      text(
        `The invoice was created but not sent (${firstLine(sent?.text)}). I did not post to #sales-ops.`,
      ),
    ];
  }
  const number = context.pick("j4_invoice", /"doc_number":\s*"(\d+)"/, SOLSTICE.expectedDocNumber);
  return [
    slack.postMessage("j4_post", {
      channel: "#sales-ops",
      text: `Solstice Energy Cooperative is set up in QuickBooks. Invoice ${number} for $18,000.00 (Enterprise annual, due Oct 28) was sent to marco@solstice.test.`,
    }),
  ];
};

function summary(context: StepContext): string {
  const post = context.result("j4_post");
  return [
    "Created Solstice Energy Cooperative in QuickBooks, invoiced $18,000.00 (due Oct 28) and emailed the invoice to Marco Bellini.",
    post !== undefined && !post.isError
      ? "Posted the handoff to #sales-ops."
      : `Posting to #sales-ops failed: ${firstLine(post?.text)}`,
  ].join(" ");
}

export const J4_STEPS: readonly Step[] = [
  findDeal,
  contactAndCustomer,
  readContact,
  createCustomer,
  createInvoice,
  sendInvoice,
  announce,
  (context) => [text(summary(context))],
];

export const J4_CLOSED_WON: Scenario = {
  id: "j4-closed-won",
  job: "J4",
  title: "Hand a closed-won deal to billing",
  prompt: J4_PROMPT,
  steps: J4_STEPS,
  approvals: { j4_invoice: "approve", j4_send: "approve" },
  expected: { status: "completed", replyIncludes: ["invoiced $18,000.00", "#sales-ops"] },
  verify: (fakes, run) => {
    const checks = new Checks();
    const customer = fakes.quickbooks.customerByName(SOLSTICE.name);
    checks.that(customer !== undefined, "the Solstice customer exists in QuickBooks");
    const invoices =
      customer === undefined ? [] : fakes.quickbooks.invoicesFor(String(customer.Id));
    checks.equal(
      invoices.map((invoice) => [invoice.TotalAmt, invoice.DueDate, invoice.EmailStatus]),
      [[18000, SOLSTICE.dueDate, "EmailSent"]],
      "one $18,000.00 invoice due Oct 28, sent",
    );
    checks.equal(
      fakes.quickbooks.sentInvoices.map((entry) => entry.to),
      [SOLSTICE.contactEmail],
      "sent once, to Marco",
    );
    checks.equal(
      fakes.quickbooks
        .writes()
        .filter((write) => !write.replayed)
        .map((write) => write.requestId),
      ["j4_customer", "j4_invoice", "j4_send"].map((id) =>
        expectedIdempotencyKey(run.runId, `toolu_${id}`),
      ),
      "each QuickBooks write carries sha256(runId:toolUseId) as requestid",
    );
    checks.equal(
      fakes.slack.posts().map((post) => post.channelName),
      ["#sales-ops"],
      "one post, in #sales-ops",
    );
    checks.equal(fakes.stripe.writes().length, 0, "no Stripe writes");
    return checks.problems;
  },
};

/** Invoice creation fails with a QuickBooks Fault after approval. */
export function verifyInvoiceFault(fakes: Fakes): string[] {
  const checks = new Checks();
  const customer = fakes.quickbooks.customerByName(SOLSTICE.name);
  checks.that(customer !== undefined, "the Solstice customer was created");
  checks.equal(
    customer === undefined ? 0 : fakes.quickbooks.invoicesFor(String(customer.Id)).length,
    0,
    "no invoice",
  );
  checks.equal(fakes.quickbooks.sentInvoices.length, 0, "nothing sent");
  checks.equal(fakes.slack.posts().length, 0, "no Slack post");
  return checks.problems;
}
