// The empty state's suggestions: the five jobs Revenue Desk is built for
// (docs/ARCHITECTURE.md §1). Prompts name no customer or record, so they work
// against whatever the connected systems hold.

import type { IntegrationId } from "../../../src/contracts/integration.js";

export type JobSuggestion = {
  readonly id: "billing_inquiry" | "refund" | "collections" | "handoff" | "digest";
  readonly title: string;
  readonly prompt: string;
  readonly systems: readonly IntegrationId[];
};

export const JOB_SUGGESTIONS: readonly JobSuggestion[] = [
  {
    id: "billing_inquiry",
    title: "Answer a billing inquiry",
    prompt:
      "Find the most recent customer email with a billing question, look the customer up in Stripe, QuickBooks and HubSpot, and draft a reply in Gmail.",
    systems: ["gmail", "stripe", "quickbooks", "hubspot"],
  },
  {
    id: "refund",
    title: "Refund a duplicate charge",
    prompt:
      "A customer says they were charged twice. Find the duplicate charge in Stripe and propose a refund. After it is approved, log a HubSpot note and post to #billing.",
    systems: ["stripe", "hubspot", "slack"],
  },
  {
    id: "collections",
    title: "Chase overdue invoices",
    prompt:
      "List overdue QuickBooks invoices, check Stripe for payments that were not recorded, and draft reminder emails. For invoices 60 or more days overdue, propose a call and create a HubSpot task.",
    systems: ["quickbooks", "stripe", "gmail", "google_calendar", "hubspot"],
  },
  {
    id: "handoff",
    title: "Hand off a closed-won deal",
    prompt:
      "Take the most recent closed-won HubSpot deal, find or create its QuickBooks customer, create and send the invoice, and post the handoff to #sales-ops.",
    systems: ["hubspot", "quickbooks", "slack"],
  },
  {
    id: "digest",
    title: "Post the weekly digest",
    prompt:
      "Summarise this week's new HubSpot deals, Stripe payments and refunds, and QuickBooks AR aging, then post the digest to Slack.",
    systems: ["hubspot", "stripe", "quickbooks", "slack"],
  },
];
