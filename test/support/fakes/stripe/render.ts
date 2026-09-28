/** Stripe objects as the API returns them (version 2024-06-20). */
import type { JsonObject } from "../../../../src/contracts/json.js";
import type { Charge, Customer, Invoice, Refund, StripeState, Subscription } from "./state.js";

export function customerJson(customer: Customer): JsonObject {
  return {
    id: customer.id,
    object: "customer",
    address: null,
    balance: 0,
    created: customer.created,
    currency: "usd",
    default_source: null,
    delinquent: customer.delinquent,
    description: customer.description,
    discount: null,
    email: customer.email,
    invoice_prefix: customer.id.slice(4, 12).toUpperCase(),
    invoice_settings: { custom_fields: null, default_payment_method: null, footer: null },
    livemode: false,
    metadata: customer.metadata,
    name: customer.name,
    phone: null,
    preferred_locales: [],
    shipping: null,
    tax_exempt: "none",
    test_clock: null,
  };
}

export function chargeJson(state: StripeState, charge: Charge): JsonObject {
  const succeeded = charge.status === "succeeded";
  const customer = state.customers.get(charge.customer);
  return {
    id: charge.id,
    object: "charge",
    amount: charge.amount,
    amount_captured: succeeded ? charge.amount : 0,
    amount_refunded: charge.amountRefunded,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: succeeded ? `txn_${charge.id.slice(3)}` : null,
    billing_details: {
      address: null,
      email: customer?.email ?? null,
      name: customer?.name ?? null,
      phone: null,
    },
    calculated_statement_descriptor: "KESTREL ANALYTICS",
    captured: succeeded,
    created: charge.created,
    currency: charge.currency,
    customer: charge.customer,
    description: charge.description,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: charge.failureCode,
    failure_message: charge.failureMessage,
    fraud_details: {},
    invoice: charge.invoice,
    livemode: false,
    metadata: charge.metadata,
    on_behalf_of: null,
    outcome: succeeded
      ? {
          network_status: "approved_by_network",
          reason: null,
          risk_level: "normal",
          seller_message: "Payment complete.",
          type: "authorized",
        }
      : {
          network_status: "declined_by_network",
          reason: charge.declineCode ?? "generic_decline",
          risk_level: "normal",
          seller_message: "The bank did not return any further details with this decline.",
          type: "issuer_declined",
        },
    paid: succeeded,
    payment_intent: charge.paymentIntent,
    payment_method: `pm_${charge.id.slice(3)}`,
    payment_method_details: {
      card: { ...charge.card, country: "US", funding: "credit", network: charge.card.brand },
      type: "card",
    },
    receipt_email: customer?.email ?? null,
    receipt_number: null,
    refunded: charge.amountRefunded >= charge.amount,
    review: null,
    shipping: null,
    source: null,
    statement_descriptor: null,
    status: charge.status,
  };
}

export function paymentIntentJson(charge: Charge): JsonObject {
  const succeeded = charge.status === "succeeded";
  return {
    id: charge.paymentIntent,
    object: "payment_intent",
    amount: charge.amount,
    amount_capturable: 0,
    amount_received: succeeded ? charge.amount : 0,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: "automatic",
    client_secret: `${charge.paymentIntent}_secret_RDfake`,
    confirmation_method: "automatic",
    created: charge.created,
    currency: charge.currency,
    customer: charge.customer,
    description: charge.description,
    invoice: charge.invoice,
    last_payment_error: succeeded
      ? null
      : {
          charge: charge.id,
          code: charge.failureCode ?? "card_declined",
          decline_code: charge.declineCode ?? "generic_decline",
          message: charge.failureMessage ?? "Your card was declined.",
          type: "card_error",
        },
    latest_charge: charge.id,
    livemode: false,
    metadata: charge.metadata,
    payment_method: succeeded ? `pm_${charge.id.slice(3)}` : null,
    payment_method_types: ["card"],
    status: succeeded ? "succeeded" : "requires_payment_method",
  };
}

