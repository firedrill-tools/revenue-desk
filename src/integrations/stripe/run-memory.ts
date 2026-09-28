// What a run remembers about the Stripe records it read (the gateway's
// RunMemory, src/gateway/catalog.ts). A refund names only a charge, so its
// approval card takes the customer, the charge's amount, date and
// description, and what was already refunded from this run's earlier Stripe
// results (classify.ts). Only Stripe's own results are remembered, never the
// model's inputs, and a failed call teaches nothing.

import type { Classification, ClassifierSettings } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import { asObject, num, objects, str } from "../shared/json.js";
import {
  classifyStripe,
  type KnownCharge,
  type KnownStripeCustomer,
  type StripeKnown,
} from "./classify.js";

export class StripeRunMemory implements RunMemory, StripeKnown {
  readonly #settings: ClassifierSettings;
  readonly #customers = new Map<string, KnownStripeCustomer>();
  readonly #charges = new Map<string, KnownCharge>();
  readonly #subscriptions = new Map<string, string>();

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

  record(tool: string, _input: JsonObject, output: JsonValue, isError: boolean): void {
    const result = asObject(output);
    if (isError || result === undefined) return;
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

  #learnSubscription(subscription: JsonObject): void {
    const id = str(subscription, "id");
    const customer = str(subscription, "customer");
    if (id !== undefined && customer !== undefined) this.#subscriptions.set(id, customer);
  }
}
