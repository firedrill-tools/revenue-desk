/**
 * Full stack: a Stripe key that is revoked mid-session (rolled in the
 * Dashboard). The boot check still passed, then every Stripe call of a run
 * answers 401. The connection must say so right away: the Connections
 * screen shows it needs a new key with what to do, and the next run leaves
 * Stripe out instead of offering tools that can only fail.
 * Fails, never skips, without the native Claude CLI.
 */
import { describe, expect, it } from "vitest";
import { runConversationOverHttp } from "../../scenarios/run-over-http.js";
import { type Scenario, text } from "../../scenarios/script.js";
import { stripe } from "../../scenarios/tools.js";
import { startHarness } from "../../support/harness.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";
import { agentRequests, readRunRows } from "./support.js";

const LIST_CHARGES: Scenario = {
  id: "stripe-key-revoked",
  job: "failure",
  title: "Stripe refuses a revoked key mid-session",
  prompt: "List this week's Stripe charges.",
  steps: [
    () => [stripe.listCharges("st_list", { created_after: "2026-09-21", limit: 10 })],
    () => [text("Stripe refused the API key, so I could not list the charges.")],
  ],
  approvals: {},
  expected: { status: "completed", replyIncludes: ["refused the API key"] },
};

const AFTER: Scenario = {
  id: "stripe-left-out",
  job: "failure",
  title: "The next run without Stripe",
  prompt: "Try the charges again.",
  steps: [() => [text("Stripe is unavailable in this run.")]],
  approvals: {},
  expected: { status: "completed", replyIncludes: ["unavailable"] },
};

describe("full stack: a credential that stops working during a run", () => {
  it("marks the connection at once, and the next run leaves Stripe out", {
    timeout: 120_000,
  }, async () => {
    requireNativeSdkBinary();
    const turns = [LIST_CHARGES, AFTER];
    const harness = await startHarness({ server: "in-process", model: turns });
    try {
      const api = harness.api;
      if (api === null) throw new Error("The harness has no server");
      await api.session();
      // The boot check passed; the key is revoked afterwards.
      await expect
        .poll(async () => {
          const { items } = await api.expect("GET /api/connections", {});
          return items.find((item) => item.integration === "stripe")?.state;
        })
        .toBe("connected");
      harness.fakes.stripe.faults.revokedKey(/\/v1\//, { times: Number.POSITIVE_INFINITY });

      const played = await runConversationOverHttp(harness, turns);
      expect(played.problems, harness.serverLog().slice(-4_000)).toEqual([]);
      const [first, second] = played.turns;
      if (first?.runId == null || second?.runId == null) throw new Error("missing run ids");

      // The run's failed call is what the connection now says.
      expect(readRunRows(harness.stateDir, first.runId).call("st_list")).toMatchObject({
        status: "failed",
        http_status: 401,
      });
      const { items } = await api.expect("GET /api/connections", {});
      const row = items.find((item) => item.integration === "stripe");
      expect(row?.state).toBe("needs_auth");
      expect(row?.detail.split("\n")[0]).toBe(
        "Stripe rejected the API key. Put a new STRIPE_SECRET_KEY in your configuration file and restart Revenue Desk.",
      );

      // The next run does not offer Stripe, and says why.
      const next = readRunRows(harness.stateDir, second.runId);
      expect(next.connection("stripe")).toMatchObject({
        availability: "unavailable",
        state: "needs_auth",
      });
      const lastRequest = agentRequests(harness.model).at(-1);
      const tools = JSON.stringify(lastRequest?.tools ?? []);
      expect(tools).not.toContain("mcp__stripe__");
      expect(tools).toContain("mcp__gmail__");
    } finally {
      await harness.close();
    }
  });
});