export function invoiceJson(state: StripeState, invoice: Invoice): JsonObject {
  const customer = state.customers.get(invoice.customer);
  const subtotal = invoice.lines.reduce((sum, line) => sum + line.amount, 0);
  const paid = invoice.status === "paid";
  return {
    id: invoice.id,
    object: "invoice",
    account_country: "US",
    account_name: "Kestrel Analytics, Inc.",
    amount_due: invoice.amount_due,
    amount_paid: invoice.amount_paid,
    amount_remaining: invoice.amount_due - invoice.amount_paid,
    attempt_count: invoice.attempt_count ?? (paid ? 1 : 0),
    attempted: (invoice.attempt_count ?? (paid ? 1 : 0)) > 0,
    auto_advance: !paid,
    billing_reason: "subscription_cycle",
    charge: invoice.charge,
    collection_method: "charge_automatically",
    created: invoice.created,
    currency: invoice.currency,
    customer: invoice.customer,
    customer_email: customer?.email ?? null,
    customer_name: customer?.name ?? null,
    description: null,
    due_date: null,
    ending_balance: 0,
    hosted_invoice_url: null,
    invoice_pdf: null,
    lines: {
      object: "list",
      data: invoice.lines.map((line, index) => ({
        id: `il_${invoice.id.slice(3)}_${index + 1}`,
        object: "line_item",
        amount: line.amount,
        currency: invoice.currency,
        description: line.description,
        period: { start: invoice.period_start, end: invoice.period_end },
        price: line.price,
        quantity: line.quantity,
        type: "subscription",
      })),
      has_more: false,
      total_count: invoice.lines.length,
      url: `/v1/invoices/${invoice.id}/lines`,
    },
    livemode: false,
    metadata: {},
    next_payment_attempt: invoice.next_payment_attempt ?? null,
    number: invoice.number,
    paid,
    payment_intent: invoice.payment_intent,
    period_end: invoice.period_end,
    period_start: invoice.period_start,
    status: invoice.status,
    status_transitions: {
      finalized_at: invoice.created,
      marked_uncollectible_at: null,
      paid_at: paid ? (state.charges.get(invoice.charge ?? "")?.created ?? invoice.created) : null,
      voided_at: null,
    },
    subscription: invoice.subscription,
    subtotal,
    total: subtotal,
  };
}

export function subscriptionJson(subscription: Subscription): JsonObject {
  const price = {
    id: subscription.price.id,
    object: "price",
    active: true,
    currency: subscription.price.currency,
    nickname: subscription.price.nickname,
    product: subscription.price.product,
    recurring: { interval: subscription.price.interval, interval_count: 1 },
    type: "recurring",
    unit_amount: subscription.price.unit_amount,
  };
  return {
    id: subscription.id,
    object: "subscription",
    billing_cycle_anchor: subscription.created,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: subscription.canceledAt,
    cancellation_details: subscription.cancellation,
    collection_method: "charge_automatically",
    created: subscription.created,
    currency: subscription.price.currency,
    current_period_end: subscription.currentPeriodEnd,
    current_period_start: subscription.currentPeriodStart,
    customer: subscription.customer,
    days_until_due: null,
    default_payment_method: null,
    ended_at: subscription.endedAt,
    items: {
      object: "list",
      data: [
        {
          id: `si_${subscription.id.slice(4)}`,
          object: "subscription_item",
          price,
          quantity: subscription.quantity,
          subscription: subscription.id,
        },
      ],
      has_more: false,
      total_count: 1,
      url: `/v1/subscription_items?subscription=${subscription.id}`,
    },
    latest_invoice: subscription.latestInvoice,
    livemode: false,
    metadata: {},
    quantity: subscription.quantity,
    start_date: subscription.created,
    status: subscription.status,
    trial_end: null,
    trial_start: null,
  };
}

export function refundJson(refund: Refund): JsonObject {
  return {
    id: refund.id,
    object: "refund",
    amount: refund.amount,
    balance_transaction: `txn_${refund.id.slice(3)}`,
    charge: refund.charge,
    created: refund.created,
    currency: refund.currency,
    metadata: refund.metadata,
    payment_intent: refund.paymentIntent,
    reason: refund.reason,
    receipt_number: null,
    source_transfer_reversal: null,
    status: refund.status,
    transfer_reversal: null,
  };
}

export function balanceJson(state: StripeState): JsonObject {
  const entries = (map: ReadonlyMap<string, number>) =>
    [...map.entries()].map(([currency, amount]) => ({
      amount,
      currency,
      source_types: { card: amount },
    }));
  return {
    object: "balance",
    available: entries(state.balance.available),
    connect_reserved: [...state.balance.available.keys()].map((currency) => ({
      amount: 0,
      currency,
    })),
    livemode: false,
    pending: entries(state.balance.pending),
  };
}
