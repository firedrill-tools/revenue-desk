/**
 * Composition check: the agent core (runTurn) with the production
 * integrations registry (src/integrations/registry.ts), its connection
 * snapshot and the contract-faithful Stripe fake, driven by the real Claude
 * Agent SDK against the scripted model. A J2-style duplicate refund is
 * approved through the policy's approval gate and must reach Stripe exactly
 * once, with the gateway's idempotency key. Fails, never skips, without the
 * native CLI.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRunTurn } from "../../src/agent/run-turn.js";
import type { AgentEvent, RunTurnInput } from "../../src/contracts/events.js";
import { DEFAULT_POLICY } from "../../src/contracts/integration.js";
import { idempotencyKeyFor } from "../../src/gateway/context.js";
import { connectionSnapshot, createIntegrations } from "../../src/integrations/registry.js";
import { approvalWaiters, createApprovalGate } from "../../src/policy/approvals.js";
import { tempStateDir, testEnv } from "../helpers/agent-fixtures.js";
import { MemoryApprovalStore } from "../helpers/approval-store.js";
import { eventContractViolations, ofType } from "../helpers/event-contract.js";
import { createClock } from "../support/fakes/core/clock.js";
import { FAKE_CREDENTIAL_VALUES, FAKE_CREDENTIALS } from "../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../support/fakes/fixtures.js";
import { StripeFake } from "../support/fakes/stripe/index.js";
import { type Responder, startMockAnthropic } from "../support/mock-anthropic.js";
import {
  offeredTools,
  requireNativeSdkBinary,
  stepIndex,
  strayTraffic,
} from "../support/sdk-gate-support.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  approvalWaiters().clear();
});

const responder: Responder = (body) => {
  if (!offeredTools(body).includes("mcp__stripe__create_refund")) return undefined;
  switch (stepIndex(body)) {
    case 0:
      return [
        {
          type: "tool_use",
          id: "toolu_charges",
          name: "mcp__stripe__list_charges",
          input: { customer: "cus_KAharborpine", created_after: "2026-09-22", limit: 10 },
        },
      ];
    case 1:
      return [
        { type: "text", text: "Refunding the duplicate charge ch_KAhp_0922b ($490.00)." },
        {
          type: "tool_use",
          id: "toolu_refund",
          name: "mcp__stripe__create_refund",
          input: { charge: "ch_KAhp_0922b", amount: 49000, reason: "duplicate" },
        },
      ];
    default:
      return [{ type: "text", text: "Refunded $490.00 for the duplicate charge." }];
  }
};

describe("runTurn with the integrations registry", () => {
  it("refunds a duplicate charge once, after approval, with the gateway's idempotency key", {
    timeout: 120_000,
  }, async () => {
    requireNativeSdkBinary();
    const fixtures = loadBusinessFixtures();
    const stripe = await StripeFake.start({
      fixture: fixtures.stripe,
      clock: createClock(fixtures.company.asOf),
      secretKey: FAKE_CREDENTIALS.stripeSecretKey,
      prefix: "/stripe",
    });
    cleanups.push(() => stripe.close());
    const mock = await startMockAnthropic(FAKE_CREDENTIALS.anthropicApiKey, responder);
    cleanups.push(() => mock.close());
    const state = tempStateDir("revenue-desk-compose-");
    cleanups.push(state.cleanup);

    const env = testEnv({
      ANTHROPIC_API_KEY: FAKE_CREDENTIALS.anthropicApiKey,
      ANTHROPIC_BASE_URL: mock.url,
      AGENT_STATE_DIR: state.dir,
      HTTP_PROXY: mock.url,
      HTTPS_PROXY: mock.url,
      NO_PROXY: "127.0.0.1,localhost",
      CLAUDE_CODE_MAX_RETRIES: "0",
      STRIPE_SECRET_KEY: FAKE_CREDENTIALS.stripeSecretKey,
      STRIPE_API_BASE_URL: stripe.baseUrl,
      STRIPE_API_VERSION: fixtures.stripe.account.apiVersion,
    });
    const integrations = createIntegrations({ http: { sleep: async () => {} } });
    const { plans } = connectionSnapshot(integrations, env);
    const store = new MemoryApprovalStore();
    const gate = createApprovalGate({ store });
    const runTurn = createRunTurn({ catalog: integrations, version: "0.0.0-test" });
    const input: RunTurnInput = {
      runId: "run_compose",
      conversationId: "conv_compose",
      source: "ui",
      prompt: "Harbor & Pine say they were charged twice this month. Refund the duplicate.",
      resumeSessionId: null,
      env,
      model: {
        model: "claude-sonnet-5",
        effort: "medium",
        thinkingDisplay: "omitted",
        maxTurns: 8,
        maxBudgetUsd: 2,
      },
      settings: { ...fixtures.company.workspaceSettings, updatedAt: fixtures.company.asOf },
      policy: DEFAULT_POLICY,
      businessDate: fixtures.company.asOf.slice(0, 10),
      connections: plans,
      signal: new AbortController().signal,
      mode: "interactive",
      approvals: gate,
    };

    const events: AgentEvent[] = [];
    for await (const event of runTurn(input)) {
      events.push(event);
      if (event.type === "approval.requested") {
        expect(stripe.refunds({ charge: "ch_KAhp_0922b" })).toHaveLength(0);
        gate.decide(event.approvalId, { approved: true });
      }
    }

    expect(eventContractViolations(events)).toEqual([]);
    expect(ofType(events, "approval.requested")[0]?.descriptor).toMatchObject({
      consequence: "Refund $490.00 on Stripe charge ch_KAhp_0922b",
      actionClass: "financial",
      amount: { amountMinor: 49000, currency: "USD" },
    });
    const refundWrites = stripe.writes().filter((write) => write.path === "/v1/refunds");
    expect(refundWrites.map((write) => [write.idempotencyKey, write.replayed])).toEqual([
      [idempotencyKeyFor("run_compose", "toolu_refund"), false],
    ]);
    expect(stripe.refunds({ charge: "ch_KAhp_0922b" })).toHaveLength(1);
    const output = ofType(events, "tool.output").find(
      (event) => event.toolCallId === "toolu_refund",
    );
    expect(output).toMatchObject({
      isError: false,
      execution: {
        upstreamTool: expect.stringContaining("/v1/refunds"),
        idempotencyKey: idempotencyKeyFor("run_compose", "toolu_refund"),
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.finished",
      status: "completed",
      reply: "Refunded $490.00 for the duplicate charge.",
    });
    expect(strayTraffic(mock.requests)).toEqual([]);
    const wire = JSON.stringify(events) + JSON.stringify(mock.requests);
    for (const credential of FAKE_CREDENTIAL_VALUES) expect(wire).not.toContain(credential);
  });
});
