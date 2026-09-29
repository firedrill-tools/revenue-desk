import { describe, expect, it } from "vitest";
import type { StripeConnection } from "../../../src/contracts/integration.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import { classifyStripe } from "../../../src/integrations/stripe/classify.js";
import {
  createStripeIntegration,
  probeStripe,
} from "../../../src/integrations/stripe/definition.js";
import { STRIPE_PROFILE } from "../../../src/integrations/stripe/profile.js";
import { resolveStripe } from "../../../src/integrations/stripe/resolve.js";
import { StripeRunMemory } from "../../../src/integrations/stripe/run-memory.js";
import { SETTINGS, secret, stubFetch, testEnv } from "./helpers.js";

const stripeEnv = (
  secretKey: string | null,
  extra: Partial<ReturnType<typeof testEnv>["stripe"]> = {},
) => testEnv({ stripe: { secretKey: secretKey === null ? null : secret(secretKey), ...extra } });

describe("resolveStripe", () => {
  it("is not configured without a secret key", () => {
    expect(resolveStripe(stripeEnv(null))).toEqual({
      status: "not_configured",
      missing: ["STRIPE_SECRET_KEY"],
    });
    expect(resolveStripe(stripeEnv("  "))).toEqual({
      status: "not_configured",
      missing: ["STRIPE_SECRET_KEY"],
    });
  });

  it("resolves a test key, always at Stripe's own host", () => {
    const resolution = resolveStripe(stripeEnv("sk_test_abc", { apiVersion: "2025-09-30.clover" }));
    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.connection).toEqual({
      integration: "stripe",
      kind: "api",
      profile: "stripe-api",
      endpointLabel: "api.stripe.com",
      api: { secretKey: expect.anything(), keyMode: "test", apiVersion: "2025-09-30.clover" },
    });
    expect(JSON.stringify(resolution)).not.toContain("sk_test_abc");
    expect(resolveStripe(stripeEnv("rk_test_abc")).status).toBe("configured");
  });

  it("refuses live keys unless ALLOW_LIVE_STRIPE=1, naming the variable but never the value", () => {
    const refused = resolveStripe(stripeEnv("sk_live_secretvalue"));
    expect(refused.status).toBe("invalid");
    if (refused.status === "invalid") {
      expect(refused.problems.map((p) => p.variable)).toEqual(["STRIPE_SECRET_KEY"]);
      expect(JSON.stringify(refused)).not.toContain("secretvalue");
    }
    const allowed = resolveStripe(stripeEnv("rk_live_secretvalue", { allowLive: true }));
    expect(allowed).toMatchObject({
      status: "configured",
      connection: { api: { keyMode: "live" } },
    });
  });

  it("refuses publishable keys and malformed versions", () => {
    expect(resolveStripe(stripeEnv("pk_test_abc"))).toMatchObject({ status: "invalid" });
    expect(resolveStripe(stripeEnv("sk_test_abc", { apiVersion: "2025 09" }))).toMatchObject({
      status: "invalid",
      problems: [{ variable: "STRIPE_API_VERSION" }],
    });
    expect(resolveStripe(stripeEnv(" sk_test_abc"))).toMatchObject({ status: "invalid" });
  });
});

