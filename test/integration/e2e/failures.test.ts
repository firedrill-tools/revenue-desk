/**
 * Full stack, failures (docs/ARCHITECTURE.md §11): a provider or the model
 * fails, set up on the fakes (or the scripted model) before the run. The run
 * is played over the HTTP API against the in-process server with the real
 * Claude Agent SDK, and the database must record exactly what happened:
 * failed calls with the provider's status and code, unavailable connections
 * in the run's snapshot, a failed run with a sanitised error.
 * Fails, never skips, without the native Claude CLI.
 */
import { describe, expect, it } from "vitest";
import {
  FAIL_COMPOSIO_SESSION,
  FAIL_HUBSPOT_DOWN,
  FAIL_MODEL_529,
  FAIL_QUICKBOOKS_FAULT,
  FAIL_SLACK_NOT_OK,
  FAIL_STRIPE_429,
  J2_INVALID_ARGUMENTS,
  J2_STRIPE_DECLINE,
} from "../../scenarios/index.js";
import { runScenarioOverHttp } from "../../scenarios/run-over-http.js";
import type { Scenario } from "../../scenarios/script.js";
import { FAKE_CREDENTIAL_VALUES } from "../../support/fakes/credentials.js";
import { type Harness, startHarness } from "../../support/harness.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";
import { agentRequests, readRunRows } from "./support.js";

const TIMEOUT = 120_000;

async function playScenario(scenario: Scenario, check: (context: Played) => void | Promise<void>) {
  requireNativeSdkBinary();
  const harness = await startHarness({
    server: "in-process",
    model: scenario,
    hubspot: scenario.hubspot ?? "stdio",
    ...(scenario.arrange === undefined ? {} : { arrange: (fakes) => scenario.arrange?.(fakes) }),
  });
  try {
    const played = await runScenarioOverHttp(harness, scenario);
    expect(played.problems, harness.serverLog().slice(-4_000)).toEqual([]);
    if (played.runId === null) throw new Error("The stream carried no runId");
    await check({
      harness,
      chunks: played.chunks,
      rows: readRunRows(harness.stateDir, played.runId),
      conversationId: played.conversationId,
    });
  } finally {
    await harness.close();
  }
}

type Played = {
  readonly harness: Harness;
  readonly chunks: Awaited<ReturnType<typeof runScenarioOverHttp>>["chunks"];
  readonly rows: ReturnType<typeof readRunRows>;
  readonly conversationId: string;
};

