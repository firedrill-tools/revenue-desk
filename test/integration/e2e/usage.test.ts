/**
 * Full stack, usage of a resumed session (docs/ARCHITECTURE.md §8): the SDK
 * reports running totals for the whole session on resume, so each run row
 * must hold only its own requests, and the conversation's totals must equal
 * the sum of its runs, never counting a request twice. Two turns over HTTP
 * against the scripted model, whose replies each report 12 input and 6
 * output tokens; the database is read with plain SQL.
 * Fails, never skips, without the native Claude CLI.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { databasePath } from "../../../src/db/client.js";
import { runConversationOverHttp } from "../../scenarios/run-over-http.js";
import { type Scenario, text } from "../../scenarios/script.js";
import { stripe } from "../../scenarios/tools.js";
import { startHarness } from "../../support/harness.js";
import type { MockAnthropic } from "../../support/mock-anthropic.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";

/** Two model requests: a Stripe read, then the answer. */
const FIRST_TURN: Scenario = {
  id: "usage-first-turn",
  job: "failure",
  title: "Usage, first turn",
  prompt: "What did Harbor & Pine pay in September?",
  steps: [
    () => [text("Checking Stripe."), stripe.listCharges("usage_charges", { limit: 5 })],
    () => [text("They paid $490.00 twice on September 22.")],
  ],
  approvals: {},
  expected: { status: "completed" },
};

/** One model request, in the resumed session. */
const SECOND_TURN: Scenario = {
  id: "usage-second-turn",
  job: "failure",
  title: "Usage, second turn",
  prompt: "And what should we do about it?",
  steps: [() => [text("Refund the second charge.")]],
  approvals: {},
  expected: { status: "completed" },
};

type RunUsageRow = {
  readonly id: string;
  readonly sdk_session_id: string | null;
  readonly cost_usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly model_requests: number;
};

/** Messages API requests (not token counts) the scripted model has answered. */
function messageRequests(model: MockAnthropic | null): number {
  if (model === null) throw new Error("scripted model expected");
  return model.requests.filter(
    (request) => request.method === "POST" && /\/v1\/messages(\?|$)/.test(request.target),
  ).length;
}

describe("full stack: usage over two turns of one conversation", () => {
  it("does not count the first turn's requests again in the second", {
    timeout: 180_000,
  }, async () => {
    requireNativeSdkBinary();
    const turns = [FIRST_TURN, SECOND_TURN];
    const harness = await startHarness({ server: "in-process", model: turns });
    try {
      const requestsBefore = messageRequests(harness.model);
      const played = await runConversationOverHttp(harness, turns);
      expect(played.problems, harness.serverLog().slice(-4_000)).toEqual([]);
      const requests = messageRequests(harness.model) - requestsBefore;

      const sqlite = new Database(databasePath(harness.stateDir), { readonly: true });
      let runs: RunUsageRow[];
      let conversation: {
        total_cost_usd: number;
        input_tokens: number;
        output_tokens: number;
        sdk_session_id: string | null;
      };
      try {
        runs = sqlite
          .prepare(
            "SELECT id, sdk_session_id, cost_usd, input_tokens, output_tokens, model_requests FROM runs WHERE conversation_id = ? ORDER BY started_at",
          )
          .all(played.conversationId) as RunUsageRow[];
        conversation = sqlite
          .prepare(
            "SELECT total_cost_usd, input_tokens, output_tokens, sdk_session_id FROM conversations WHERE id = ?",
          )
          .get(played.conversationId) as typeof conversation;
      } finally {
        sqlite.close();
      }
      expect(runs).toHaveLength(2);
      const [first, second] = runs as [RunUsageRow, RunUsageRow];

      // One SDK session, resumed by the second turn.
      expect(first.sdk_session_id).not.toBeNull();
      expect(second.sdk_session_id).toBe(first.sdk_session_id);
      expect(conversation.sdk_session_id).toBe(first.sdk_session_id);

      // Every reply reports 12 input and 6 output tokens: each run holds its own requests only.
      expect(first.model_requests).toBe(2);
      expect(second.model_requests).toBe(1);
      expect(first.input_tokens + second.input_tokens).toBe(12 * requests);
      expect(first.output_tokens + second.output_tokens).toBe(6 * requests);
      expect(second.input_tokens).toBe(12 * second.model_requests);
      expect(second.output_tokens).toBe(6 * second.model_requests);
      expect(first.input_tokens).toBe(12 * (requests - second.model_requests));
      // Every request costs the same, so the second run costs a third of the session.
      expect(first.cost_usd).toBeGreaterThan(0);
      expect(first.cost_usd).toBeCloseTo(2 * second.cost_usd, 9);

      // The conversation's totals are the sum of its runs.
      expect(conversation.input_tokens).toBe(first.input_tokens + second.input_tokens);
      expect(conversation.output_tokens).toBe(first.output_tokens + second.output_tokens);
      expect(conversation.total_cost_usd).toBeCloseTo(first.cost_usd + second.cost_usd, 9);

      // The baseline came from the database, not from files beside the SDK's transcripts.
      expect(existsSync(join(harness.stateDir, "claude", "revenue-desk", "usage"))).toBe(false);
    } finally {
      await harness.close();
    }
  });
});
