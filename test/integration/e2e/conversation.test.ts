/**
 * Full stack, a multi-turn conversation (docs/ARCHITECTURE.md §5, §11): J1
 * then J2 in one conversation over the HTTP API. The second turn resumes the
 * first turn's Agent SDK session, so the model's first request of turn two
 * must carry turn one's history (the prompt, the tool results and the
 * reply), checked at the scripted model. The database holds one conversation
 * with both runs and all four messages in order.
 * Fails, never skips, without the native Claude CLI.
 */
import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../../../src/contracts/api.js";
import { expectedIdempotencyKey, HARBOR_PINE } from "../../scenarios/facts.js";
import { J1_BILLING_INQUIRY, J2_REFUND_DUPLICATE } from "../../scenarios/index.js";
import { runConversationOverHttp } from "../../scenarios/run-over-http.js";
import { promptCount } from "../../scenarios/script.js";
import { startHarness } from "../../support/harness.js";
import type { MessagesBody } from "../../support/mock-anthropic.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";
import { agentRequests, messageTexts, readRunRows } from "./support.js";

describe("full stack: a conversation resumes its session", () => {
  it("J1 then J2: turn two sees turn one's history, and both runs are recorded", {
    timeout: 180_000,
  }, async () => {
    requireNativeSdkBinary();
    const turns = [J1_BILLING_INQUIRY, J2_REFUND_DUPLICATE];
    const harness = await startHarness({ server: "in-process", model: turns });
    try {
      const played = await runConversationOverHttp(harness, turns);
      expect(played.problems, harness.serverLog().slice(-4_000)).toEqual([]);
      const [first, second] = played.turns;
      if (first?.runId == null || second?.runId == null) throw new Error("missing run ids");

      // History replay, seen by the model: the first request of turn two holds
      // turn one's prompt, a tool result from it and its final reply.
      const requests = agentRequests(harness.model);
      const turnTwo = requests.filter((body) => promptCount(body as MessagesBody) === 2);
      const opening = turnTwo[0];
      if (opening === undefined) throw new Error("no request in turn two");
      const texts = messageTexts(opening).join("\n");
      expect(texts).toContain(J1_BILLING_INQUIRY.prompt);
      expect(texts).toContain(J2_REFUND_DUPLICATE.prompt);
      expect(texts).toContain("I replied to Dana");
      expect(JSON.stringify(opening.messages)).toContain(HARBOR_PINE.duplicateCharge);
      // Turn one's requests never saw turn two.
      for (const body of requests.filter((entry) => promptCount(entry as MessagesBody) === 1)) {
        expect(messageTexts(body).join("\n")).not.toContain(J2_REFUND_DUPLICATE.prompt);
      }

      // The database: one conversation, two completed runs, four messages in order.
      const firstRows = readRunRows(harness.stateDir, first.runId);
      const secondRows = readRunRows(harness.stateDir, second.runId);
      expect(firstRows.run.conversation_id).toBe(played.conversationId);
      expect(secondRows.run.conversation_id).toBe(played.conversationId);
      expect([firstRows.run.status, secondRows.run.status]).toEqual(["completed", "completed"]);
      expect(secondRows.conversation.sdk_session_id).not.toBeNull();
      expect(secondRows.messages.map((message) => [message.role, message.run_id])).toEqual([
        ["user", first.runId],
        ["assistant", first.runId],
        ["user", second.runId],
        ["assistant", second.runId],
      ]);
      // Turn two's refund carries its own run's key (tool_use id of turn two).
      expect(secondRows.call("j2_refund")).toMatchObject({
        decision: "approved",
        idempotency_key: expectedIdempotencyKey(second.runId, "toolu_j2_refund_t2"),
      });

      // The app shows the whole conversation after a reload.
      const detail = await harness.api?.expect("GET /api/conversations/:conversationId", {
        params: { conversationId: played.conversationId },
      });
      const messages: readonly ChatUIMessage[] = detail?.messages ?? [];
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(detail?.conversation.status).toBe("idle");
    } finally {
      await harness.close();
    }
  });
});