describe("full stack: failures, with the database checked against what happened", () => {
  it("Stripe declines the approved refund (402): one attempt, recorded as a failed call", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(J2_STRIPE_DECLINE, ({ harness, rows }) => {
      expect(harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")).toHaveLength(1);
      expect(rows.run.status).toBe("completed");
      const refund = rows.call("j2_refund");
      expect(refund).toMatchObject({
        integration: "stripe",
        connection_kind: "api",
        action_class: "financial",
        decision: "approved",
        status: "failed",
        is_error: 1,
        http_status: 402,
        error_code: "card_declined",
      });
      // The declined write reached Stripe, so its key is recorded with it.
      expect(refund.idempotency_key).toBe(
        harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")[0]?.headers["idempotency-key"],
      );
      expect(refund.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
      expect(refund.error_message).toMatch(/declined/i);
      expect(rows.approval("j2_refund")).toMatchObject({ status: "approved", decided_by: "user" });
    });
  });

  it("Stripe rate-limits a read (429): the client retries it and the call succeeds", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(FAIL_STRIPE_429, ({ harness, rows }) => {
      expect(
        harness.fakes.stripe.http.requestsTo("GET", "/v1/charges").map((entry) => entry.status),
      ).toEqual([429, 200]);
      expect(rows.call("j5_charges")).toMatchObject({
        integration: "stripe",
        action_class: "read",
        decision: "auto",
        status: "succeeded",
        is_error: 0,
      });
      expect(rows.run.status).toBe("completed");
    });
  });

  it("QuickBooks answers the approved invoice with a Fault: failed with its code, nothing sent", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(FAIL_QUICKBOOKS_FAULT, ({ rows }) => {
      expect(rows.call("j4_invoice")).toMatchObject({
        integration: "quickbooks",
        connection_kind: "api",
        operation: "quickbooks.invoices.create",
        action_class: "financial",
        decision: "approved",
        status: "failed",
        is_error: 1,
        error_code: "6000",
      });
      expect(rows.call("j4_invoice").http_status).toBeGreaterThanOrEqual(400);
      expect(rows.toolCalls.some((row) => row.operation === "quickbooks.invoices.send")).toBe(
        false,
      );
      expect(rows.run.status).toBe("completed");
    });
  });

  it("Slack answers HTTP 200 with ok:false: the post is a failed call, never retried", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(FAIL_SLACK_NOT_OK, ({ harness, rows }) => {
      expect(harness.fakes.slack.http.requestsTo("POST", "/api/chat.postMessage")).toHaveLength(1);
      expect(rows.call("j5_post")).toMatchObject({
        integration: "slack",
        connection_kind: "api",
        operation: "slack.chat.post_message",
        decision: "auto",
        status: "failed",
        is_error: 1,
        error_code: "channel_not_found",
      });
    });
  });

  it("HubSpot's MCP server is down at start: unavailable for the run, no MCP call, a notice", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(FAIL_HUBSPOT_DOWN, ({ chunks, rows }) => {
      expect(rows.connection("hubspot")).toMatchObject({ availability: "unavailable" });
      expect(rows.connection("stripe")).toMatchObject({ availability: "ready" });
      expect(rows.toolCalls.filter((row) => row.connection_kind === "mcp")).toHaveLength(0);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: "data-notice",
          data: expect.objectContaining({ integration: "hubspot", code: "connection_unavailable" }),
        }),
      );
      expect(rows.run.status).toBe("completed");
    });
  });

  it("Composio refuses the session: Gmail and Calendar unavailable, no Composio call", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(FAIL_COMPOSIO_SESSION, ({ rows }) => {
      expect(rows.connection("gmail")).toMatchObject({ availability: "unavailable" });
      expect(rows.connection("google_calendar")).toMatchObject({ availability: "unavailable" });
      expect(rows.toolCalls.filter((row) => row.connection_kind === "composio")).toHaveLength(0);
      expect(rows.toolCalls.map((row) => row.integration)).toEqual(["stripe", "stripe"]);
      expect(rows.run.status).toBe("completed");
    });
  });

  it("An invalid refund is rejected before any approval; only the corrected call asks", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(J2_INVALID_ARGUMENTS, ({ harness, rows }) => {
      expect(rows.call("j2_refund_invalid")).toMatchObject({
        integration: "stripe",
        decision: "rejected",
        status: "failed",
        is_error: 1,
        approval_id: null,
      });
      expect(rows.approvals.map((approval) => approval.tool_use_id)).toEqual(["toolu_j2_refund"]);
      expect(rows.call("j2_refund")).toMatchObject({ decision: "approved", status: "succeeded" });
      expect(harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")).toHaveLength(1);
    });
  });

  it("The model answers 529: the run fails with model_error and the stream ends with an error", {
    timeout: TIMEOUT,
  }, async () => {
    await playScenario(FAIL_MODEL_529, async ({ harness, chunks, rows, conversationId }) => {
      expect(agentRequests(harness.model)).toHaveLength(1);
      expect(rows.run).toMatchObject({ status: "failed", error_code: "model_error" });
      expect(rows.toolCalls).toHaveLength(0);
      expect(rows.conversation.status).toBe("error");

      // The UI's error banner: an error chunk with a plain, sanitised message.
      const error = chunks.find((chunk) => chunk.type === "error");
      expect(error).toBeDefined();
      const errorText = String(error?.errorText ?? "");
      expect(errorText.length).toBeGreaterThan(0);
      for (const credential of FAKE_CREDENTIAL_VALUES) expect(errorText).not.toContain(credential);
      expect(chunks.at(-1)?.type).toBe("error");

      const detail = await harness.api?.expect("GET /api/conversations/:conversationId", {
        params: { conversationId },
      });
      expect(detail?.conversation.status).toBe("error");
      expect(detail?.messages.at(-1)).toMatchObject({
        role: "assistant",
        metadata: expect.objectContaining({ status: "failed" }),
      });
    });
  });
});
