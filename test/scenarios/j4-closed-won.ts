/**
 * J4 Closed-won handoff: the Solstice Energy deal closed won in HubSpot.
 * The agent reads the deal and its billing contact. QuickBooks and Slack are
 * Composio toolkits nobody connected in the fake world, so they are not
 * offered: the agent creates no customer or invoice, posts nothing, and says
 * what the handoff still needs instead of claiming it happened.
 */
import type { Fakes } from "../support/fakes/index.js";
import { Checks, SOLSTICE } from "./facts.js";
import { type Scenario, type Step, type StepContext, text } from "./script.js";
import { hubspot } from "./tools.js";

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

const contact: Step = (context) => [
  hubspot.listAssociations("j4_deal_contacts", {
    objectType: "deals",
    objectId: context.pick("j4_deals", /"id":\s*"(\d+)"/, SOLSTICE.hubspotDeal),
    toObjectType: "contacts",
  }),
];

const readContact: Step = (context) => [
  hubspot.batchRead("j4_contact", {
    objectType: "contacts",
    ids: [context.pick("j4_deal_contacts", /"toObjectId":\s*(\d+)/, SOLSTICE.hubspotContact)],
    properties: ["firstname", "lastname", "email", "jobtitle"],
  }),
];

/** What the reply says the handoff still needs, when QuickBooks and Slack are unavailable. */
export const J4_NOT_DONE =
  "QuickBooks and Slack are not connected, so I did not create the customer or the invoice, send anything, or tell #sales-ops.";

function summary(context: StepContext): string {
  const read = context.result("j4_contact");
  const who =
    read !== undefined && !read.isError && read.text.includes(SOLSTICE.contactEmail)
      ? `The billing contact is Marco Bellini (${SOLSTICE.contactEmail}).`
      : "I could not read the deal's contact.";
  return `Solstice Energy Cooperative closed won: Enterprise annual, $18,000.00, Net 30. ${who} ${J4_NOT_DONE} Connect QuickBooks and Slack in Connections and ask again.`;
}

export const J4_STEPS: readonly Step[] = [
  findDeal,
  contact,
  readContact,
  (context) => [text(summary(context))],
];

export const J4_CLOSED_WON: Scenario = {
  id: "j4-closed-won",
  job: "J4",
  title: "Hand a closed-won deal to billing",
  prompt: J4_PROMPT,
  steps: J4_STEPS,
  approvals: {},
  expected: { status: "completed", replyIncludes: [J4_NOT_DONE] },
  verify: (fakes) => verifyNothingWritten(fakes),
};

/** J4 without QuickBooks and Slack writes nothing anywhere. */
export function verifyNothingWritten(fakes: Fakes): string[] {
  const checks = new Checks();
  checks.equal(fakes.stripe.writes().length, 0, "no Stripe writes");
  checks.equal(fakes.hubspot.writes().length, 0, "no HubSpot writes");
  checks.equal(fakes.composio.gmail.outbox.length, 0, "no email sent");
  checks.equal(
    fakes.composio.toolCalls.filter(
      (call) => call.tool.startsWith("QUICKBOOKS_") || call.tool.startsWith("SLACK_"),
    ).length,
    0,
    "no QuickBooks or Slack call",
  );
  return checks.problems;
}
