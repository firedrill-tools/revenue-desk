/**
 * J5 Weekly digest: new and won HubSpot deals and Stripe payments and
 * refunds for Sep 21–28. QuickBooks (AR aging) and Slack are Composio
 * toolkits nobody connected in the fake world, so the digest leaves AR out,
 * comes back in the reply and is not posted, and the reply says so. The
 * numbers follow from the fixtures and are checked there.
 */
import type { Fakes } from "../support/fakes/index.js";
import { Checks, DIGEST_FROM } from "./facts.js";
import { type Scenario, type Step, text } from "./script.js";
import { hubspot, stripe } from "./tools.js";

export const J5_PROMPT = "Post the weekly revenue digest for Sep 21–28 to #revenue.";

export const J5_DIGEST = [
  "**Weekly revenue digest, Sep 21–28**",
  "- New deals: Pinecrest Schools – Growth plan ($5,880), Orbital Foods – Starter plan ($1,788).",
  "- Closed won: Solstice Energy – Enterprise annual ($18,000).",
  "- Card payments: 3 succeeded for $1,129.00 (Harbor & Pine twice on Sep 22, a suspected duplicate; Lumen Yoga). 1 failed: Northgate Clinics $490.00, card declined.",
  "- Refunds: $49.00 (Lumen Yoga, partial).",
].join("\n");

/** What the reply says instead of claiming a post, when QuickBooks and Slack are unavailable. */
export const J5_NOT_POSTED =
  "Slack is not connected, so the digest was not posted to #revenue, and QuickBooks is not connected, so it has no AR aging.";

const gather: Step = () => [
  text("Gathering the week's deals, payments and refunds."),
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
];

export const J5_STEPS: readonly Step[] = [gather, () => [text(`${J5_DIGEST}\n\n${J5_NOT_POSTED}`)]];

export const J5_WEEKLY_DIGEST: Scenario = {
  id: "j5-weekly-digest",
  job: "J5",
  title: "Summarise the weekly revenue digest",
  prompt: J5_PROMPT,
  steps: J5_STEPS,
  approvals: {},
  expected: { status: "completed", replyIncludes: [J5_NOT_POSTED] },
  verify: (fakes) => verifyDigestReadOnly(fakes),
};

/** The digest only reads: nothing is written anywhere. */
export function verifyDigestReadOnly(fakes: Fakes): string[] {
  const checks = new Checks();
  checks.equal(fakes.stripe.writes().length + fakes.hubspot.writes().length, 0, "no writes");
  checks.equal(fakes.composio.toolCalls.length, 0, "no Composio call");
  return checks.problems;
}
