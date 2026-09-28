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
import { mockFetch, SETTINGS, secret, testEnv } from "./helpers.js";

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

  it("resolves a test key with the host as the endpoint label", () => {
    const resolution = resolveStripe(
      stripeEnv("sk_test_abc", {
        apiBaseUrl: "http://127.0.0.1:4410/stripe/",
        apiVersion: "2025-09-30.clover",
      }),
    );
    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.connection).toMatchObject({
      integration: "stripe",
      kind: "api",
      profile: "stripe-api",
      endpointLabel: "127.0.0.1:4410",
      api: {
        baseUrl: "http://127.0.0.1:4410/stripe",
        keyMode: "test",
        apiVersion: "2025-09-30.clover",
      },
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

  it("refuses publishable keys, bad base URLs and malformed versions", () => {
    expect(resolveStripe(stripeEnv("pk_test_abc"))).toMatchObject({ status: "invalid" });
    expect(
      resolveStripe(stripeEnv("sk_test_abc", { apiBaseUrl: "http://api.stripe.com" })),
    ).toMatchObject({
      status: "invalid",
      problems: [{ variable: "STRIPE_API_BASE_URL" }],
    });
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
    endpointLabel: "api.stripe.test",
    api: {
      baseUrl: "https://api.stripe.test",
      secretKey: secret("sk_test_probe"),
      keyMode: "test",
      apiVersion: null,
    },
  };

  it("reads the balance and reports connected", async () => {
    const mock = mockFetch(() => ({ json: { object: "balance", livemode: false, available: [] } }));
    await expect(probeStripe(connection, new AbortController().signal, mock.http)).resolves.toEqual(
      {
        state: "connected",
        detail: "Stripe test-mode key accepted; balance is readable.",
        accountHint: null,
      },
    );
    expect(mock.requests[0]?.url.pathname).toBe("/v1/balance");
    expect(mock.requests[0]?.method).toBe("GET");
  });

  it("reports a rejected key as needs_auth and a mode mismatch or outage as error", async () => {
    const rejected = mockFetch(() => ({
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
    const live = mockFetch(() => ({ json: { livemode: true } }));
    await expect(
      probeStripe(connection, new AbortController().signal, live.http),
    ).resolves.toMatchObject({ state: "error" });
    const down = mockFetch(() => ({ status: 503, text: "unavailable" }));
    await expect(
      probeStripe(connection, new AbortController().signal, down.http),
    ).resolves.toMatchObject({ state: "error" });
  });

  it("builds its tools from a resolved connection", () => {
    const mock = mockFetch(() => ({ json: {} }));
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
