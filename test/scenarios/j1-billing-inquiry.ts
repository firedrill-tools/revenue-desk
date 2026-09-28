/**
 * J1 Billing inquiry: Dana at Harbor & Pine asks why she was charged twice.
 * The agent reads the Gmail thread (Composio), looks her up in Stripe and
 * QuickBooks (API) and HubSpot (MCP), drafts a reply (automatic) and sends it
 * (outbound: approval). Reads across all three connection kinds.
 */
import type { Fakes } from "../support/fakes/index.js";
import { Checks, firstLine, HARBOR_PINE } from "./facts.js";
import { type Scenario, type Step, type StepContext, text, thinking } from "./script.js";
import { gmail, hubspot, quickbooks, stripe } from "./tools.js";

export const J1_PROMPT =
  "Dana Whitfield from Harbor & Pine says they were charged twice in September. Look into it and reply to her.";

export const J1_REPLY_BODY = [
  "Hi Dana,",
  "",
  "Thanks for flagging this. You're right: your card was charged $490.00 twice on September 22. The second charge was a manual retry and duplicates your September Growth plan payment, which QuickBooks shows as paid.",
  "",
  // Until the refund is approved and made, the customer hears only what was found (src/agent/prompt.ts).
  "We found two $490.00 charges on September 22 and are reviewing the second one; we'll follow up shortly.",
  "",
  "Best,",
  "Maya Lindqvist",
  "Revenue Operations, Kestrel Analytics",
].join("\n");

const readInbox: Step = () => [
  thinking("Read Dana's email first, then check Stripe, QuickBooks and HubSpot before answering."),
  text("Checking Dana's email and Harbor & Pine's records."),
  gmail.fetchEmails("j1_inbox", { query: `from:${HARBOR_PINE.contactEmail}`, max_results: 5 }),
];

const lookUp: Step = (context) => [
  stripe.findCustomers("j1_stripe_customer", { email: HARBOR_PINE.contactEmail }),
  quickbooks.findCustomers("j1_qbo_customer", { email: HARBOR_PINE.contactEmail }),
  ...(context.offersIntegration("hubspot")
    ? [
        hubspot.search("j1_contact", {
          objectType: "contacts",
          query: HARBOR_PINE.contactEmail,
          properties: ["firstname", "lastname", "email", "company", "hubspot_owner_id"],
        }),
      ]
    : []),
];

const charges: Step = (context) => [
  stripe.listCharges("j1_charges", {
    customer: context.pick("j1_stripe_customer", /(cus_\w+)/, HARBOR_PINE.stripeCustomer),
    created_after: "2026-09-01",
    limit: 10,
  }),
  quickbooks.listInvoices("j1_invoices", {
    customer_id: context.pick("j1_qbo_customer", /"id":\s*"(\d+)"/, HARBOR_PINE.quickbooksCustomer),
    status: "all",
    issued_from: "2026-09-01",
  }),
];

const draft: Step = (context) => [
  text(
    `Stripe shows two $490.00 charges on September 22: ${HARBOR_PINE.paidCharge} paid the September invoice and ${context.pick("j1_charges", /(ch_KAhp_0922b)/, HARBOR_PINE.duplicateCharge)}, four minutes later, has no invoice. QuickBooks invoice 1049 is paid once. Drafting a reply.`,
  ),
  gmail.createDraft("j1_draft", {
    recipient_email: HARBOR_PINE.contactEmail,
    thread_id: HARBOR_PINE.gmailThread,
    body: J1_REPLY_BODY,
  }),
];

const send: Step = (context) => [
  text("The draft is ready. Sending it to dana@harborpine.test needs your approval."),
  gmail.sendDraft("j1_send", context.pick("j1_draft", /"id":\s*"(r-[^"]+)"/, "r-missing")),
];

function finalReply(context: StepContext): string {
  const sent = context.result("j1_send");
  const hubspotNote = context.offersIntegration("hubspot")
    ? "HubSpot lists Priya Natarajan as the account owner."
    : "HubSpot was unavailable, so I could not check the account owner.";
  const outcome =
    sent !== undefined && !sent.isError
      ? "I replied to Dana: the $490.00 duplicate charge from September 22 will be refunded."
      : `The reply is saved as a draft and was not sent (${firstLine(sent?.text)}).`;
  return `${outcome} ${hubspotNote} Next step: refund ${HARBOR_PINE.duplicateCharge} in Stripe.`;
}

export const J1_STEPS: readonly Step[] = [
  readInbox,
  lookUp,
  charges,
  draft,
  send,
  (context) => [text(finalReply(context))],
];

/** The J1 checks: one reply, to Dana only, in her thread; nothing written anywhere else. */
export function verifyJ1(fakes: Fakes, options: { readonly sent: boolean }): string[] {
  const checks = new Checks();
  const outbox = fakes.composio.gmail.outbox;
  if (options.sent) {
    checks.equal(
      outbox.map((mail) => ({ to: mail.to, threadId: mail.threadId, via: mail.via })),
      [{ to: [HARBOR_PINE.contactEmail], threadId: HARBOR_PINE.gmailThread, via: "draft" }],
      "exactly one email, to Dana, in her thread",
    );
  } else {
    checks.equal(outbox.length, 0, "no email sent");
    checks.equal(fakes.composio.gmail.draftList().length, 1, "the reply stays a draft");
  }
  checks.equal(fakes.stripe.writes().length, 0, "no Stripe writes");
  checks.equal(fakes.quickbooks.writes().length, 0, "no QuickBooks writes");
  checks.equal(fakes.hubspot.writes().length, 0, "no HubSpot writes");
  checks.equal(fakes.slack.posts().length, 0, "no Slack posts");
  return checks.problems;
}

export const J1_BILLING_INQUIRY: Scenario = {
  id: "j1-billing-inquiry",
  job: "J1",
  title: "Answer a double-charge question from the inbox",
  prompt: J1_PROMPT,
  steps: J1_STEPS,
  approvals: { j1_send: "approve" },
  expected: { status: "completed", replyIncludes: ["I replied to Dana"] },
  verify: (fakes) => {
    const checks = new Checks();
    checks.problems.push(...verifyJ1(fakes, { sent: true }));
    const composioReads = fakes.composio.toolCalls.filter(
      (entry) => entry.tool === "GMAIL_FETCH_EMAILS",
    );
    checks.equal(composioReads.length, 1, "one Gmail search (Composio)");
    checks.that(
      fakes.hubspot.requests.some((entry) => entry.path === "/crm/v3/objects/contacts/search"),
      "HubSpot contact search reached the CRM (MCP)",
    );
    checks.that(
      fakes.stripe.requests.some((entry) => entry.path === "/v1/charges"),
      "Stripe charges were listed (API)",
    );
    return checks.problems;
  },
};
