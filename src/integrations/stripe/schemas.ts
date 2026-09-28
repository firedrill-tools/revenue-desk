// Input shapes of the Stripe tools. The tools (tools.ts) and the classifier
// (classify.ts) parse calls with the same shapes, so the approval card and the
// request describe the same thing.

import { z } from "zod";
import { identifier, isoTimestamp, metadataField, pageSize } from "../shared/schema.js";

/** Stripe ids by prefix; the rest is alphanumeric (underscores allowed, as in test fixtures). */
export const STRIPE_ID = {
  customer: /^cus_\w+$/,
  charge: /^(?:ch|py)_\w+$/,
  paymentIntent: /^pi_\w+$/,
  invoice: /^in_\w+$/,
  subscription: /^sub_\w+$/,
  any: /^[a-z]{2,5}_\w+$/,
} as const;

const customerId = (description: string) => identifier(STRIPE_ID.customer, description);
const startingAfter = identifier(
  STRIPE_ID.any,
  "Cursor for the next page: pass next_starting_after from the previous result.",
).optional();
const createdAfter = isoTimestamp(
  "Only objects created at or after this time (YYYY-MM-DD or ISO 8601 date-time).",
).optional();
const createdBefore = isoTimestamp(
  "Only objects created before this time (exclusive; YYYY-MM-DD or ISO 8601 date-time).",
).optional();

export const STRIPE_INPUTS = {
  find_customers: {
    email: z
      .email()
      .optional()
      .describe("Exact email address to match (Stripe matches it case-sensitively)."),
    limit: pageSize(100, 10, "customers"),
    starting_after: startingAfter,
  },
  get_customer: {
    customer: customerId("The customer id, e.g. cus_P3x9…"),
  },
  list_charges: {
    customer: customerId("Only charges of this customer.").optional(),
    payment_intent: identifier(
      STRIPE_ID.paymentIntent,
      "Only charges of this payment intent.",
    ).optional(),
    created_after: createdAfter,
    created_before: createdBefore,
    limit: pageSize(100, 10, "charges"),
    starting_after: startingAfter,
  },
  list_payment_intents: {
    customer: customerId("Only payment intents of this customer.").optional(),
    created_after: createdAfter,
    created_before: createdBefore,
    limit: pageSize(100, 10, "payment intents"),
    starting_after: startingAfter,
  },
  list_invoices: {
    customer: customerId("Only invoices of this customer.").optional(),
    status: z
      .enum(["draft", "open", "paid", "uncollectible", "void"])
      .optional()
      .describe("Only invoices in this status."),
    subscription: identifier(
      STRIPE_ID.subscription,
      "Only invoices of this subscription.",
    ).optional(),
    created_after: createdAfter,
    created_before: createdBefore,
    limit: pageSize(100, 10, "invoices"),
    starting_after: startingAfter,
  },
  get_invoice: {
    invoice: identifier(STRIPE_ID.invoice, "The invoice id, e.g. in_1Q…"),
  },
  list_subscriptions: {
    customer: customerId("Only subscriptions of this customer.").optional(),
    status: z
      .enum([
        "active",
        "past_due",
        "unpaid",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "trialing",
        "paused",
        "ended",
        "all",
      ])
      .optional()
      .describe("Only subscriptions in this status. Stripe omits canceled ones unless asked."),
    limit: pageSize(100, 10, "subscriptions"),
    starting_after: startingAfter,
  },
  list_refunds: {
    charge: identifier(STRIPE_ID.charge, "Only refunds of this charge.").optional(),
    payment_intent: identifier(
      STRIPE_ID.paymentIntent,
      "Only refunds of this payment intent.",
    ).optional(),
    created_after: createdAfter,
    created_before: createdBefore,
    limit: pageSize(100, 10, "refunds"),
    starting_after: startingAfter,
  },
  get_balance: {},
  create_refund: {
    charge: identifier(
      STRIPE_ID.charge,
      "The charge to refund (ch_… or py_…). Give exactly one of charge or payment_intent.",
    ).optional(),
    payment_intent: identifier(
      STRIPE_ID.paymentIntent,
      "The payment intent to refund (pi_…). Give exactly one of charge or payment_intent.",
    ).optional(),
    amount: z
      .number()
      .int()
      .min(1)
      .describe(
        "Amount to refund in the charge currency's minor units (4900 refunds $49.00). Always " +
          "state it, even for a full refund, and never more than the charge's unrefunded amount.",
      ),
    reason: z
      .enum(["duplicate", "fraudulent", "requested_by_customer"])
      .optional()
      .describe("Why the charge is refunded."),
    metadata: metadataField(
      'Optional key/value notes stored on the refund, e.g. {"ticket": "thread 18c2…"}.',
    ).optional(),
  },
  cancel_subscription: {
    subscription: identifier(STRIPE_ID.subscription, "The subscription to cancel immediately."),
    invoice_now: z
      .boolean()
      .optional()
      .describe("Invoice any pending usage and proration now (default false)."),
    prorate: z
      .boolean()
      .optional()
      .describe("Credit the unused time of the current period (default false)."),
    comment: z
      .string()
      .max(500)
      .optional()
      .describe("Why the subscription is cancelled; stored on the subscription."),
  },
} as const;

export type StripeToolName = keyof typeof STRIPE_INPUTS;

export const createRefundInput = z.object(STRIPE_INPUTS.create_refund);
export type CreateRefundInput = z.infer<typeof createRefundInput>;
export const cancelSubscriptionInput = z.object(STRIPE_INPUTS.cancel_subscription);

/** The charge or payment intent a refund targets; null unless exactly one is given. */
export function refundTarget(
  input: Pick<CreateRefundInput, "charge" | "payment_intent">,
): { readonly kind: "charge" | "payment_intent"; readonly id: string } | null {
  if (input.charge !== undefined && input.payment_intent === undefined) {
    return { kind: "charge", id: input.charge };
  }
  if (input.payment_intent !== undefined && input.charge === undefined) {
    return { kind: "payment_intent", id: input.payment_intent };
  }
  return null;
}
