import { describe, expect, it } from "vitest";
import { ApiToolError } from "../../../src/gateway/api-server.js";
import { StripeClient, stripeError } from "../../../src/integrations/stripe/client.js";
import { encodeForm, formPairs } from "../../../src/integrations/stripe/form.js";
import { networkError, paramsOf, secret, stubFetch } from "./helpers.js";

const KEY = "sk_test_unit_0123456789abcdef";
const IDEMPOTENCY = "f".repeat(64);

function client(
  mock: ReturnType<typeof stubFetch>,
  overrides: Partial<ConstructorParameters<typeof StripeClient>[0]> = {},
) {
  return new StripeClient({
    secretKey: secret(KEY),
    apiVersion: "2025-09-30.clover",
    allowLive: false,
    http: mock.http,
    ...overrides,
  });
}

describe("Stripe form encoding", () => {
  it("uses bracket syntax for objects and indexed arrays", () => {
    expect(
      formPairs({
        amount: 4900,
        charge: "ch_1",
        metadata: { ticket: "t 1", empty: undefined },
        expand: ["charge", "payment_intent"],
        items: [{ price: "price_1", quantity: 2 }],
        created: { gte: 10, lt: undefined },
        flag: false,
        skip: null,
      }),
    ).toEqual([
      ["amount", "4900"],
      ["charge", "ch_1"],
      ["metadata[ticket]", "t 1"],
      ["expand[0]", "charge"],
      ["expand[1]", "payment_intent"],
      ["items[0][price]", "price_1"],
      ["items[0][quantity]", "2"],
      ["created[gte]", "10"],
      ["flag", "false"],
    ]);
  });

  it("percent-encodes values and keeps brackets in keys readable", () => {
    expect(encodeForm({ metadata: { "note key": "a&b=c ü" }, email: "a+b@x.test" })).toBe(
      "metadata[note%20key]=a%26b%3Dc%20%C3%BC&email=a%2Bb%40x.test",
    );
    expect(encodeForm({})).toBe("");
    expect(() => encodeForm({ amount: Number.NaN })).toThrow(/finite/);
  });
});

