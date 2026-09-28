/**
 * J5 Weekly digest: new and won HubSpot deals, Stripe payments and refunds,
 * and QuickBooks AR aging for Sep 21–28, posted to #revenue (allowlisted:
 * automatic). The numbers follow from the fixtures and are checked there.
 */
import type { Fakes } from "../support/fakes/index.js";
import { BUSINESS_DATE, Checks, DIGEST_FROM, firstLine } from "./facts.js";
import { type Scenario, type Step, type StepContext, text } from "./script.js";
import { hubspot, quickbooks, slack, stripe } from "./tools.js";

export const J5_PROMPT = "Post the weekly revenue digest for Sep 21–28 to #revenue.";

export const J5_DIGEST = [
  "*Weekly revenue digest, Sep 21–28*",
  "• New deals: Pinecrest Schools – Growth plan ($5,880), Orbital Foods – Starter plan ($1,788).",
  "• Closed won: Solstice Energy – Enterprise annual ($18,000).",
  "• Card payments: 3 succeeded for $1,129.00 (Harbor & Pine twice on Sep 22, a suspected duplicate; Lumen Yoga). 1 failed: Northgate Clinics $490.00, card declined.",
  "• Refunds: $49.00 (Lumen Yoga, partial).",
  "• Open AR $9,028.00: current $298.00; 1–30 days $2,730.00; 31–60 days $2,400.00; 61–90 days $3,600.00 (Copperleaf 1043).",
].join("\n");

const gather: Step = () => [
  text("Gathering the week's deals, payments, refunds and receivables."),
  hubspot.search("j5_new_deals", {
    objectType: "deals",
    filterGroups: [
      {
        filters: [
          { propertyName: "createdate", operator: "GTE", value: `${DIGEST_FROM}T00:00:00Z` },
        ],
      },
    ],
    properties: ["dealname", "amount", "dealstage", "createdate"],
  }),
  hubspot.search("j5_won_deals", {
    objectType: "deals",
    filterGroups: [
      {
        filters: [
          { propertyName: "dealstage", operator: "EQ", value: "closedwon" },
          { propertyName: "closedate", operator: "GTE", value: `${DIGEST_FROM}T00:00:00Z` },
        ],
      },
    ],
    properties: ["dealname", "amount", "closedate"],
  }),
  stripe.listCharges("j5_charges", { created_after: DIGEST_FROM, limit: 100 }),
  stripe.listRefunds("j5_refunds", { created_after: DIGEST_FROM, limit: 100 }),
  quickbooks.listInvoices("j5_open", { status: "open", as_of: BUSINESS_DATE }),
];

const post: Step = () => [
  text(`Here is the digest; posting it to #revenue.\n\n${J5_DIGEST}`),
  slack.postMessage("j5_post", { channel: "#revenue", text: J5_DIGEST }),
];

function summary(context: StepContext): string {
  const posted = context.result("j5_post");
  return posted !== undefined && !posted.isError
    ? "Posted the weekly digest to #revenue."
    : `The digest was not posted to #revenue: ${firstLine(posted?.text)}`;
}

export const J5_STEPS: readonly Step[] = [gather, post, (context) => [text(summary(context))]];

export const J5_WEEKLY_DIGEST: Scenario = {
  id: "j5-weekly-digest",
  job: "J5",
  title: "Post the weekly revenue digest",
  prompt: J5_PROMPT,
  steps: J5_STEPS,
  approvals: {},
  expected: { status: "completed", replyIncludes: ["Posted the weekly digest to #revenue"] },
  verify: (fakes) => verifyDigestPosted(fakes),
};

export function verifyDigestPosted(fakes: Fakes): string[] {
  const checks = new Checks();
  checks.equal(
    fakes.slack.posts().map((entry) => [entry.channelName, entry.text]),
    [["#revenue", J5_DIGEST]],
    "the digest, once, in #revenue",
  );
  checks.equal(
    fakes.stripe.writes().length + fakes.quickbooks.writes().length + fakes.hubspot.writes().length,
    0,
    "no writes besides the post",
  );
  return checks.problems;
}
