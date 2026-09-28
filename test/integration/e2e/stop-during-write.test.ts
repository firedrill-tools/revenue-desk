/**
 * Full stack: Stop while an approved refund is at the provider. A refund
 * POST that has reached Stripe will be applied whatever the app does next,
 * so Stop must not cancel it and the action log must record what Stripe
 * answered, with its idempotency key: exactly one refund request, a
 * succeeded row, and a run that ends cancelled. Played over the HTTP API
 * against the in-process server with the real Claude Agent SDK and the
 * scripted model; Stripe's fake takes two seconds to answer the refund.
 * Fails, never skips, without the native Claude CLI.
 */
import { describe, expect, it } from "vitest";
import { expectedIdempotencyKey, HARBOR_PINE } from "../../scenarios/facts.js";
import { J2_REFUND_DUPLICATE } from "../../scenarios/index.js";
import { logicalCallId } from "../../scenarios/script.js";
import { startHarness } from "../../support/harness.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";
import { readRunRows } from "./support.js";

const TIMEOUT = 120_000;
const REFUND_TAKES_MS = 2_000;

describe("full stack: Stop while an approved refund is at Stripe", () => {
  it("lets the refund finish and records it once, succeeded, with its idempotency key", {
    timeout: TIMEOUT,
  }, async () => {
    requireNativeSdkBinary();
    const harness = await startHarness({
      server: "in-process",
      model: J2_REFUND_DUPLICATE,
      hubspot: "stdio",
      arrange: (fakes) => {
        fakes.stripe.http.injectFault({
          name: "slow-refund",
          method: "POST",
          path: "/v1/refunds",
          delayMs: REFUND_TAKES_MS,
          respond: "pass",
        });
      },
    });
    try {
      const api = harness.api;
      if (api === null) throw new Error("The harness has no server");
      await api.session();
      const { conversation } = await api.expect("POST /api/conversations", {
        body: { title: J2_REFUND_DUPLICATE.title },
      });
      let runId: string | null = null;
      const actions: Promise<unknown>[] = [];
      let stoppedAt: number | null = null;
      const chunks = await api.chat(conversation.id, J2_REFUND_DUPLICATE.prompt, {
        onChunk: (chunk) => {
          if (chunk.type === "start") {
            runId = (chunk.messageMetadata as { runId?: string } | undefined)?.runId ?? null;
          }
          if (chunk.type === "tool-approval-request" && chunk.isAutomatic !== true) {
            actions.push(api.decide(String(chunk.approvalId), true));
          }
          // The refund started executing: Stop now, while Stripe is still answering.
          const data = chunk.data as { toolCallId?: string } | undefined;
          if (
            chunk.type === "data-progress" &&
            stoppedAt === null &&
            logicalCallId(String(data?.toolCallId)) === "j2_refund" &&
            runId !== null
          ) {
            stoppedAt = Date.now();
            const id = runId;
            actions.push(api.call("POST /api/runs/:runId/stop", { params: { runId: id } }));
          }
        },
      });
      await Promise.all(actions);
      expect(stoppedAt, "the refund never reported that it started").not.toBeNull();
      if (runId === null) throw new Error("The stream carried no runId");

      // Stripe received exactly one refund request and applied it.
      expect(harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")).toHaveLength(1);
      expect(
        harness.fakes.stripe.refunds({ charge: HARBOR_PINE.duplicateCharge }).map((r) => r.amount),
      ).toEqual([HARBOR_PINE.chargeAmountMinor]);

      const rows = readRunRows(harness.stateDir, runId);
      expect(rows.run).toMatchObject({ status: "cancelled", stop_reason: "user" });
      const refund = rows.call("j2_refund");
      expect(refund).toMatchObject({
        decision: "approved",
        status: "succeeded",
        is_error: 0,
        idempotency_key: expectedIdempotencyKey(runId, refund.tool_use_id),
      });
      expect(refund.output_json).toContain("re_");
      // The stream showed the refund's real outcome, not a cancellation.
      const outputs = chunks.filter(
        (chunk) =>
          (chunk.type === "tool-output-available" || chunk.type === "tool-output-error") &&
          logicalCallId(String(chunk.toolCallId)) === "j2_refund",
      );
      expect(outputs.map((chunk) => chunk.type)).toEqual(["tool-output-available"]);
      expect(chunks.at(-1)?.type).toBe("abort");
    } finally {
      await harness.close();
    }
  });
});
