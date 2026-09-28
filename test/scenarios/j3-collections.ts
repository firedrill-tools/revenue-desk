/**
 * J3 Collections: overdue QuickBooks invoices (read through size-truncated
 * pages), cross-checked against Stripe for payments nobody recorded
 * (Meridian's 1051), reminder drafts (automatic), and for the invoice 60+
 * days overdue (Copperleaf 1043) a Google Calendar call with an external
 * attendee (outbound: approval) plus a HubSpot task (automatic).
 */
import type { Fakes } from "../support/fakes/index.js";
import {
  BLUEFIN,
  BUSINESS_DATE,
  Checks,
  COPPERLEAF,
  firstLine,
  JORDAN,
  MERIDIAN,
  TIDEWATER,
} from "./facts.js";
import { type Scenario, type Step, type StepContext, text, thinking } from "./script.js";
import { ASSOCIATION, associate, calendar, gmail, hubspot, quickbooks, stripe } from "./tools.js";

export const J3_PROMPT =
  "Run collections: find overdue invoices, check Stripe for payments we have not recorded, draft reminders, and set up a call for anything 60 or more days overdue.";

const overdue: Step = () => [
  thinking(
    "List open invoices past due, then match them against Stripe payments before writing to anyone.",
  ),
  quickbooks.listInvoices("j3_overdue", {
    status: "open",
    due_before: BUSINESS_DATE,
    as_of: BUSINESS_DATE,
  }),
];

const crossCheck: Step = (context) => {
  const listed = context.result("j3_overdue")?.text ?? "";
  const missing = [COPPERLEAF.invoice, TIDEWATER.invoice, MERIDIAN.invoice, BLUEFIN.invoice].filter(
    (number) => !listed.includes(number),
  );
  return [
    text(
      missing.length === 0
        ? "Four invoices are overdue: 1043 (Copperleaf), 1048 (Tidewater), 1051 (Meridian) and 1055 (Bluefin). Checking Stripe for payments against them."
        : `Some overdue invoices are missing from the list (${missing.join(", ")}); checking Stripe anyway.`,
    ),
    stripe.listCharges("j3_charges", { created_after: "2026-06-01", limit: 100 }),
    quickbooks.listPayments("j3_payments", { received_from: "2026-06-01" }),
  ];
};

const TIDEWATER_REMINDER = [
  "Hi Omar,",
  "",
  "Sorry the PDF never reached your AP inbox. Invoice 1048 ($2,400.00, due August 25) is attached again; it is now 34 days past due. Could you schedule it this week?",
  "",
  "Thanks,",
  "Maya",
].join("\n");

const BLUEFIN_REMINDER = [
  "Hi Lena,",
  "",
  "Thank you for the $750.00 payment on invoice 1055. The remaining $750.00 was due on September 20. You mentioned paying it by October 15; please let me know if that is still the plan.",
  "",
  "Best,",
  "Maya",
].join("\n");

const COPPERLEAF_REMINDER = [
  "Hi Theo,",
  "",
  "Invoice 1043 ($3,600.00) is now 70 days past due. I'd like to find a way to settle it; I'm sending a short call invite for Wednesday. Could you confirm it works?",
  "",
  "Thanks,",
  "Maya",
].join("\n");

const drafts: Step = (context) => {
  const stripeCharges = context.result("j3_charges")?.text ?? "";
  const unrecorded = stripeCharges.includes(MERIDIAN.unrecordedCharge);
  return [
    text(
      unrecorded
        ? `Stripe charge ${MERIDIAN.unrecordedCharge} ($1,980.00, Sep 10) paid Meridian's invoice 1051, but QuickBooks has no payment for it, so I will not chase Meridian. Drafting reminders for 1048, 1055 and 1043.`
        : "No Stripe payment matches an overdue invoice. Drafting reminders.",
    ),
    gmail.createDraft("j3_draft_tidewater", {
      recipient_email: TIDEWATER.contactEmail,
      thread_id: TIDEWATER.gmailThread,
      body: TIDEWATER_REMINDER,
    }),
    gmail.createDraft("j3_draft_bluefin", {
      recipient_email: BLUEFIN.contactEmail,
      subject: "Invoice 1055: $750.00 remaining",
      body: BLUEFIN_REMINDER,
    }),
    gmail.createDraft("j3_draft_copperleaf", {
      recipient_email: COPPERLEAF.contactEmail,
      thread_id: COPPERLEAF.reminderThread,
      body: COPPERLEAF_REMINDER,
    }),
  ];
};

const findSlot: Step = () => [
  text("Invoice 1043 is 70 days overdue. Finding a slot for a call with Copperleaf."),
  calendar.findFreeSlots("j3_slots", {
    time_min: "2026-09-29T09:00:00",
    time_max: "2026-10-01T17:00:00",
    timezone: "America/New_York",
  }),
  hubspot.search("j3_company", {
    objectType: "companies",
    query: "copperleaf.test",
    properties: ["name", "domain", "hubspot_owner_id"],
  }),
];

