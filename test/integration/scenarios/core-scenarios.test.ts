/**
 * Every scripted scenario (J1–J5, decision variants and failures) played end
 * to end through the agent core, the production integrations, the real
 * Claude Agent SDK against the scripted model, and the local fakes. A
 * scenario passes when it played exactly as written (no drift between the
 * scripts and the offered tool schemas), ended as expected, and left the
 * fakes in the expected state. Fails, never skips, without the native CLI.
 */
import { describe, expect, it } from "vitest";
import { ALL_SCENARIOS } from "../../scenarios/index.js";
import { runScenarioInCore } from "../../scenarios/run-in-core.js";

describe("scripted scenarios through the agent core", () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, { timeout: 120_000 }, async () => {
      const run = await runScenarioInCore(scenario);
      try {
        expect(run.problems, run.stderr.slice(-20).join("\n")).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }
});
