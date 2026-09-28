// What a run remembers about the Stripe records it read (the gateway's
// RunMemory, src/gateway/catalog.ts). A refund names only a charge, so its
// approval card takes the customer, the charge's amount, date and
// description, and what was already refunded from this run's earlier Stripe
// results (classify.ts). The run's own refunds count: a second refund of the
// same charge must not show the balance from before the first. Only
// Stripe's own results are remembered, never the model's inputs, and a
// failed call teaches nothing, except a refund sent without an answer
// (outcome_unknown), which is remembered as possibly applied.

import type { Classification, ClassifierSettings } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import { OUTCOME_UNKNOWN } from "../../gateway/types.js";
import { asObject, bool, num, obj, objects, str } from "../shared/json.js";
import {
  classifyStripe,
  type KnownCharge,
  type KnownStripeCustomer,
  type RunRefund,
  type StripeKnown,
} from "./classify.js";

export class StripeRunMemory implements RunMemory, StripeKnown {
  readonly #settings: ClassifierSettings;
  readonly #customers = new Map<string, KnownStripeCustomer>();
  readonly #charges = new Map<string, KnownCharge>();
  readonly #subscriptions = new Map<string, string>();
  /** This run's refunds, by charge id and by payment intent id. */
  readonly #runRefunds = new Map<string, RunRefund[]>();

  constructor(settings: ClassifierSettings) {
    this.#settings = settings;
  }

  customer(id: string): KnownStripeCustomer | undefined {
    return this.#customers.get(id);
  }

  charge(id: string): KnownCharge | undefined {
    return this.#charges.get(id);
  }

  subscriptionCustomer(id: string): string | undefined {
    return this.#subscriptions.get(id);
  }

  refundsInRun(id: string): readonly RunRefund[] {
    return this.#runRefunds.get(id) ?? [];
  }

  record(tool: string, input: JsonObject, output: JsonValue, isError: boolean): void {
    const result = asObject(output);
    if (isError) {
      if (tool === "create_refund" && str(obj(result, "error"), "code") === OUTCOME_UNKNOWN) {
        this.#refundSentWithoutAnswer(input);
      }
      return;
    }
    if (result === undefined) return;
    switch (tool) {
      case "find_customers":
        for (const customer of objects(result, "data")) this.#learnCustomer(customer);
        break;
      case "get_customer":
        this.#learnCustomer(result);
        break;
      case "list_charges":
        for (const charge of objects(result, "data")) this.#learnCharge(charge);
        break;
      case "list_subscriptions":
        for (const subscription of objects(result, "data")) this.#learnSubscription(subscription);
        break;
      case "create_refund":
        this.#learnOwnRefund(result);
        break;
      case "list_refunds":
        this.#learnRefundList(input, result);
        break;
      default:
        break;
    }
  }

  refine(tool: string, input: JsonObject, classification: Classification): Classification {
    return classifyStripe(tool, input, this.#settings, this) ?? classification;
  }

  #learnCustomer(customer: JsonObject): void {
    const id = str(customer, "id");
    if (id === undefined) return;
    this.#customers.set(id, {
      id,
      name: str(customer, "name") ?? null,
      email: str(customer, "email") ?? null,
    });
  }

  #learnCharge(charge: JsonObject): void {
    const id = str(charge, "id");
    if (id === undefined) return;
    const known: KnownCharge = {
      id,
      customerId: str(charge, "customer") ?? null,
      paymentIntent: str(charge, "payment_intent") ?? null,
      amountMinor: num(charge, "amount") ?? null,
      refundedMinor: num(charge, "amount_refunded") ?? null,
      currency: str(charge, "currency") ?? null,
      created: str(charge, "created") ?? null,
      description: str(charge, "description") ?? null,
      billingName: str(charge, "billing_name") ?? null,
    };
    this.#charges.set(id, known);
    // A refund may name the payment intent instead of the charge.
    if (known.paymentIntent !== null) this.#charges.set(known.paymentIntent, known);
  }

  /** Keys a refund is filed under: its charge and its payment intent, and the charge's other key. */
  #keysOf(charge: string | undefined, paymentIntent: string | undefined): string[] {
    const keys = new Set<string>();
    for (const id of [charge, paymentIntent]) {
      if (id === undefined) continue;
      keys.add(id);
      const known = this.#charges.get(id);
      if (known !== undefined) {
        keys.add(known.id);
        if (known.paymentIntent !== null) keys.add(known.paymentIntent);
      }
    }
    return [...keys];
  }

  /** A refund this run made: the charge's refunded total grows by it, until Stripe says otherwise. */
  #learnOwnRefund(refund: JsonObject): void {
    const amount = num(refund, "amount");
    const status = str(refund, "status");
    if (amount === undefined || status === "failed" || status === "canceled") return;
    const keys = this.#keysOf(str(refund, "charge"), str(refund, "payment_intent"));
    const entry: RunRefund = {
      id: str(refund, "id") ?? null,
      amountMinor: amount,
      uncertain: false,
    };
    for (const key of keys)
      this.#runRefunds.set(key, [...(this.#runRefunds.get(key) ?? []), entry]);
    this.#addRefunded(keys, amount);
  }

  /** A refund sent without Stripe's answer: it may have been applied. */
  #refundSentWithoutAnswer(input: JsonObject): void {
    const amount = num(input, "amount");
    if (amount === undefined) return;
    const keys = this.#keysOf(str(input, "charge"), str(input, "payment_intent"));
    const entry: RunRefund = { id: null, amountMinor: amount, uncertain: true };
    for (const key of keys)
      this.#runRefunds.set(key, [...(this.#runRefunds.get(key) ?? []), entry]);
  }

  /**
   * A complete list of one charge's refunds (filtered by charge, no further
   * page) is what was refunded, whatever the run knew before.
   */
  #learnRefundList(input: JsonObject, result: JsonObject): void {
    const charge = str(input, "charge");
    const paymentIntent = str(input, "payment_intent");
    if ((charge === undefined && paymentIntent === undefined) || bool(result, "has_more") !== false)
      return;
    let total = 0;
    for (const refund of objects(result, "data")) {
      const status = str(refund, "status");
      if (status === "failed" || status === "canceled") continue;
      total += num(refund, "amount") ?? 0;
    }
    for (const key of this.#keysOf(charge, paymentIntent)) {
      const known = this.#charges.get(key);
      if (known !== undefined) this.#charges.set(key, { ...known, refundedMinor: total });
    }
  }

  #addRefunded(keys: readonly string[], amount: number): void {
    const updated = new Map<KnownCharge, KnownCharge>();
    for (const key of keys) {
      const known = this.#charges.get(key);
      if (known === undefined) continue;
      let next = updated.get(known);
      if (next === undefined) {
        next = { ...known, refundedMinor: (known.refundedMinor ?? 0) + amount };
        updated.set(known, next);
      }
      this.#charges.set(key, next);
    }
  }

  #learnSubscription(subscription: JsonObject): void {
    const id = str(subscription, "id");
    const customer = str(subscription, "customer");
    if (id !== undefined && customer !== undefined) this.#subscriptions.set(id, customer);
  }
}
