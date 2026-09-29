/**
 * Live write, Stripe test mode only: the agent refunds a real test-mode
 * charge through Revenue Desk's Stripe API integration.
 *
 * The test makes its own target with Stripe's API (a customer, and a
 * PaymentIntent confirmed with the test card pm_card_visa), asks the agent
 * in the headless CLI to refund that charge with financial actions set to
 * auto, confirms the refund with Stripe, and deletes the customer afterwards.
 * Stripe keeps test-mode payments and refunds; they cannot be deleted.
 *
 * Refuses (skips with the reason, or fails when LIVE_REQUIRE names stripe)
 * unless STRIPE_SECRET_KEY is an sk_test_ or rk_test_ key and Stripe reports
 * test mode.
 *
 * Runs only under `LIVE_E2E=1 LIVE_E2E_WRITES=1 pnpm test:live:writes`.
 */
import { describe, expect, it } from "vitest";
import {
  agentEnvOf,
  askJson,
  cannotTest,
  checkLive,
  describeRun,
  liveEnvironment,
  liveMarker,
  liveStateDir,
  type Policy,
  prepareWorkspace,
  ranCalls,
  requireLiveWrites,
  storedRun,
  unavailableReason,
} from "../support.js";
import { stripeApi, stripeTestKey } from "./support.js";

requireLiveWrites();

const BUDGET_USD = 0.5;
const AMOUNT_MINOR = 1234;
/** Refunds allowed without asking; nothing else that writes. */
const REFUND_POLICY: Policy = {
  read: "auto",
  financial: "auto",
  internal_write: "deny",
  outbound: "deny",
  destructive: "deny",
};

describe("live write: Stripe test mode", () => {
  it("refunds a test-mode charge, exactly once, with an idempotency key", async (context) => {
    const label = "live write stripe";
    if (stripeTestKey() === null) {
      const reason = "Refused: STRIPE_SECRET_KEY is not set or is not a test-mode key.";
      cannotTest(context, label, "stripe", reason);
    }
    const balance = await stripeApi("GET", "/v1/balance");
    if (balance.livemode !== false) {
      cannotTest(
        context,
        label,
        "stripe",
        "Refused: Stripe did not report test mode for this key.",
      );
    }

    const state = liveStateDir("write-stripe");
    context.onTestFinished(() => state.cleanup());
    const environment = liveEnvironment(state.dir, ["stripe"], {
      AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
    });
    const connections = await checkLive(agentEnvOf(environment));
    const reason = unavailableReason(connections, "stripe");
    if (reason !== null) cannotTest(context, label, "stripe", reason);
    prepareWorkspace(state.dir, connections);

    const marker = liveMarker();
    const customer = await stripeApi("POST", "/v1/customers", {
      name: `Revenue Desk live test ${marker}`,
      email: `${marker}@example.com`,
      "metadata[revenue_desk_live_test]": marker,
    });
    const customerId = String(customer.id);
    context.onTestFinished(async () => {
      await stripeApi("DELETE", `/v1/customers/${customerId}`);
    });
    const intent = await stripeApi("POST", "/v1/payment_intents", {
      amount: String(AMOUNT_MINOR),
      currency: "usd",
      customer: customerId,
      payment_method: "pm_card_visa",
      confirm: "true",
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      description: marker,
    });
    expect(intent.status).toBe("succeeded");
    const chargeId = String(intent.latest_charge);

    const { run, summary } = await askJson({
      state,
      environment,
      policy: REFUND_POLICY,
      budgetUsd: BUDGET_USD,
      prompt:
        `Customer ${customerId} asked us to refund Stripe charge ${chargeId} ($12.34). ` +
        "Refund that charge in full with the reason requested_by_customer. Do nothing else.",
    });
    console.log(describeRun("write stripe", run, summary));
    expect(run.code, "exit code").toBe(0);
    expect(summary.status).toBe("completed");

    const refunds = ranCalls(summary).filter((call) => call.tool === "mcp__stripe__create_refund");
    expect(refunds.map((call) => [call.decision, call.isError])).toEqual([["auto", false]]);
    const stored = storedRun(state.dir, summary.runId).calls.filter(
      (call) => call.tool_name === "mcp__stripe__create_refund",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      integration: "stripe",
      action_class: "financial",
      status: "succeeded",
      http_status: 200,
    });
    expect(stored[0]?.idempotency_key ?? "").toMatch(/\S{16,}/);

    // Stripe agrees: one refund of the whole charge.
    const listed = await stripeApi("GET", "/v1/refunds", { charge: chargeId });
    const data = listed.data as { amount: number; status: string }[];
    expect(data.map((refund) => [refund.amount, refund.status])).toEqual([
      [AMOUNT_MINOR, "succeeded"],
    ]);
  });
});
