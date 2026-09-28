// Classifies Stripe tool calls (docs/ARCHITECTURE.md §2, §7). Reads are read;
// refunds and cancellations are financial and carry the facts the approval
// card shows. Inputs are parsed with the tools' own shapes.
//
// A refund names only a charge id. With what the run's earlier Stripe calls
// returned (StripeRunMemory in run-memory.ts, `known` here), the card also
// names the customer, the charge's amount, date and description, and what
// was already refunded. Those facts come only from Stripe's own results.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { formatMoney, money } from "../shared/money.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { preview } from "../shared/text.js";
import { cardTime } from "../shared/time.js";
import { STRIPE_PROFILE } from "./profile.js";
import { cancelSubscriptionInput, createRefundInput, refundTarget } from "./schemas.js";

/** A customer as an earlier Stripe result in this run described it. */
export type KnownStripeCustomer = {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
};

/** A charge as an earlier Stripe result in this run described it. */
export type KnownCharge = {
  readonly id: string;
  readonly customerId: string | null;
  readonly paymentIntent: string | null;
  readonly amountMinor: number | null;
  readonly refundedMinor: number | null;
  readonly currency: string | null;
  readonly created: string | null;
  readonly description: string | null;
  readonly billingName: string | null;
};

/** Lookups into what the run's earlier Stripe calls returned. */
export interface StripeKnown {
  customer(id: string): KnownStripeCustomer | undefined;
  /** A charge by its id, or by its payment intent's id. */
  charge(id: string): KnownCharge | undefined;
  /** The customer of a subscription the run listed. */
  subscriptionCustomer(id: string): string | undefined;
}

const NOTHING_KNOWN: StripeKnown = {
  customer: () => undefined,
  charge: () => undefined,
  subscriptionCustomer: () => undefined,
};

/** The customer's name (or email), when the run saw it. */
function customerName(id: string | null, known: StripeKnown): string | null {
  if (id === null) return null;
  const customer = known.customer(id);
  const name = customer?.name ?? customer?.email ?? null;
  return name === null ? null : preview(name, 80);
}

const REASONS = {
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent",
  requested_by_customer: "Requested by customer",
} as const;

function classifyRefund(
  input: JsonObject,
  settings: ClassifierSettings,
  known: StripeKnown,
): Classification | null {
  const parsed = createRefundInput.safeParse(input);
  if (!parsed.success) return null;
  const target = refundTarget(parsed.data);
  if (target === null) return null;
  const charge = known.charge(target.id);
  const currency = charge?.currency?.toUpperCase() ?? settings.currency;
  const amount = money(parsed.data.amount, currency);
  const formatted = formatMoney(amount);
  const noun = target.kind === "charge" ? "charge" : "payment intent";
  const customer =
    customerName(charge?.customerId ?? null, known) ??
    (charge?.billingName === null || charge?.billingName === undefined
      ? null
      : preview(charge.billingName, 80));
  const facts: ApprovalFact[] = [{ label: "Amount", value: formatted }];
  if (customer !== null) {
    facts.push({
      label: "Customer",
      value:
        charge?.customerId === null || charge?.customerId === undefined
          ? customer
          : `${customer} (${charge.customerId})`,
    });
  }
  facts.push({ label: target.kind === "charge" ? "Charge" : "Payment intent", value: target.id });
  if (charge !== undefined) {
    const parts: string[] = [];
    if (charge.amountMinor !== null) parts.push(formatMoney(money(charge.amountMinor, currency)));
    if (charge.created !== null) parts.push(`on ${cardTime(charge.created)}`);
    if (charge.description !== null) parts.push(`"${preview(charge.description, 80)}"`);
    if (parts.length > 0) facts.push({ label: "Charged", value: parts.join(" ") });
    if (charge.refundedMinor !== null) {
      facts.push({
        label: "Already refunded",
        value: formatMoney(money(charge.refundedMinor, currency)),
      });
    }
  } else {
    facts.push({ label: "Charge details", value: "Not read in this run" });
  }
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
      consequence:
        customer === null
          ? `Refund ${formatted} on Stripe ${noun} ${target.id}`
          : `Refund ${formatted} to ${customer} on Stripe ${noun} ${target.id}`,
      facts,
      amount,
      recordIds: [target.id],
    },
  };
}

function classifyCancellation(input: JsonObject, known: StripeKnown): Classification | null {
  const parsed = cancelSubscriptionInput.safeParse(input);
  if (!parsed.success) return null;
  const { subscription, invoice_now: invoiceNow, prorate, comment } = parsed.data;
  const customerId = known.subscriptionCustomer(subscription) ?? null;
  const customer = customerName(customerId, known);
  const facts: ApprovalFact[] = [];
  if (customer !== null) facts.push({ label: "Customer", value: `${customer} (${customerId})` });
  facts.push(
    { label: "Subscription", value: subscription },
    { label: "When", value: "Immediately" },
    { label: "Final invoice", value: invoiceNow === true ? "Invoice pending usage now" : "None" },
    { label: "Proration", value: prorate === true ? "Credit unused time" : "None" },
  );
  if (comment !== undefined) facts.push({ label: "Comment", value: preview(comment, 120) });
  return {
    actionClass: "financial",
    operation: "stripe.subscriptions.cancel",
    title: "Cancel subscription in Stripe",
    details: {
      consequence:
        customer === null
          ? `Cancel Stripe subscription ${subscription} immediately`
          : `Cancel ${customer}'s Stripe subscription ${subscription} immediately`,
      facts,
      recordIds: [subscription],
    },
  };
}

/**
 * The classification of a Stripe call. `known` holds what the run's earlier
 * Stripe calls returned (StripeRunMemory); without it, cards name ids only.
 */
export function classifyStripe(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
  known: StripeKnown = NOTHING_KNOWN,
): Classification | null {
  const spec = specOf(STRIPE_PROFILE, tool);
  if (spec === undefined) return null;
  switch (spec.name) {
    case "create_refund":
      return classifyRefund(input, settings, known);
    case "cancel_subscription":
      return classifyCancellation(input, known);
    default:
      return fromSpec(spec);
  }
}
