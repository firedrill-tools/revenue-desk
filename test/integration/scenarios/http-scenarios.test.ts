/**
 * Every scripted scenario played over the HTTP API (session, CSRF, the UI
 * message stream, approvals decided while the stream is open) against the
 * harness's in-process server: the agent core, the production integrations,
 * the real Claude Agent SDK against the scripted model, and every fake.
 * Fails, never skips, without the native CLI.
 */
import { describe, expect, it } from "vitest";
import { ALL_SCENARIOS, CONVERSATIONS } from "../../scenarios/index.js";
import { runConversationOverHttp, runScenarioOverHttp } from "../../scenarios/run-over-http.js";
import { startHarness } from "../../support/harness.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";

describe("scripted scenarios over the HTTP API", () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, { timeout: 120_000 }, async () => {
      requireNativeSdkBinary();
      const harness = await startHarness({
        server: "in-process",
        model: scenario,
        hubspot: scenario.hubspot ?? "stdio",
        ...(scenario.arrange === undefined
          ? {}
          : { arrange: (fakes) => scenario.arrange?.(fakes) }),
      });
      try {
        const run = await runScenarioOverHttp(harness, scenario);
        expect(run.problems, harness.serverLog().slice(-4_000)).toEqual([]);
      } finally {
        await harness.close();
      }
    });
  }

  for (const conversation of CONVERSATIONS) {
    it(`${conversation.id}: ${conversation.title}`, { timeout: 180_000 }, async () => {
      requireNativeSdkBinary();
      const harness = await startHarness({ server: "in-process", model: conversation.turns });
      try {
        const run = await runConversationOverHttp(harness, conversation.turns);
        expect(run.problems, harness.serverLog().slice(-4_000)).toEqual([]);
        expect(run.turns).toHaveLength(conversation.turns.length);
      } finally {
        await harness.close();
      }
    });
  }
});
