/** The Stripe fake's records, loaded from test/fixtures/business/stripe.json. */
import type { StripeFixture } from "../fixtures.js";

export interface Customer {
  readonly id: string;
  readonly created: number;
  email: string | null;
  name: string;
  description: string | null;
  delinquent: boolean;
  metadata: Record<string, string>;
}

export interface Card {
  readonly brand: string;
  readonly last4: string;
  readonly exp_month: number;
  readonly exp_year: number;
}

export interface Charge {
  readonly id: string;
  readonly created: number;
  readonly customer: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: "succeeded" | "failed" | "pending";
  readonly description: string | null;
  readonly invoice: string | null;
  readonly paymentIntent: string;
  readonly card: Card;
  readonly metadata: Record<string, string>;
  amountRefunded: number;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly declineCode: string | null;
}

export interface Refund {
  readonly id: string;
  readonly created: number;
  readonly charge: string;
  readonly paymentIntent: string;
  readonly amount: number;
  readonly currency: string;
  readonly reason: "duplicate" | "fraudulent" | "requested_by_customer" | null;
  readonly status: "pending" | "succeeded" | "failed" | "canceled";
  readonly metadata: Record<string, string>;
}

export type Invoice = StripeFixture["invoices"][number];

export interface Subscription {
  readonly id: string;
  readonly created: number;
  readonly customer: string;
  status: StripeFixture["subscriptions"][number]["status"];
  readonly price: StripeFixture["subscriptions"][number]["price"];
  readonly quantity: number;
  readonly currentPeriodStart: number;
  readonly currentPeriodEnd: number;
  readonly latestInvoice: string | null;
  canceledAt: number | null;
  endedAt: number | null;
  cancellation: { comment: string | null; feedback: string | null; reason: string | null };
}

export interface Balance {
  available: Map<string, number>;
  pending: Map<string, number>;
}

/** Every record the fake holds, keyed by id. */
export class StripeState {
  readonly customers = new Map<string, Customer>();
  readonly charges = new Map<string, Charge>();
  readonly invoices = new Map<string, Invoice>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly refunds = new Map<string, Refund>();
  readonly balance: Balance;

  constructor(fixture: StripeFixture) {
    for (const customer of fixture.customers) {
      this.customers.set(customer.id, {
        id: customer.id,
        created: customer.created,
        email: customer.email,
        name: customer.name,
        description: customer.description ?? null,
        delinquent: customer.delinquent ?? false,
        metadata: { ...customer.metadata },
      });
    }
    for (const charge of fixture.charges) {
      this.charges.set(charge.id, {
        id: charge.id,
        created: charge.created,
        customer: charge.customer,
        amount: charge.amount,
        currency: charge.currency,
        status: charge.status,
        description: charge.description,
        invoice: charge.invoice,
        paymentIntent: charge.payment_intent,
        card: charge.card,
        metadata: { ...charge.metadata },
        amountRefunded: charge.amount_refunded ?? 0,
        failureCode: charge.failure_code ?? null,
        failureMessage: charge.failure_message ?? null,
        declineCode: charge.decline_code ?? null,
      });
    }
    for (const invoice of fixture.invoices) this.invoices.set(invoice.id, structuredClone(invoice));
    for (const subscription of fixture.subscriptions) {
      this.subscriptions.set(subscription.id, {
        id: subscription.id,
        created: subscription.created,
        customer: subscription.customer,
        status: subscription.status,
        price: subscription.price,
        quantity: subscription.quantity,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        latestInvoice: subscription.latest_invoice,
        canceledAt: subscription.canceled_at ?? null,
        endedAt: subscription.ended_at ?? null,
        cancellation: {
          comment: null,
          feedback: null,
          reason: subscription.status === "canceled" ? "cancellation_requested" : null,
        },
      });
    }
    for (const refund of fixture.refunds) {
      const charge = this.charges.get(refund.charge);
      if (charge === undefined) throw new Error(`Refund ${refund.id} names unknown charge`);
      this.refunds.set(refund.id, {
        id: refund.id,
        created: refund.created,
        charge: refund.charge,
        paymentIntent: charge.paymentIntent,
        amount: refund.amount,
        currency: charge.currency,
        reason: refund.reason,
        status: refund.status,
        metadata: { ...refund.metadata },
      });
    }
    this.balance = {
      available: new Map(fixture.balance.available.map((entry) => [entry.currency, entry.amount])),
      pending: new Map(fixture.balance.pending.map((entry) => [entry.currency, entry.amount])),
    };
  }

  /** A charge's payment intent id to the charge (payment intents are derived from charges). */
  chargeOfIntent(intentId: string): Charge | undefined {
    return [...this.charges.values()].find((charge) => charge.paymentIntent === intentId);
  }
}
