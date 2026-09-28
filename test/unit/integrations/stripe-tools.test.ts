import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import type { ApiTool } from "../../../src/integrations/shared/api-tool.js";
import { StripeClient } from "../../../src/integrations/stripe/client.js";
import { STRIPE_PROFILE } from "../../../src/integrations/stripe/profile.js";
import { createStripeTools, customerSearchQuery } from "../../../src/integrations/stripe/tools.js";
import {
  at,
  callContext,
  type FetchMock,
  mockFetch,
  paramsOf,
  type Reply,
  secret,
} from "./helpers.js";

function setup(reply: Reply | ((index: number) => Reply), timezone?: string) {
  const mock = mockFetch((_, index) => (typeof reply === "function" ? reply(index) : reply));
  const client = new StripeClient({
    baseUrl: "https://api.stripe.test",
    secretKey: secret("sk_test_tools"),
    apiVersion: null,
    allowLive: false,
    http: mock.http,
  });
  const options = timezone === undefined ? {} : { timezone };
  const tools = new Map(createStripeTools(client, options).map((tool) => [tool.name, tool]));
  return { mock, tools };
}

/** Calls a tool with raw JSON arguments, as the gateway does after validating them. */
async function run(
  tools: Map<string, ApiTool>,
  name: string,
  args: JsonObject,
  context = callContext(),
): Promise<JsonValue> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.run(args, context);
}

function only(mock: FetchMock) {
  expect(mock.requests).toHaveLength(1);
  const request = mock.requests[0];
  if (request === undefined) throw new Error("no request");
  return { ...request, query: paramsOf(request.url.search), form: paramsOf(request.body) };
}

const CHARGE = {
  id: "ch_1",
  object: "charge",
  amount: 4900,
  amount_captured: 4900,
  amount_refunded: 0,
  currency: "usd",
  status: "succeeded",
  paid: true,
  refunded: false,
  customer: "cus_1",
  payment_intent: { id: "pi_1", object: "payment_intent" },
  created: 1_790_000_000,
  billing_details: { email: "ap@acme.test", name: "Acme", address: { city: "X" } },
  payment_method_details: {
    card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030, fingerprint: "fp" },
  },
  outcome: { type: "authorized", seller_message: "Payment complete.", risk_score: 12 },
  source: { huge: "object" },
  metadata: {},
};