describe("classifyStripe", () => {
  it("classifies every read as read with the profile's operation and title", () => {
    for (const spec of Object.values(STRIPE_PROFILE.tools)) {
      if (spec.baseClass !== "read") continue;
      expect(classifyStripe(spec.name, {}, SETTINGS)).toEqual({
        actionClass: "read",
        operation: spec.operation,
        title: spec.title,
      });
    }
  });

  it("classifies a refund as financial with its amount and facts", () => {
    expect(
      classifyStripe(
        "create_refund",
        { charge: "ch_2", amount: 4900, reason: "duplicate" },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "financial",
      operation: "stripe.refunds.create",
      title: "Refund charge in Stripe",
      details: {
        consequence: "Refund $49.00 on Stripe charge ch_2",
        facts: [
          { label: "Amount", value: "$49.00" },
          { label: "Charge", value: "ch_2" },
          // The run never read this charge: the card says so.
          { label: "Charge details", value: "Not read in this run" },
          { label: "Reason", value: "Duplicate charge" },
        ],
        amount: { amountMinor: 4900, currency: "USD" },
        recordIds: ["ch_2"],
      },
    });
    const byIntent = classifyStripe(
      "create_refund",
      { payment_intent: "pi_7", amount: 100 },
      { ...SETTINGS, currency: "EUR" },
    );
    expect(byIntent?.details?.consequence).toBe("Refund €1.00 on Stripe payment intent pi_7");
    expect(byIntent?.details?.amount).toEqual({ amountMinor: 100, currency: "EUR" });
  });

  it("classifies a cancellation as financial", () => {
    const result = classifyStripe(
      "cancel_subscription",
      { subscription: "sub_1", prorate: true },
      SETTINGS,
    );
    expect(result).toMatchObject({
      actionClass: "financial",
      operation: "stripe.subscriptions.cancel",
      details: {
        consequence: "Cancel Stripe subscription sub_1 immediately",
        recordIds: ["sub_1"],
      },
    });
    expect(result?.details?.facts).toContainEqual({
      label: "Proration",
      value: "Credit unused time",
    });
  });

  it("names the customer and the charge the run read (StripeRunMemory)", () => {
    const memory = new StripeRunMemory(SETTINGS);
    const refine = (tool: string, input: JsonObject) => {
      const base = classifyStripe(tool, input, SETTINGS);
      if (base === null) throw new Error(`expected a classification of ${tool}`);
      return memory.refine(tool, input, base);
    };
    // A failed read, and a charge the run has not seen, name nothing.
    memory.record("find_customers", {}, { data: [{ id: "cus_1", name: "Acme" }] }, true);
    expect(refine("create_refund", { charge: "ch_2", amount: 4900 }).details?.consequence).toBe(
      "Refund $49.00 on Stripe charge ch_2",
    );

    memory.record(
      "find_customers",
      { name: "Acme" },
      { data: [{ id: "cus_1", name: "Acme Logistics", email: "ap@acme.test" }] },
      false,
    );
    memory.record(
      "list_charges",
      { customer: "cus_1" },
      {
        data: [
          {
            id: "ch_2",
            amount: 9800,
            amount_refunded: 4900,
            currency: "eur",
            customer: "cus_1",
            payment_intent: "pi_2",
            created: "2026-09-22T09:04:37-04:00",
            description: "Seats, September",
          },
        ],
      },
      false,
    );
    const card = refine("create_refund", { payment_intent: "pi_2", amount: 4900 });
    expect(card.details).toMatchObject({
      // The charge's own currency, not the workspace's.
      consequence: "Refund €49.00 to Acme Logistics on Stripe payment intent pi_2",
      amount: { amountMinor: 4900, currency: "EUR" },
      recordIds: ["pi_2"],
    });
    expect(card.details?.facts).toEqual([
      { label: "Amount", value: "€49.00" },
      { label: "Customer", value: "Acme Logistics (cus_1)" },
      { label: "Payment intent", value: "pi_2" },
      { label: "Charged", value: '€98.00 on 2026-09-22 09:04 UTC-04:00 "Seats, September"' },
      { label: "Already refunded", value: "€49.00" },
    ]);

    memory.record(
      "list_subscriptions",
      {},
      { data: [{ id: "sub_1", customer: "cus_1", status: "active" }] },
      false,
    );
    expect(refine("cancel_subscription", { subscription: "sub_1" }).details).toMatchObject({
      consequence: "Cancel Acme Logistics's Stripe subscription sub_1 immediately",
    });
    // Reads are not refined.
    const read = classifyStripe("list_charges", {}, SETTINGS);
    if (read === null) throw new Error("expected a classification");
    expect(memory.refine("list_charges", {}, read)).toEqual(read);
  });

  describe("after the run's own refunds", () => {
    const CHARGES = {
      data: [
        {
          id: "ch_big",
          amount: 10_000,
          amount_refunded: 0,
          currency: "usd",
          customer: "cus_1",
          payment_intent: "pi_big",
        },
      ],
    };
    const refine = (memory: StripeRunMemory, input: JsonObject) => {
      const base = classifyStripe("create_refund", input, SETTINGS);
      if (base === null) throw new Error("expected a refund classification");
      return memory.refine("create_refund", input, base);
    };

    it("counts a refund this run made in what is already refunded", () => {
      const memory = new StripeRunMemory(SETTINGS);
      memory.record("list_charges", {}, CHARGES, false);
      memory.record(
        "create_refund",
        { charge: "ch_big", amount: 5_000 },
        {
          id: "re_1",
          amount: 5_000,
          charge: "ch_big",
          payment_intent: "pi_big",
          status: "succeeded",
        },
        false,
      );
      const second = refine(memory, { charge: "ch_big", amount: 5_000 });
      expect(second.details?.facts).toContainEqual({ label: "Already refunded", value: "$50.00" });
      expect(second.details?.facts).toContainEqual({
        label: "Refunded in this run",
        value: "$50.00 (re_1)",
      });
      // By payment intent too.
      expect(
        refine(memory, { payment_intent: "pi_big", amount: 5_000 }).details?.facts,
      ).toContainEqual({ label: "Already refunded", value: "$50.00" });
      // A third $50.00 is more than is left: flagged first, and in the consequence.
      memory.record(
        "create_refund",
        { charge: "ch_big", amount: 5_000 },
        { id: "re_2", amount: 5_000, charge: "ch_big", status: "pending" },
        false,
      );
      const third = refine(memory, { charge: "ch_big", amount: 5_000 });
      expect(third.details?.facts[0]).toEqual({
        label: "Check",
        value: "Nothing of this charge is left to refund; Stripe will refuse this refund.",
      });
      expect(third.details?.consequence).toBe(
        "Refund $50.00 on Stripe charge ch_big (already refunded in full)",
      );
    });

    it("flags a refund larger than what is left", () => {
      const memory = new StripeRunMemory(SETTINGS);
      memory.record(
        "list_charges",
        {},
        { data: [{ ...CHARGES.data[0], amount_refunded: 7_500 }] },
        false,
      );
      const card = refine(memory, { charge: "ch_big", amount: 5_000 });
      expect(card.details?.facts[0]).toEqual({
        label: "Check",
        value: "Only $25.00 of this charge is left to refund; Stripe will refuse this refund.",
      });
      expect(card.details?.consequence).toBe(
        "Refund $50.00 on Stripe charge ch_big (more than the $25.00 left to refund)",
      );
      expect(refine(memory, { charge: "ch_big", amount: 2_500 }).details?.facts[0]?.label).toBe(
        "Amount",
      );
    });

    it("takes a complete refund list as the refunded total", () => {
      const memory = new StripeRunMemory(SETTINGS);
      memory.record("list_charges", {}, CHARGES, false);
      memory.record(
        "list_refunds",
        { charge: "ch_big" },
        {
          data: [
            { id: "re_a", amount: 3_000, status: "succeeded", charge: "ch_big" },
            { id: "re_b", amount: 9_999, status: "failed", charge: "ch_big" },
          ],
          has_more: false,
        },
        false,
      );
      expect(refine(memory, { charge: "ch_big", amount: 1_000 }).details?.facts).toContainEqual({
        label: "Already refunded",
        value: "$30.00",
      });
      // A partial page proves nothing.
      memory.record(
        "list_refunds",
        { charge: "ch_big" },
        { data: [{ id: "re_c", amount: 100, status: "succeeded" }], has_more: true },
        false,
      );
      expect(refine(memory, { charge: "ch_big", amount: 1_000 }).details?.facts).toContainEqual({
        label: "Already refunded",
        value: "$30.00",
      });
    });

    it("names a refund sent without an answer as possibly applied", () => {
      const memory = new StripeRunMemory(SETTINGS);
      memory.record("list_charges", {}, CHARGES, false);
      memory.record(
        "create_refund",
        { charge: "ch_big", amount: 5_000 },
        { error: { provider: "stripe", code: "outcome_unknown", message: "No answer" } },
        true,
      );
      expect(refine(memory, { charge: "ch_big", amount: 5_000 }).details?.facts).toContainEqual({
        label: "May already be applied",
        value:
          "$50.00 sent in this run got no answer from Stripe. Check the charge's refunds before approving another.",
      });
      // A declined refund teaches nothing.
      const declined = new StripeRunMemory(SETTINGS);
      declined.record("list_charges", {}, CHARGES, false);
      declined.record(
        "create_refund",
        { charge: "ch_big", amount: 5_000 },
        { error: { provider: "stripe", status: 402, code: "card_declined", message: "Declined" } },
        true,
      );
      const facts = refine(declined, { charge: "ch_big", amount: 5_000 }).details?.facts ?? [];
      expect(facts).toContainEqual({ label: "Already refunded", value: "$0.00" });
      expect(facts.map((fact) => fact.label)).not.toContain("May already be applied");
    });

    it("shows metadata as what is stored on the refund, last", () => {
      const card = classifyStripe(
        "create_refund",
        {
          charge: "ch_big",
          amount: 5_000,
          reason: "duplicate",
          metadata: { source: "revenue-desk", gmail_thread: "199a1e0c4b7f2001" },
        },
        SETTINGS,
      );
      expect(card?.details?.facts.at(-1)).toEqual({
        label: "Stored on the refund",
        value: "source=revenue-desk, gmail_thread=199a1e0c4b7f2001",
      });
      expect(card?.details?.facts.map((fact) => fact.label)).not.toContain("Note: source");
    });
  });

  it("denies unknown tools and inputs it cannot judge", () => {
    const denied: Array<[string, JsonObject]> = [
      ["delete_customer", {}],
      ["toString", {}],
      ["create_refund", { charge: "ch_1" }],
      ["create_refund", { amount: 100 }],
      ["create_refund", { charge: "ch_1", payment_intent: "pi_1", amount: 100 }],
      ["create_refund", { charge: "ch_1", amount: 0 }],
      ["create_refund", { charge: "ch_1", amount: 10.5 }],
      ["create_refund", { charge: "cus_1", amount: 100 }],
      ["cancel_subscription", { subscription: "in_1" }],
    ];
    for (const [tool, input] of denied) {
      expect(classifyStripe(tool, input, SETTINGS), `${tool} ${JSON.stringify(input)}`).toBeNull();
    }
  });
});

