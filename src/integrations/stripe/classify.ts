// Classifies Stripe tool calls (docs/ARCHITECTURE.md §2, §7). Reads are read;
// refunds and cancellations are financial and carry the facts the approval
// card shows. Inputs are parsed with the tools' own shapes.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { formatMoney, money } from "../shared/money.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { preview } from "../shared/text.js";
import { STRIPE_PROFILE } from "./profile.js";
import { cancelSubscriptionInput, createRefundInput, refundTarget } from "./schemas.js";

const REASONS = {
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent",
  requested_by_customer: "Requested by customer",
} as const;

function classifyRefund(input: JsonObject, settings: ClassifierSettings): Classification | null {
  const parsed = createRefundInput.safeParse(input);
  if (!parsed.success) return null;
  const target = refundTarget(parsed.data);
  if (target === null) return null;
  const amount = money(parsed.data.amount, settings.currency);
  const formatted = formatMoney(amount);
  const noun = target.kind === "charge" ? "charge" : "payment intent";
  const facts: ApprovalFact[] = [
    { label: "Amount", value: formatted },
    { label: target.kind === "charge" ? "Charge" : "Payment intent", value: target.id },
  ];
  if (parsed.data.reason !== undefined) {
    facts.push({ label: "Reason", value: REASONS[parsed.data.reason] });
  }
  for (const [key, value] of Object.entries(parsed.data.metadata ?? {})) {
    facts.push({ label: `Note: ${key}`, value: preview(value, 80) });
  }
  return {
    actionClass: "financial",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    details: {
      consequence: `Refund ${formatted} on Stripe ${noun} ${target.id}`,
      facts,
      amount,
      recordIds: [target.id],
    },
  };
}

function classifyCancellation(input: JsonObject): Classification | null {
  const parsed = cancelSubscriptionInput.safeParse(input);
  if (!parsed.success) return null;
  const { subscription, invoice_now: invoiceNow, prorate, comment } = parsed.data;
  const facts: ApprovalFact[] = [
    { label: "Subscription", value: subscription },
    { label: "When", value: "Immediately" },
    { label: "Final invoice", value: invoiceNow === true ? "Invoice pending usage now" : "None" },
    { label: "Proration", value: prorate === true ? "Credit unused time" : "None" },
  ];
  if (comment !== undefined) facts.push({ label: "Comment", value: preview(comment, 120) });
  return {
    actionClass: "financial",
    operation: "stripe.subscriptions.cancel",
    title: "Cancel subscription in Stripe",
    details: {
      consequence: `Cancel Stripe subscription ${subscription} immediately`,
      facts,
      recordIds: [subscription],
    },
  };
}

export function classifyStripe(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
): Classification | null {
  const spec = specOf(STRIPE_PROFILE, tool);
  if (spec === undefined) return null;
  switch (spec.name) {
    case "create_refund":
      return classifyRefund(input, settings);
    case "cancel_subscription":
      return classifyCancellation(input);
    default:
      return fromSpec(spec);
  }
}