describe("Stripe tools", () => {
  it("are exactly the stripe-api profile, with reads marked read-only", () => {
    const { tools } = setup({ json: {} });
    expect([...tools.keys()].sort()).toEqual(Object.keys(STRIPE_PROFILE.tools).sort());
    for (const [name, tool] of tools) {
      expect(tool.readOnly).toBe(STRIPE_PROFILE.tools[name]?.readOnly);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("find_customers lists by email and pages with starting_after", async () => {
    const { mock, tools } = setup({
      json: {
        object: "list",
        has_more: true,
        data: [
          { id: "cus_1", email: "ap@acme.test", name: "Acme", created: 1_790_000_000, sources: {} },
        ],
      },
    });
    const result = await run(tools, "find_customers", { email: "ap@acme.test", limit: 1 });
    const request = only(mock);
    expect(request.url.pathname).toBe("/v1/customers");
    expect(request.query).toEqual({ email: "ap@acme.test", limit: "1" });
    expect(result).toEqual({
      data: [
        { id: "cus_1", name: "Acme", email: "ap@acme.test", created: "2026-09-21T14:13:20.000Z" },
      ],
      has_more: true,
      next_starting_after: "cus_1",
    });
  });

  it("find_customers searches by name when no system gave an email", async () => {
    const { mock, tools } = setup({
      json: {
        object: "search_result",
        has_more: true,
        next_page: "page_2",
        url: "/v1/customers/search",
        data: [{ id: "cus_1", email: "ap@acme.test", name: "Acme & Co", created: 1_790_000_000 }],
      },
    });
    const result = await run(tools, "find_customers", { name: ' Acme "&" Co ', limit: 5 });
    const request = only(mock);
    expect(request.url.pathname).toBe("/v1/customers/search");
    // Quotes are escaped in Stripe's search query language.
    expect(request.query).toEqual({ query: 'name~"Acme \\"&\\" Co"', limit: "5" });
    expect(result).toEqual({
      data: [
        {
          id: "cus_1",
          name: "Acme & Co",
          email: "ap@acme.test",
          created: "2026-09-21T14:13:20.000Z",
        },
      ],
      has_more: true,
      next_page: "page_2",
    });
  });

  it("find_customers narrows a name search by email and pages it with page", async () => {
    const { mock, tools } = setup({ json: { object: "search_result", has_more: false, data: [] } });
    await run(tools, "find_customers", { name: "Acme", email: "ap@acme.test", page: "page_2" });
    expect(only(mock).query).toEqual({
      query: 'name~"Acme" AND email:"ap@acme.test"',
      page: "page_2",
    });
    expect(customerSearchQuery("a\\b", undefined)).toBe('name~"a\\\\b"');
  });

  it("find_customers refuses mixed paging cursors without calling Stripe", async () => {
    const { mock, tools } = setup({ json: {} });
    await expect(
      run(tools, "find_customers", { name: "Acme", starting_after: "cus_1" }),
    ).rejects.toThrow(/page \(next_page\), not starting_after/);
    await expect(run(tools, "find_customers", { page: "page_2" })).rejects.toThrow(
      /give the same name/,
    );
    expect(mock.requests).toHaveLength(0);
  });

  it("describes find_customers so an email is never guessed", () => {
    const { tools } = setup({ json: {} });
    const tool = tools.get("find_customers");
    expect(tool?.description).toContain("search by name");
    const email = tool?.input.email as { description?: string } | undefined;
    expect(email?.description).toContain("never guess one or build it from a company name");
  });

  it("writes timestamps in the workspace time zone with their offset", async () => {
    const { tools } = setup(
      { json: { object: "list", has_more: false, data: [{ ...CHARGE, created: 1_790_082_012 }] } },
      "America/New_York",
    );
    const result = await run(tools, "list_charges", { customer: "cus_1" });
    // 2026-09-22T13:00:12Z is 9:00:12 AM in New York (EDT, UTC-4).
    expect(at(result, "data", 0, "created")).toBe("2026-09-22T09:00:12-04:00");
  });

  it("list_charges filters by customer and creation window and returns compact charges", async () => {
    const { mock, tools } = setup({ json: { object: "list", has_more: false, data: [CHARGE] } });
    const result = await run(tools, "list_charges", {
      customer: "cus_1",
      created_after: "2026-09-01",
      created_before: "2026-10-01T00:00:00Z",
      limit: 10,
    });
    const request = only(mock);
    expect(request.url.pathname).toBe("/v1/charges");
    expect(request.query).toEqual({
      customer: "cus_1",
      "created[gte]": String(Date.UTC(2026, 8, 1) / 1000),
      "created[lt]": String(Date.UTC(2026, 9, 1) / 1000),
      limit: "10",
    });
    expect(at(result, "next_starting_after")).toBeNull();
    expect(at(result, "data", 0)).toEqual({
      id: "ch_1",
      amount: 4900,
      amount_captured: 4900,
      amount_refunded: 0,
      currency: "usd",
      status: "succeeded",
      paid: true,
      refunded: false,
      customer: "cus_1",
      payment_intent: "pi_1",
      created: "2026-09-21T14:13:20.000Z",
      billing_name: "Acme",
      billing_email: "ap@acme.test",
      card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030 },
      outcome: { type: "authorized", seller_message: "Payment complete." },
    });
  });

  it("routes the other reads to their REST operations", async () => {
    const cases: Array<[string, JsonObject, string, Record<string, string>]> = [
      ["get_customer", { customer: "cus_9" }, "/v1/customers/cus_9", {}],
      [
        "list_payment_intents",
        { customer: "cus_9", limit: 5 },
        "/v1/payment_intents",
        { customer: "cus_9", limit: "5" },
      ],
      [
        "list_invoices",
        { status: "open", limit: 10 },
        "/v1/invoices",
        { status: "open", limit: "10" },
      ],
      ["get_invoice", { invoice: "in_9" }, "/v1/invoices/in_9", {}],
      [
        "list_subscriptions",
        { customer: "cus_9", status: "all", limit: 10 },
        "/v1/subscriptions",
        { customer: "cus_9", status: "all", limit: "10" },
      ],
      [
        "list_refunds",
        { charge: "ch_9", limit: 10 },
        "/v1/refunds",
        { charge: "ch_9", limit: "10" },
      ],
      ["get_balance", {}, "/v1/balance", {}],
    ];
    for (const [name, args, path, query] of cases) {
      const { mock, tools } = setup({ json: { id: "x", data: [] } });
      await run(tools, name, args);
      const request = only(mock);
      expect(request.method).toBe("GET");
      expect(request.url.pathname).toBe(path);
      expect(request.query).toEqual(query);
    }
  });

  it("get_invoice keeps its lines; list_invoices drops them", async () => {
    const invoice = {
      id: "in_1",
      number: "KA-0042",
      status: "open",
      currency: "usd",
      total: 12000,
      amount_due: 12000,
      amount_paid: 0,
      amount_remaining: 12000,
      customer: "cus_1",
      due_date: 1_790_000_000,
      status_transitions: { paid_at: null },
      lines: {
        data: [
          {
            id: "il_1",
            description: "Seats",
            amount: 12000,
            currency: "usd",
            quantity: 4,
            period: { start: 1_790_000_000, end: 1_792_592_000 },
          },
        ],
      },
    };
    const single = setup({ json: invoice });
    const one = await run(single.tools, "get_invoice", { invoice: "in_1" });
    expect(at(one, "lines")).toEqual([
      {
        id: "il_1",
        description: "Seats",
        amount: 12000,
        currency: "usd",
        quantity: 4,
        period_start: "2026-09-21T14:13:20.000Z",
        period_end: "2026-10-21T14:13:20.000Z",
      },
    ]);
    expect(at(one, "due_date")).toBe("2026-09-21T14:13:20.000Z");
    const many = setup({ json: { data: [invoice], has_more: false } });
    const listed = await run(many.tools, "list_invoices", { limit: 10 });
    expect(at(listed, "data", 0, "lines")).toBeUndefined();
  });

  it("create_refund posts the refund with the gateway's idempotency key", async () => {
    const { mock, tools } = setup({
      json: {
        id: "re_1",
        object: "refund",
        amount: 4900,
        currency: "usd",
        status: "succeeded",
        charge: "ch_2",
        reason: "duplicate",
        created: 1_790_000_000,
        metadata: { ticket: "t1" },
      },
    });
    const result = await run(
      tools,
      "create_refund",
      { charge: "ch_2", amount: 4900, reason: "duplicate", metadata: { ticket: "t1" } },
      callContext({ idempotencyKey: "k".repeat(64) }),
    );
    const request = only(mock);
    expect(request.method).toBe("POST");
    expect(request.url.pathname).toBe("/v1/refunds");
    expect(request.headers["idempotency-key"]).toBe("k".repeat(64));
    expect(request.form).toEqual({
      charge: "ch_2",
      amount: "4900",
      reason: "duplicate",
      "metadata[ticket]": "t1",
    });
    expect(result).toEqual({
      id: "re_1",
      amount: 4900,
      currency: "usd",
      status: "succeeded",
      reason: "duplicate",
      charge: "ch_2",
      created: "2026-09-21T14:13:20.000Z",
      metadata: { ticket: "t1" },
    });
  });

  it("create_refund refuses an ambiguous target and a missing idempotency key without calling Stripe", async () => {
    const { mock, tools } = setup({ json: {} });
    await expect(run(tools, "create_refund", { amount: 100 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      run(tools, "create_refund", { charge: "ch_1", payment_intent: "pi_1", amount: 100 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      run(
        tools,
        "create_refund",
        { charge: "ch_1", amount: 100 },
        callContext({ idempotencyKey: "" }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_missing" });
    expect(mock.requests).toHaveLength(0);
  });

  it("create_refund reports a Stripe error without retrying", async () => {
    const { mock, tools } = setup({
      status: 400,
      json: {
        error: {
          type: "invalid_request_error",
          code: "charge_already_refunded",
          message: "Charge ch_2 has already been refunded.",
        },
      },
    });
    await expect(
      run(tools, "create_refund", { charge: "ch_2", amount: 4900 }),
    ).rejects.toMatchObject({
      provider: "stripe",
      status: 400,
      code: "charge_already_refunded",
    });
    expect(mock.requests).toHaveLength(1);
  });

  it("cancel_subscription deletes with its options in the query", async () => {
    const { mock, tools } = setup({
      json: { id: "sub_1", status: "canceled", customer: "cus_1", items: { data: [] } },
    });
    const result = await run(tools, "cancel_subscription", {
      subscription: "sub_1",
      invoice_now: true,
      comment: "Customer churned",
    });
    const request = only(mock);
    expect(request.method).toBe("DELETE");
    expect(request.url.pathname).toBe("/v1/subscriptions/sub_1");
    expect(request.query).toEqual({
      invoice_now: "true",
      "cancellation_details[comment]": "Customer churned",
    });
    expect(request.headers["idempotency-key"]).toBe("a".repeat(64));
    expect(result).toMatchObject({ id: "sub_1", status: "canceled", items: [] });
  });
});