describe("Stripe probe and definition", () => {
  const connection: StripeConnection = {
    integration: "stripe",
    kind: "api",
    profile: "stripe-api",
    endpointLabel: "api.stripe.com",
    api: {
      secretKey: secret("sk_test_probe"),
      keyMode: "test",
      apiVersion: null,
    },
  };

  it("reads the balance and reports connected", async () => {
    const mock = stubFetch(() => ({ json: { object: "balance", livemode: false, available: [] } }));
    await expect(probeStripe(connection, new AbortController().signal, mock.http)).resolves.toEqual(
      {
        state: "connected",
        detail: "Stripe test-mode key accepted; balance is readable.",
        accountHint: null,
      },
    );
    expect(mock.requests[0]?.url.href).toBe("https://api.stripe.com/v1/balance");
    expect(mock.requests[0]?.method).toBe("GET");
  });

  it("reports a rejected key as needs_auth and a mode mismatch or outage as error", async () => {
    const rejected = stubFetch(() => ({
      status: 401,
      json: {
        error: {
          type: "invalid_request_error",
          message: "Invalid API Key provided: sk_test_****robe",
        },
      },
    }));
    await expect(
      probeStripe(connection, new AbortController().signal, rejected.http),
    ).resolves.toMatchObject({ state: "needs_auth" });
    const live = stubFetch(() => ({ json: { livemode: true } }));
    await expect(
      probeStripe(connection, new AbortController().signal, live.http),
    ).resolves.toMatchObject({ state: "error" });
    const down = stubFetch(() => ({ status: 503, text: "unavailable" }));
    await expect(
      probeStripe(connection, new AbortController().signal, down.http),
    ).resolves.toMatchObject({ state: "error" });
  });

  it("builds its tools from a resolved connection", () => {
    const mock = stubFetch(() => ({ json: {} }));
    const definition = createStripeIntegration({ http: mock.http });
    expect(definition).toMatchObject({
      id: "stripe",
      label: "Stripe",
      kind: "api",
      profile: STRIPE_PROFILE,
    });
    expect(definition.tools(connection, { currency: "USD" }).map((tool) => tool.name)).toEqual(
      Object.keys(STRIPE_PROFILE.tools),
    );
  });
});