const proposeCall: Step = (context) => [
  text(
    "Wednesday 1:00–1:30 pm is free. The invite goes to theo@copperleaf.test, outside the company, so it needs your approval. Creating the follow-up task in HubSpot as well.",
  ),
  calendar.createEvent("j3_call", {
    summary: "Copperleaf Studios: invoice 1043",
    start_datetime: "2026-09-30T13:00:00",
    timezone: "America/New_York",
    event_duration_minutes: 30,
    attendees: [COPPERLEAF.contactEmail],
    description:
      "Invoice 1043 ($3,600.00), due July 20, is 70 days past due. Agree a payment date.",
    send_updates: "all",
  }),
  hubspot.createTask("j3_task", {
    subject: "Call Copperleaf about invoice 1043 ($3,600.00, 70 days overdue)",
    body: "Reminder drafted in Gmail; call proposed for Sep 30 at 1:00 pm.",
    due: "2026-09-30T17:00:00Z",
    ownerId: JORDAN.hubspotOwner,
    priority: "HIGH",
    type: "CALL",
    associations: [
      associate(
        context.pick("j3_company", /"id":\s*"(\d+)"/, COPPERLEAF.hubspotCompany),
        ASSOCIATION.taskToCompany,
      ),
      associate(COPPERLEAF.hubspotContact, ASSOCIATION.taskToContact),
    ],
  }),
];

function summary(context: StepContext): string {
  const call = context.result("j3_call");
  const task = context.result("j3_task");
  return [
    "Overdue: 1043 Copperleaf $3,600.00 (70 days), 1048 Tidewater $2,400.00 (34 days), 1055 Bluefin $750.00 (8 days).",
    `Invoice 1051 (Meridian, $1,980.00) was paid in Stripe (${MERIDIAN.unrecordedCharge}) but not recorded in QuickBooks; record that payment rather than send a reminder.`,
    "Drafted reminders to Omar, Lena and Theo; nothing was sent.",
    call !== undefined && !call.isError
      ? "Invited Theo to a call on Sep 30 at 1:00 pm."
      : `No call was scheduled (${firstLine(call?.text)}).`,
    task !== undefined && !task.isError
      ? "Created a HubSpot call task for Jordan."
      : `The HubSpot task failed: ${firstLine(task?.text)}`,
  ].join(" ");
}

export const J3_STEPS: readonly Step[] = [
  overdue,
  crossCheck,
  drafts,
  findSlot,
  proposeCall,
  (context) => [text(summary(context))],
];

function verifyJ3(fakes: Fakes, options: { readonly callApproved: boolean }): string[] {
  const checks = new Checks();
  const invoiceQueries = fakes.quickbooks.requests.filter(
    (entry) =>
      entry.path.endsWith("/query") &&
      (entry.query.query?.[0] ?? entry.body).includes("FROM Invoice"),
  );
  checks.that(
    invoiceQueries.length >= 3,
    `QuickBooks invoices were read page by page until an empty page (saw ${invoiceQueries.length} queries)`,
  );
  checks.equal(
    fakes.composio.gmail
      .draftList()
      .map((draft) => draft.to[0])
      .sort(),
    [BLUEFIN.contactEmail, COPPERLEAF.contactEmail, TIDEWATER.contactEmail].sort(),
    "three reminder drafts, none to Meridian",
  );
  checks.equal(fakes.composio.gmail.outbox.length, 0, "no email sent");
  checks.equal(
    fakes.composio.calendar.invitations.map((entry) => entry.email),
    options.callApproved ? [COPPERLEAF.contactEmail] : [],
    options.callApproved ? "one invitation, to Theo" : "no invitation",
  );
  const tasks = fakes.hubspot.crm.created("tasks", fakes.hubspot.crm.firstCreatedId);
  checks.equal(tasks.length, 1, "one HubSpot task");
  checks.that(
    JSON.stringify(tasks).includes(`"toId":"${COPPERLEAF.hubspotCompany}"`),
    "the task is on Copperleaf's company record",
  );
  checks.equal(fakes.quickbooks.writes().length, 0, "no QuickBooks writes");
  checks.equal(fakes.stripe.writes().length, 0, "no Stripe writes");
  return checks.problems;
}

export const J3_COLLECTIONS: Scenario = {
  id: "j3-collections",
  job: "J3",
  title: "Chase overdue invoices and book a call for the oldest",
  prompt: J3_PROMPT,
  steps: J3_STEPS,
  approvals: { j3_call: "approve" },
  expected: { status: "completed", replyIncludes: ["Invited Theo", "not recorded in QuickBooks"] },
  verify: (fakes) => verifyJ3(fakes, { callApproved: true }),
};

export const J3_CALL_DENIED: Scenario = {
  ...J3_COLLECTIONS,
  id: "j3-collections-call-denied",
  title: "Collections, with the external call invite denied",
  approvals: { j3_call: "deny" },
  expected: { status: "completed", replyIncludes: ["No call was scheduled"] },
  verify: (fakes) => verifyJ3(fakes, { callApproved: false }),
};
