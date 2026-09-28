// Compact views of Stripe objects for the model. Stripe objects carry many
// fields an agent never needs; these keep what the revenue jobs use, keep
// Stripe's field names and minor-unit amounts, and turn Unix timestamps into
// ISO 8601 strings. Absent fields stay absent: nothing is invented.

import type { JsonObject, JsonValue } from "../../contracts/json.js";
import {
  arr,
  bool,
  compact,
  field,
  isObject,
  num,
  obj,
  objects,
  pick,
  str,
} from "../shared/json.js";

/** A Unix timestamp (seconds) as an ISO string; undefined when absent. */
export function isoFromUnix(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function time(object: JsonObject, key: string): string | undefined {
  return isoFromUnix(num(object, key));
}

/** An expandable reference: the id string, or the id of an expanded object. */
function ref(object: JsonObject, key: string): string | undefined {
  const value = field(object, key);
  if (typeof value === "string") return value;
  return isObject(value) ? str(value, "id") : undefined;
}

function metadata(object: JsonObject): JsonValue | undefined {
  const value = obj(object, "metadata");
  return value !== undefined && Object.keys(value).length > 0 ? value : undefined;
}

export function customer(object: JsonObject): JsonObject {
  return compact({
    ...pick(object, [
      "id",
      "name",
      "email",
      "phone",
      "description",
      "currency",
      "balance",
      "delinquent",
    ]),
    created: time(object, "created"),
    metadata: metadata(object),
  });
}

export function charge(object: JsonObject): JsonObject {
  const billing = obj(object, "billing_details");
  const card = obj(obj(object, "payment_method_details"), "card");
  const outcome = obj(object, "outcome");
  return compact({
    ...pick(object, [
      "id",
      "amount",
      "amount_captured",
      "amount_refunded",
      "currency",
      "status",
      "paid",
      "captured",
      "refunded",
      "disputed",
      "description",
      "receipt_email",
      "failure_code",
      "failure_message",
    ]),
    customer: ref(object, "customer"),
    payment_intent: ref(object, "payment_intent"),
    invoice: ref(object, "invoice"),
    created: time(object, "created"),
    billing_name: str(billing, "name"),
    billing_email: str(billing, "email"),
    card: card === undefined ? undefined : pick(card, ["brand", "last4", "exp_month", "exp_year"]),
    outcome: outcome === undefined ? undefined : pick(outcome, ["type", "seller_message"]),
    metadata: metadata(object),
  });
}

export function paymentIntent(object: JsonObject): JsonObject {
  const lastError = obj(object, "last_payment_error");
  return compact({
    ...pick(object, [
      "id",
      "amount",
      "amount_received",
      "currency",
      "status",
      "description",
      "cancellation_reason",
    ]),
    customer: ref(object, "customer"),
    latest_charge: ref(object, "latest_charge"),
    invoice: ref(object, "invoice"),
    created: time(object, "created"),
    last_payment_error:
      lastError === undefined ? undefined : pick(lastError, ["code", "decline_code", "message"]),
    metadata: metadata(object),
  });
}

function invoiceLine(object: JsonObject): JsonObject {
  const period = obj(object, "period");
  return compact({
    ...pick(object, ["id", "description", "amount", "currency", "quantity"]),
    period_start: period === undefined ? undefined : time(period, "start"),
    period_end: period === undefined ? undefined : time(period, "end"),
  });
}

export function invoice(object: JsonObject, withLines: boolean): JsonObject {
  const transitions = obj(object, "status_transitions");
  const lines = objects(obj(object, "lines"), "data");
  return compact({
    ...pick(object, [
      "id",
      "number",
      "status",
      "currency",
      "total",
      "subtotal",
      "amount_due",
      "amount_paid",
      "amount_remaining",
      "customer_email",
      "customer_name",
      "collection_method",
      "attempt_count",
      "hosted_invoice_url",
    ]),
    customer: ref(object, "customer"),
    subscription: ref(object, "subscription"),
    created: time(object, "created"),
    due_date: time(object, "due_date"),
    paid_at: transitions === undefined ? undefined : time(transitions, "paid_at"),
    lines: withLines ? lines.map(invoiceLine) : undefined,
    metadata: metadata(object),
  });
}

function subscriptionItem(object: JsonObject): JsonObject {
  const price = obj(object, "price");
  const recurring = obj(price, "recurring");
  return compact({
    ...pick(object, ["id", "quantity"]),
    price: str(price, "id"),
    product: price === undefined ? undefined : ref(price, "product"),
    unit_amount: num(price, "unit_amount"),
    currency: str(price, "currency"),
    interval: str(recurring, "interval"),
    current_period_end: time(object, "current_period_end"),
  });
}

export function subscription(object: JsonObject): JsonObject {
  return compact({
    ...pick(object, ["id", "status", "currency", "collection_method", "cancel_at_period_end"]),
    customer: ref(object, "customer"),
    latest_invoice: ref(object, "latest_invoice"),
    created: time(object, "created"),
    current_period_end: time(object, "current_period_end"),
    cancel_at: time(object, "cancel_at"),
    canceled_at: time(object, "canceled_at"),
    ended_at: time(object, "ended_at"),
    trial_end: time(object, "trial_end"),
    items: objects(obj(object, "items"), "data").map(subscriptionItem),
    metadata: metadata(object),
  });
}

export function refund(object: JsonObject): JsonObject {
  return compact({
    ...pick(object, ["id", "amount", "currency", "status", "reason", "failure_reason"]),
    charge: ref(object, "charge"),
    payment_intent: ref(object, "payment_intent"),
    created: time(object, "created"),
    metadata: metadata(object),
  });
}

function funds(values: readonly JsonValue[] | undefined): JsonValue[] {
  return (values ?? []).filter(isObject).map((entry) => pick(entry, ["amount", "currency"]));
}

export function balance(object: JsonObject): JsonObject {
  return compact({
    available: funds(arr(object, "available")),
    pending: funds(arr(object, "pending")),
    livemode: bool(object, "livemode"),
  });
}

/**
 * A Stripe list as {data, has_more, next_starting_after}: pass
 * next_starting_after back as starting_after for the next page.
 */
export function list(body: JsonObject, project: (item: JsonObject) => JsonObject): JsonObject {
  const data = objects(body, "data").map(project);
  const hasMore = bool(body, "has_more") ?? false;
  const last = data.at(-1);
  return {
    data,
    has_more: hasMore,
    next_starting_after: hasMore && last !== undefined ? (str(last, "id") ?? null) : null,
  };
}