describe("StripeClient", () => {
  it("sends a read to api.stripe.com with Bearer auth, the API version and bracket query parameters", async () => {
    const mock = stubFetch(() => ({ json: { object: "list", data: [] } }));
    await client(mock).get(
      "/v1/charges",
      { customer: "cus_1", created: { gte: 5 }, limit: 3 },
      undefined,
    );
    const [request] = mock.requests;
    expect(request?.method).toBe("GET");
    expect(request?.url.origin).toBe("https://api.stripe.com");
    expect(request?.url.pathname).toBe("/v1/charges");
    expect(paramsOf(request?.url.search ?? "")).toEqual({
      customer: "cus_1",
      "created[gte]": "5",
      limit: "3",
    });
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.headers["stripe-version"]).toBe("2025-09-30.clover");
    expect(request?.headers["idempotency-key"]).toBeUndefined();
    expect(request?.body).toBe("");
  });

  it("omits Stripe-Version when none is configured", async () => {
    const mock = stubFetch(() => ({ json: {} }));
    await client(mock, { apiVersion: null }).get("/v1/balance", {}, undefined);
    expect(mock.requests[0]?.headers["stripe-version"]).toBeUndefined();
  });

  it("sends a POST as a form with the gateway's idempotency key", async () => {
    const mock = stubFetch(() => ({ json: { id: "re_1", object: "refund" } }));
    const body = await client(mock).post(
      "/v1/refunds",
      { charge: "ch_1", amount: 4900, metadata: { ticket: "t1" } },
      { idempotencyKey: IDEMPOTENCY, signal: undefined },
    );
    expect(body).toEqual({ id: "re_1", object: "refund" });
    const [request] = mock.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url.search).toBe("");
    expect(request?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(request?.headers["idempotency-key"]).toBe(IDEMPOTENCY);
    expect(request?.body).toBe("charge=ch_1&amount=4900&metadata[ticket]=t1");
  });

  it("sends DELETE parameters in the query string with the idempotency key", async () => {
    const mock = stubFetch(() => ({ json: { id: "sub_1", status: "canceled" } }));
    await client(mock).delete(
      "/v1/subscriptions/sub_1",
      { prorate: true, cancellation_details: { comment: "churn" } },
      { idempotencyKey: IDEMPOTENCY, signal: undefined },
    );
    const [request] = mock.requests;
    expect(request?.method).toBe("DELETE");
    expect(paramsOf(request?.url.search ?? "")).toEqual({
      prorate: "true",
      "cancellation_details[comment]": "churn",
    });
    expect(request?.headers["idempotency-key"]).toBe(IDEMPOTENCY);
    expect(request?.headers["content-type"]).toBeUndefined();
  });

  it("refuses a write without an idempotency key before sending anything", async () => {
    const mock = stubFetch(() => ({ json: {} }));
    await expect(
      client(mock).post(
        "/v1/refunds",
        { charge: "ch_1" },
        { idempotencyKey: " ", signal: undefined },
      ),
    ).rejects.toMatchObject({ provider: "stripe", code: "idempotency_key_missing" });
    expect(mock.requests).toHaveLength(0);
  });

  it("refuses live keys unless the connection allows them", () => {
    const mock = stubFetch(() => ({ json: {} }));
    for (const key of ["sk_live_abc", "rk_live_abc"]) {
      expect(() => client(mock, { secretKey: secret(key) })).toThrow(ApiToolError);
      expect(() => client(mock, { secretKey: secret(key), allowLive: true })).not.toThrow();
    }
  });

  it("normalises Stripe's error envelope, including the decline code", async () => {
    const mock = stubFetch(() => ({
      status: 402,
      json: {
        error: {
          type: "card_error",
          code: "card_declined",
          decline_code: "insufficient_funds",
          message: "Your card has insufficient funds.",
          param: "source",
        },
      },
    }));
    const error = await client(mock)
      .get("/v1/charges", {}, undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiToolError);
    expect((error as ApiToolError).toJSON()).toEqual({
      provider: "stripe",
      status: 402,
      code: "card_declined",
      message:
        "Your card has insufficient funds. (decline code: insufficient_funds) (parameter: source)",
    });
  });

  it("falls back to the error type, then the HTTP status, and never echoes the key", () => {
    expect(
      stripeError(400, { error: { type: "invalid_request_error", message: `bad key ${KEY}` } }, [
        KEY,
      ]).toJSON(),
    ).toEqual({
      provider: "stripe",
      status: 400,
      code: "invalid_request_error",
      message: "bad key [redacted]",
    });
    expect(stripeError(502, undefined).toJSON()).toEqual({
      provider: "stripe",
      status: 502,
      code: "http_502",
      message: "Stripe returned HTTP 502.",
    });
  });

  it("retries a read on 429 but not a write", async () => {
    const rateLimited = {
      status: 429,
      json: {
        error: { type: "invalid_request_error", code: "rate_limit", message: "Too many requests" },
      },
    };
    const reads = stubFetch((_, index) => (index === 0 ? rateLimited : { json: { data: [] } }));
    await expect(client(reads).get("/v1/refunds", {}, undefined)).resolves.toEqual({ data: [] });
    expect(reads.requests).toHaveLength(2);

    const writes = stubFetch(() => rateLimited);
    await expect(
      client(writes).post(
        "/v1/refunds",
        { charge: "ch_1" },
        { idempotencyKey: IDEMPOTENCY, signal: undefined },
      ),
    ).rejects.toMatchObject({ status: 429, code: "rate_limit" });
    expect(writes.requests).toHaveLength(1);
  });

  it("reports a network failure as a ToolFailure with a network code", async () => {
    const mock = stubFetch(() => networkError("ECONNREFUSED"));
    await expect(client(mock).get("/v1/balance", {}, undefined)).rejects.toMatchObject({
      provider: "stripe",
      code: "network_error",
    });
    expect(mock.requests).toHaveLength(3);
  });

  it("reports a refund sent without an answer as outcome_unknown, never as failed", async () => {
    const mock = stubFetch(() => networkError("ECONNRESET"));
    const error = await client(mock)
      .post(
        "/v1/refunds",
        { charge: "ch_1", amount: 4900 },
        { idempotencyKey: IDEMPOTENCY, signal: undefined },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiToolError);
    expect(error).toMatchObject({ provider: "stripe", code: "outcome_unknown" });
    expect((error as ApiToolError).message).toMatch(
      /^Stripe did not answer after the request was sent/,
    );
    expect((error as ApiToolError).message).toContain(
      "may already have been made. Do not repeat it",
    );
    // Never retried: a second POST could refund twice.
    expect(mock.requests).toHaveLength(1);
    // Refused before sending: plainly a network error.
    const refused = stubFetch(() => networkError("ECONNREFUSED"));
    await expect(
      client(refused).post(
        "/v1/refunds",
        { charge: "ch_1" },
        { idempotencyKey: IDEMPOTENCY, signal: undefined },
      ),
    ).rejects.toMatchObject({ code: "network_error" });
  });

  it("rejects a success body that is not a JSON object", async () => {
    const mock = stubFetch(() => ({ text: "ok" }));
    await expect(client(mock).get("/v1/balance", {}, undefined)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
