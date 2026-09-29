// The API tools (Stripe's) as the gateway offers them: every zod shape becomes a
// draft-07 schema the gateway's validator compiles, with a description for
// every argument; realistic calls pass and malformed ones are rejected before
// any approval; and a call through the gateway's own API tool wrapper reaches
// the provider with the gateway's idempotency key.

import { describe, expect, expectTypeOf, it } from "vitest";
import type { StripeConnection } from "../../../src/contracts/integration.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import {
  type ApiToolDefinition,
  apiGatewayTool,
  apiInputSchema,
} from "../../../src/gateway/api-server.js";
import type { IntegrationCatalog } from "../../../src/gateway/catalog.js";
import { compileArgumentValidator } from "../../../src/gateway/validate.js";
import {
  createIntegrations,
  describeTool,
  type Integrations,
} from "../../../src/integrations/registry.js";
import type { ApiTool } from "../../../src/integrations/shared/api-tool.js";
import { mockFetch, paramsOf, secret } from "./helpers.js";

const stripe: StripeConnection = {
  integration: "stripe",
  kind: "api",
  profile: "stripe-api",
  endpointLabel: "api.stripe.test",
  api: {
    baseUrl: "https://api.stripe.test",
    secretKey: secret("sk_test_schemas"),
    keyMode: "test",
    apiVersion: null,
  },
};

function allTools(set: Integrations): Map<string, ApiTool> {
  const options = { currency: "USD" };
  const entries: Array<[string, ApiTool]> = set.stripe
    .tools(stripe, options)
    .map((tool): [string, ApiTool] => [`mcp__stripe__${tool.name}`, tool]);
  return new Map(entries);
}

/** One realistic call per API tool, as the model would make it. */
const VALID: Readonly<Record<string, JsonObject>> = {
  mcp__stripe__find_customers: { email: "dana@harborpine.test", limit: 5 },
  mcp__stripe__get_customer: { customer: "cus_KAharborpine" },
  mcp__stripe__list_charges: {
    customer: "cus_KAharborpine",
    created_after: "2026-09-01",
    created_before: "2026-10-01T00:00:00Z",
  },
  mcp__stripe__list_payment_intents: { customer: "cus_KAharborpine" },
  mcp__stripe__list_invoices: { status: "open", limit: 20 },
  mcp__stripe__get_invoice: { invoice: "in_KAhp_202609" },
  mcp__stripe__list_subscriptions: { status: "all" },
  mcp__stripe__list_refunds: { charge: "ch_KAhp_0922b" },
  mcp__stripe__get_balance: {},
  mcp__stripe__create_refund: {
    charge: "ch_KAhp_0922b",
    amount: 49000,
    reason: "duplicate",
    metadata: { thread: "18c2f" },
  },
  mcp__stripe__cancel_subscription: {
    subscription: "sub_KAlumenyoga",
    prorate: true,
    comment: "Closing",
  },
};

/** Calls the gateway must reject before approval. */
const INVALID: ReadonlyArray<readonly [string, JsonObject]> = [
  ["mcp__stripe__create_refund", { charge: "ch_1" }],
  ["mcp__stripe__create_refund", { charge: "cus_1", amount: 100 }],
  ["mcp__stripe__create_refund", { charge: "ch_1", amount: -5 }],
  ["mcp__stripe__create_refund", { charge: "ch_1", amount: 49.5 }],
  ["mcp__stripe__create_refund", { charge: "ch_1", amount: 100, currency: "usd" }],
  ["mcp__stripe__list_charges", { limit: 1000 }],
  ["mcp__stripe__list_charges", { created_after: "last week" }],
];

describe("API tool schemas as offered by the gateway", () => {
  const tools = allTools(createIntegrations());

  it("cover every API tool with a valid example", () => {
    expect([...tools.keys()].sort()).toEqual(Object.keys(VALID).sort());
  });

  it("are closed draft-07 object schemas with a description for every argument", () => {
    for (const [name, tool] of tools) {
      const schema = apiInputSchema(tool);
      expect(schema.type, name).toBe("object");
      expect(schema.additionalProperties, name).toBe(false);
      for (const [argument, property] of Object.entries(schema.properties ?? {})) {
        const described =
          typeof property === "object" && property !== null && "description" in property;
        expect(described, `${name}.${argument}`).toBe(true);
      }
    }
  });

  it("compile in the gateway's validator, accept realistic calls and reject malformed ones", () => {
    for (const [name, tool] of tools) {
      const validate = compileArgumentValidator(apiInputSchema(tool));
      expect(validate(VALID[name]), name).toEqual([]);
    }
    for (const [name, input] of INVALID) {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(name);
      expect(
        compileArgumentValidator(apiInputSchema(tool))(input).length,
        `${name} ${JSON.stringify(input)}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("the gateway seam", () => {
  it("W2's integrations are the gateway's catalog and API tools are its definitions", () => {
    expectTypeOf<Integrations>().toExtend<IntegrationCatalog>();
    expectTypeOf<ApiTool>().toExtend<ApiToolDefinition>();
    const catalog: IntegrationCatalog = createIntegrations();
    expect(catalog.stripe.id).toBe("stripe");
  });

  it("a refund through the gateway's API tool wrapper carries the gateway's idempotency key", async () => {
    const mock = mockFetch(() => ({
      json: {
        id: "re_1",
        object: "refund",
        amount: 49000,
        currency: "usd",
        status: "succeeded",
        charge: "ch_KAhp_0922b",
      },
    }));
    const set = createIntegrations({ http: mock.http });
    const refund = set.stripe
      .tools(stripe, { currency: "USD" })
      .find((tool) => tool.name === "create_refund");
    const descriptor = describeTool("mcp__stripe__create_refund");
    if (refund === undefined || descriptor === null) throw new Error("missing tool");
    const gatewayTool = apiGatewayTool(refund, descriptor);
    const key = "9".repeat(64);
    const execution = await gatewayTool.execute(
      { charge: "ch_KAhp_0922b", amount: 49000, reason: "duplicate" },
      {
        runId: "run_1",
        toolUseId: "toolu_1",
        idempotencyKey: key,
        signal: new AbortController().signal,
      },
    );
    expect(execution.error).toBeNull();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.headers["idempotency-key"]).toBe(key);
    expect(paramsOf(mock.requests[0]?.body ?? "")).toEqual({
      charge: "ch_KAhp_0922b",
      amount: "49000",
      reason: "duplicate",
    });
  });

  it("a provider error through the wrapper becomes the normalised ToolFailure", async () => {
    const mock = mockFetch(() => ({
      status: 402,
      json: {
        error: {
          type: "card_error",
          code: "card_declined",
          decline_code: "insufficient_funds",
          message: "Your card has insufficient funds.",
        },
      },
    }));
    const set = createIntegrations({ http: mock.http });
    const charges = set.stripe
      .tools(stripe, { currency: "USD" })
      .find((tool) => tool.name === "list_charges");
    const descriptor = describeTool("mcp__stripe__list_charges");
    if (charges === undefined || descriptor === null) throw new Error("missing tool");
    const execution = await apiGatewayTool(charges, descriptor).execute(
      { customer: "cus_1" },
      {
        runId: "run_1",
        toolUseId: "toolu_2",
        idempotencyKey: "x".repeat(64),
        signal: new AbortController().signal,
      },
    );
    expect(execution.error).toEqual({
      provider: "stripe",
      status: 402,
      code: "card_declined",
      message: "Your card has insufficient funds. (decline code: insufficient_funds)",
    });
    expect(execution.result.isError).toBe(true);
  });
});
