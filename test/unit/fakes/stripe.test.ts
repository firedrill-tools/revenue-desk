/**
 * Contract tests for the Stripe fake, independent of the agent: auth, form
 * encoding, the error envelope, idempotency replay, lists and paging,
 * refunds, cancellation and injected provider failures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import { createClock } from "../../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";
import { StripeFake } from "../../support/fakes/stripe/index.js";

const KEY = FAKE_CREDENTIALS.stripeSecretKey;
let stripe: StripeFake;

beforeEach(async () => {
  const fixtures = loadBusinessFixtures();
  stripe = await StripeFake.start({
    fixture: fixtures.stripe,
    clock: createClock(fixtures.company.asOf),
    secretKey: KEY,
    prefix: "/stripe",
  });
});

afterEach(async () => {
  await stripe.close();
});

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: JsonObject;
}

async function call(
  method: string,
  path: string,
  options: {
    readonly form?: Record<string, string>;
    readonly json?: unknown;
    readonly auth?: string | null;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  const auth = options.auth === undefined ? `Bearer ${KEY}` : options.auth;
  if (auth !== null) headers.authorization = auth;
  let body: string | undefined;
  if (options.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  } else if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${stripe.baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as JsonObject,
  };
}

const errorOf = (reply: Reply) => reply.body.error as JsonObject;

describe("Stripe fake: authentication and encoding", () => {
  it("requires Bearer auth with the configured test key", async () => {
    const none = await call("GET", "/v1/balance", { auth: null });
    expect(none.status).toBe(401);
    expect(errorOf(none)).toMatchObject({ type: "invalid_request_error" });
    expect(String(errorOf(none).message)).toContain("did not provide an API key");

    const basic = await call("GET", "/v1/balance", {
      auth: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
    });
    expect(basic.status).toBe(401);
    expect(String(errorOf(basic).message)).toContain("Bearer");

    const wrong = await call("GET", "/v1/balance", { auth: "Bearer sk_test_wrong0000000000" });
    expect(wrong.status).toBe(401);
    expect(String(errorOf(wrong).message)).toContain("Invalid API Key provided");
    expect(JSON.stringify(wrong.body)).not.toContain("sk_test_wrong0000000000");
  });

  it("sets Request-Id on every response and echoes Stripe-Version", async () => {
    const reply = await call("GET", "/v1/balance", { headers: { "stripe-version": "2024-06-20" } });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("request-id")).toMatch(/^req_/);
    expect(reply.headers.get("stripe-version")).toBe("2024-06-20");
    const bad = await call("GET", "/v1/balance", { headers: { "stripe-version": "latest" } });
    expect(bad.status).toBe(400);
  });

  it("refuses JSON bodies with 415 and changes nothing", async () => {
    const reply = await call("POST", "/v1/refunds", { json: { charge: "ch_KAhp_0922b" } });
    expect(reply.status).toBe(415);
    expect(errorOf(reply)).toMatchObject({ type: "invalid_request_error" });
    expect(stripe.refunds({ charge: "ch_KAhp_0922b" })).toEqual([]);
  });

  it("rejects unknown parameters with parameter_unknown", async () => {
    const reply = await call("GET", "/v1/charges?customr=cus_KAharborpine");
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toMatchObject({ code: "parameter_unknown", param: "customr" });
  });

  it("keeps the base URL prefix: requests without it are unknown URLs", async () => {
    const response = await fetch(`${new URL(stripe.baseUrl).origin}/v1/balance`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as JsonObject;
    expect(String((body.error as JsonObject).message)).toContain("Unrecognized request URL");
  });
});

describe("Stripe fake: reads", () => {
  it("finds customers by exact email", async () => {
    const reply = await call("GET", "/v1/customers?email=dana@harborpine.test");
    expect(reply.body).toMatchObject({ object: "list", has_more: false, url: "/v1/customers" });
    expect((reply.body.data as JsonObject[]).map((customer) => customer.id)).toEqual([
      "cus_KAharborpine",
    ]);
    const none = await call("GET", "/v1/customers?email=DANA@harborpine.test");
    expect(none.body.data).toEqual([]);
  });

  it("lists a customer's charges newest first, including the duplicate", async () => {
    const reply = await call("GET", "/v1/charges?customer=cus_KAharborpine");
    const charges = reply.body.data as JsonObject[];
    expect(charges.map((charge) => charge.id)).toEqual([
      "ch_KAhp_0922b",
      "ch_KAhp_0922a",
      "ch_KAhp_0822",
    ]);
    expect(charges[0]).toMatchObject({
      object: "charge",
      amount: 49000,
      currency: "usd",
      invoice: null,
      paid: true,
      refunded: false,
      livemode: false,
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
    });
  });

  it("pages with limit, starting_after and ending_before", async () => {
    const first = await call("GET", "/v1/charges?limit=3");
    const firstIds = (first.body.data as JsonObject[]).map((charge) => String(charge.id));
    expect(firstIds).toHaveLength(3);
    expect(first.body.has_more).toBe(true);
    const second = await call("GET", `/v1/charges?limit=3&starting_after=${firstIds[2]}`);
    const secondIds = (second.body.data as JsonObject[]).map((charge) => String(charge.id));
    expect(secondIds).toHaveLength(3);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    const back = await call("GET", `/v1/charges?limit=3&ending_before=${secondIds[0]}`);
    expect((back.body.data as JsonObject[]).map((charge) => charge.id)).toEqual(firstIds);
    const bad = await call("GET", "/v1/charges?limit=101");
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toMatchObject({ code: "parameter_invalid_integer", param: "limit" });
    const unknown = await call("GET", "/v1/charges?starting_after=ch_nope");
    expect(errorOf(unknown)).toMatchObject({ code: "resource_missing", param: "starting_after" });
  });

  it("filters by a created range", async () => {
    // The digest week: 2026-09-21T00:00Z .. 2026-09-28T13:00Z
    const reply = await call("GET", "/v1/charges?created[gte]=1789948800&created[lt]=1790600400");
    expect((reply.body.data as JsonObject[]).map((charge) => charge.id)).toEqual([
      "ch_KAng_0925",
      "ch_KAlumen_0923",
      "ch_KAhp_0922b",
      "ch_KAhp_0922a",
    ]);
  });

  it("expands ids, per object and per list item", async () => {
    const single = await call("GET", "/v1/charges/ch_KAhp_0922a?expand[]=invoice");
    expect(single.body.invoice).toMatchObject({ id: "in_KAhp_202609", object: "invoice" });
    const list = await call("GET", "/v1/refunds?expand[]=data.charge");
    expect((list.body.data as JsonObject[])[0]?.charge).toMatchObject({
      id: "ch_KAlumen_0826",
      amount_refunded: 4900,
    });
    const wrong = await call("GET", "/v1/refunds?expand[]=charge");
    expect(wrong.status).toBe(400);
  });

  it("answers a missing object with resource_missing", async () => {
    const reply = await call("GET", "/v1/charges/ch_missing");
    expect(reply.status).toBe(404);
    expect(errorOf(reply)).toMatchObject({
      type: "invalid_request_error",
      code: "resource_missing",
      param: "id",
      message: "No such charge: 'ch_missing'",
    });
  });

  it("derives payment intents from charges", async () => {
    const reply = await call("GET", "/v1/payment_intents/pi_KAng_0925");
    expect(reply.body).toMatchObject({
      object: "payment_intent",
      status: "requires_payment_method",
      latest_charge: "ch_KAng_0925",
      last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" },
    });
    const list = await call("GET", "/v1/payment_intents?customer=cus_KAharborpine&limit=1");
    expect((list.body.data as JsonObject[])[0]?.id).toBe("pi_KAhp_0922b");
  });

  it("lists invoices, subscriptions (canceled only on request) and the balance", async () => {
    const open = await call("GET", "/v1/invoices?status=open");
    expect((open.body.data as JsonObject[]).map((invoice) => invoice.id)).toEqual([
      "in_KAng_202609",
    ]);
    const subscriptions = await call("GET", "/v1/subscriptions");
    const ids = (subscriptions.body.data as JsonObject[]).map((entry) => entry.id);
    expect(ids).not.toContain("sub_KAorchardrow");
    const all = await call("GET", "/v1/subscriptions?status=all");
    expect((all.body.data as JsonObject[]).map((entry) => entry.id)).toContain("sub_KAorchardrow");
    const balance = await call("GET", "/v1/balance");
    expect(balance.body).toMatchObject({
      object: "balance",
      available: [{ amount: 1284500, currency: "usd" }],
      pending: [{ amount: 98000, currency: "usd" }],
    });
  });
});

describe("Stripe fake: refunds and idempotency", () => {
  const refund = { charge: "ch_KAhp_0922b", amount: "49000", reason: "duplicate" };

  it("creates exactly one refund per Idempotency-Key and replays the response", async () => {
    const first = await call("POST", "/v1/refunds", {
      form: { ...refund, "metadata[source]": "revenue-desk" },
      headers: { "idempotency-key": "key-1" },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      object: "refund",
      amount: 49000,
      charge: "ch_KAhp_0922b",
      payment_intent: "pi_KAhp_0922b",
      reason: "duplicate",
      status: "succeeded",
      metadata: { source: "revenue-desk" },
    });
    expect(first.headers.get("idempotency-key")).toBe("key-1");

    const replay = await call("POST", "/v1/refunds", {
      form: { "metadata[source]": "revenue-desk", ...refund },
      headers: { "idempotency-key": "key-1" },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("original-request")).toBe(first.headers.get("request-id"));

    expect(stripe.refunds({ charge: "ch_KAhp_0922b" })).toHaveLength(1);
    expect(stripe.charge("ch_KAhp_0922b")).toMatchObject({
      amount_refunded: 49000,
      refunded: true,
    });
    expect(stripe.availableBalance()).toBe(1284500 - 49000);
    expect(stripe.writes()).toEqual([
      {
        method: "POST",
        path: "/v1/refunds",
        idempotencyKey: "key-1",
        status: 200,
        replayed: false,
      },
      { method: "POST", path: "/v1/refunds", idempotencyKey: "key-1", status: 200, replayed: true },
    ]);
  });

  it("refuses the same key with different parameters", async () => {
    await call("POST", "/v1/refunds", { form: refund, headers: { "idempotency-key": "key-2" } });
    const reply = await call("POST", "/v1/refunds", {
      form: { ...refund, amount: "100" },
      headers: { "idempotency-key": "key-2" },
    });
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toMatchObject({ type: "idempotency_error" });
    expect(stripe.refunds({ charge: "ch_KAhp_0922b" })).toHaveLength(1);
  });

  it("enforces refund rules: remaining amount, already refunded, failed charges, reasons", async () => {
    const tooMuch = await call("POST", "/v1/refunds", {
      form: { charge: "ch_KAlumen_0826", amount: "14900" },
    });
    expect(tooMuch.status).toBe(400);
    expect(errorOf(tooMuch)).toMatchObject({ code: "amount_too_large", param: "amount" });

    const rest = await call("POST", "/v1/refunds", { form: { charge: "ch_KAlumen_0826" } });
    expect(rest.body).toMatchObject({ amount: 10000, reason: null });
    const again = await call("POST", "/v1/refunds", { form: { charge: "ch_KAlumen_0826" } });
    expect(errorOf(again)).toMatchObject({ code: "charge_already_refunded" });

    const failed = await call("POST", "/v1/refunds", { form: { charge: "ch_KAng_0925" } });
    expect(errorOf(failed)).toMatchObject({ code: "charge_not_refundable" });

    const reason = await call("POST", "/v1/refunds", {
      form: { charge: "ch_KAhp_0922b", reason: "mistake" },
    });
    expect(errorOf(reason)).toMatchObject({ param: "reason" });

    const unknown = await call("POST", "/v1/refunds", { form: { charge: "ch_nope" } });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown)).toMatchObject({ code: "resource_missing", param: "charge" });

    const none = await call("POST", "/v1/refunds", { form: { amount: "100" } });
    expect(errorOf(none)).toMatchObject({ code: "parameter_missing" });
  });

  it("refunds by payment_intent", async () => {
    const reply = await call("POST", "/v1/refunds", {
      form: { payment_intent: "pi_KAhp_0922b", amount: "1000" },
    });
    expect(reply.body).toMatchObject({ charge: "ch_KAhp_0922b", amount: 1000 });
  });

  it("cancels a subscription with DELETE and refuses a second cancel", async () => {
    const reply = await call(
      "DELETE",
      "/v1/subscriptions/sub_KAlumenyoga?cancellation_details[comment]=closing",
    );
    expect(reply.body).toMatchObject({
      status: "canceled",
      cancellation_details: { comment: "closing", reason: "cancellation_requested" },
    });
    expect(reply.body.canceled_at).toEqual(expect.any(Number));
    const again = await call("DELETE", "/v1/subscriptions/sub_KAlumenyoga");
    expect(again.status).toBe(400);
  });
});

describe("Stripe fake: injected provider failures", () => {
  it("answers a decline with the 402 card_error envelope and records it without side effects", async () => {
    const fault = stripe.faults.decline("/v1/refunds", { method: "POST" });
    const reply = await call("POST", "/v1/refunds", {
      form: { charge: "ch_KAhp_0922b" },
      headers: { "idempotency-key": "k-402" },
    });
    expect(reply.status).toBe(402);
    expect(errorOf(reply)).toMatchObject({
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
    });
    expect(fault.hits).toBe(1);
    expect(stripe.refunds({ charge: "ch_KAhp_0922b" })).toEqual([]);
    expect(stripe.requests.at(-1)).toMatchObject({
      status: 402,
      fault: "stripe-402-card-declined",
    });
    // The fault is used up: the same key now reaches the route.
    const next = await call("POST", "/v1/refunds", {
      form: { charge: "ch_KAhp_0922b" },
      headers: { "idempotency-key": "k-402" },
    });
    expect(next.status).toBe(200);
  });

  it("rate-limits with 429 and Retry-After for a set number of requests", async () => {
    stripe.faults.rateLimit("/v1/charges", { times: 2, retryAfterSeconds: 1 });
    const first = await call("GET", "/v1/charges");
    const second = await call("GET", "/v1/charges");
    const third = await call("GET", "/v1/charges");
    expect([first.status, second.status, third.status]).toEqual([429, 429, 200]);
    expect(errorOf(first)).toMatchObject({ code: "rate_limit" });
    expect(first.headers.get("retry-after")).toBe("1");
  });

  it("can drop the connection (a network error)", async () => {
    stripe.faults.drop("/v1/balance");
    await expect(call("GET", "/v1/balance")).rejects.toThrow();
    expect((await call("GET", "/v1/balance")).status).toBe(200);
  });

  it("records requests with credentials redacted", async () => {
    await call("GET", "/v1/balance");
    const recorded = stripe.requests.at(-1);
    expect(recorded?.headers.authorization).toBe("Bearer [redacted]");
    expect(JSON.stringify(stripe.requests)).not.toContain(KEY);
  });
});
