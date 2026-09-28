// The empty state's suggestions: the five jobs Revenue Desk is built for
// (docs/ARCHITECTURE.md §1). Prompts name no customer or record, so they work
// against whatever the connected systems hold.

import type { ConnectionView, PolicyView } from "../../../src/contracts/api.js";
import {
  type ActionClass,
  DEFAULT_POLICY,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationId,
} from "../../../src/contracts/integration.js";

export type JobSuggestion = {
  readonly id: "billing_inquiry" | "refund" | "collections" | "handoff" | "digest";
  readonly title: string;
  readonly prompt: string;
  readonly systems: readonly IntegrationId[];
};

/**
 * The five jobs, with their Slack posts sent to the workspace's notices
 * channel (Settings › Slack) instead of a channel the workspace may not have.
 */
export function jobSuggestions(notifyChannel: string | null): readonly JobSuggestion[] {
  const channel = notifyChannel?.trim() || null;
  return JOB_SUGGESTIONS.map((job) => ({
    ...job,
    prompt: job.prompt.replace(NOTICES_CHANNEL, channel === null ? "the team in Slack" : channel),
  }));
}

/** Stands in the prompts below for the notices channel. */
const NOTICES_CHANNEL = "{notices}";

const JOB_SUGGESTIONS: readonly JobSuggestion[] = [
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
      "A customer says they were charged twice. Find the duplicate charge in Stripe and propose a refund. After it is approved, log a HubSpot note and tell {notices}.",
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
      "Take the most recent closed-won HubSpot deal, find or create its QuickBooks customer, create and send the invoice, and tell {notices} about the handoff.",
    systems: ["hubspot", "quickbooks", "slack"],
  },
  {
    id: "digest",
    title: "Post the weekly digest",
    prompt:
      "Summarise this week's new HubSpot deals, Stripe payments and refunds, and QuickBooks AR aging, then post the digest to {notices}.",
    systems: ["hubspot", "stripe", "quickbooks", "slack"],
  },
];

/** A job's systems, each marked when it is not connected. */
export function jobSystems(
  job: Pick<JobSuggestion, "systems">,
  connections: readonly Pick<ConnectionView, "integration" | "state">[] | null,
): { readonly label: string; readonly connected: boolean }[] {
  return job.systems.map((id) => ({
    label: INTEGRATIONS[id].label,
    // Until the connections load, nothing is marked.
    connected:
      connections === null ||
      connections.find((connection) => connection.integration === id)?.state === "connected",
  }));
}

/** How many of the six systems are connected. */
export function connectedCount(connections: readonly Pick<ConnectionView, "state">[]): {
  readonly connected: number;
  readonly total: number;
} {
  return {
    connected: connections.filter((connection) => connection.state === "connected").length,
    total: INTEGRATION_IDS.length,
  };
}

const ASKING: readonly (readonly [ActionClass, string])[] = [
  ["financial", "refunds, invoices and payments"],
  ["outbound", "outbound email and invitations"],
  ["internal_write", "drafts, notes and internal posts"],
  ["destructive", "anything destructive"],
];

/** Which actions wait for approval under the saved policy (the defaults until it loads). */
export function approvalSentence(
  policies: readonly Pick<PolicyView, "actionClass" | "mode">[] | null,
): string {
  const mode = (actionClass: ActionClass) =>
    policies?.find((policy) => policy.actionClass === actionClass)?.mode ??
    DEFAULT_POLICY[actionClass];
  const asks = ASKING.filter(([actionClass]) => mode(actionClass) === "ask").map(
    ([, phrase]) => phrase,
  );
  if (asks.length === 0) return "Nothing waits for your approval under the current policy.";
  const list = asks.length === 1 ? asks[0] : `${asks.slice(0, -1).join(", ")} and ${asks.at(-1)}`;
  const text = `${list} wait for your approval.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
