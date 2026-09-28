/**
 * Full stack, jobs and decisions (docs/ARCHITECTURE.md §11): the real HTTP
 * server (startServer, in process) with the production integrations and the
 * agent core, the real Claude Agent SDK subprocess against the scripted
 * model, and every local fake. Each run is played over the HTTP API as the
 * chat screen plays it, then checked in three places: the fakes (what really
 * happened in each system), the UI stream, and the database rows (runs,
 * tool_calls with connection_kind and decision, approvals), which must match.
 * Fails, never skips, without the native Claude CLI.
 */
import { describe, expect, it } from "vitest";
import { STOPPED_BEFORE_RUN_REASON } from "../../../src/agent/sdk-mapper.js";
import { expectedIdempotencyKey } from "../../scenarios/facts.js";
import {
  J1_BILLING_INQUIRY,
  J2_REFUND_DENIED,
  J2_REFUND_DUPLICATE,
  J2_STOPPED_AT_APPROVAL,
  J3_COLLECTIONS,
} from "../../scenarios/index.js";
import { runScenarioOverHttp } from "../../scenarios/run-over-http.js";
import type { Scenario } from "../../scenarios/script.js";
import type { StreamChunk } from "../../support/api-client.js";
import { type Harness, type HarnessOptions, startHarness } from "../../support/harness.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";
import { agentRequests, logicalIds, readRunRows } from "./support.js";

const TIMEOUT = 120_000;

async function withHarness(
  scenario: Scenario,
  options: Pick<HarnessOptions, "env">,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  requireNativeSdkBinary();
  const harness = await startHarness({
    server: "in-process",
    model: scenario,
    hubspot: scenario.hubspot ?? "stdio",
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(scenario.arrange === undefined ? {} : { arrange: (fakes) => scenario.arrange?.(fakes) }),
  });
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

async function play(harness: Harness, scenario: Scenario) {
  const played = await runScenarioOverHttp(harness, scenario);
  expect(played.problems, harness.serverLog().slice(-4_000)).toEqual([]);
  if (played.runId === null) throw new Error("The stream carried no runId");
  return { played, rows: readRunRows(harness.stateDir, played.runId), runId: played.runId };
}

function chunkTypes(chunks: readonly StreamChunk[]): string[] {
  return chunks.map((chunk) => chunk.type);
}

describe("full stack: the jobs, with the database checked against what happened", () => {
  it("J1: reads across Composio, MCP and API; the draft is automatic, sending asks and is approved", {
    timeout: TIMEOUT,
  }, async () => {
    await withHarness(J1_BILLING_INQUIRY, {}, async (harness) => {
      const { rows } = await play(harness, J1_BILLING_INQUIRY);

      expect(rows.run).toMatchObject({
        status: "completed",
        source: "ui",
        mode: "interactive",
        stop_reason: null,
        error_code: null,
      });
      expect(rows.run.finished_at).not.toBeNull();
      expect(rows.conversation.status).toBe("idle");
      expect(logicalIds(rows.toolCalls)).toEqual(
        [
          "j1_inbox",
          "j1_stripe_customer",
          "j1_qbo_customer",
          "j1_contact",
          "j1_charges",
          "j1_invoices",
          "j1_draft",
          "j1_send",
        ].sort(),
      );
      // Reads across all three connection kinds, each allowed by policy.
      expect(rows.call("j1_inbox")).toMatchObject({
        integration: "gmail",
        connection_kind: "composio",
        upstream_tool: "GMAIL_FETCH_EMAILS",
      });
      expect(rows.call("j1_contact")).toMatchObject({
        integration: "hubspot",
        connection_kind: "mcp",
        upstream_tool: "hubspot-search-objects",
      });
      expect(rows.call("j1_charges")).toMatchObject({
        integration: "stripe",
        connection_kind: "api",
        upstream_tool: "GET /v1/charges",
      });
      expect(rows.call("j1_invoices")).toMatchObject({
        integration: "quickbooks",
        connection_kind: "api",
      });
      for (const id of [
        "j1_inbox",
        "j1_stripe_customer",
        "j1_qbo_customer",
        "j1_contact",
        "j1_charges",
        "j1_invoices",
      ]) {
        expect(rows.call(id), id).toMatchObject({
          action_class: "read",
          decision: "auto",
          status: "succeeded",
          is_error: 0,
          approval_id: null,
        });
      }
      // Creating the draft is an internal write: automatic, never asked.
      expect(rows.call("j1_draft")).toMatchObject({
        integration: "gmail",
        connection_kind: "composio",
        operation: "gmail.drafts.create",
        action_class: "internal_write",
        decision: "auto",
        status: "succeeded",
        approval_id: null,
      });
      // Sending is outbound: it asked, and the user approved it.
      const send = rows.call("j1_send");
      expect(send).toMatchObject({
        integration: "gmail",
        connection_kind: "composio",
        operation: "gmail.drafts.send",
        action_class: "outbound",
        decision: "approved",
        status: "succeeded",
      });
      expect(rows.approvals).toHaveLength(1);
      expect(rows.approval("j1_send")).toMatchObject({
        id: send.approval_id,
        integration: "gmail",
        action_class: "outbound",
        status: "approved",
        decided_by: "user",
      });
      expect(harness.fakes.composio.gmail.outbox).toHaveLength(1);
    });
  });

  it("J2 approved: one Stripe refund with the run's Idempotency-Key, a HubSpot note and a Slack post", {
    timeout: TIMEOUT,
  }, async () => {
    await withHarness(J2_REFUND_DUPLICATE, {}, async (harness) => {
      const { rows, runId } = await play(harness, J2_REFUND_DUPLICATE);
      const key = expectedIdempotencyKey(runId, "toolu_j2_refund");

      const refundRequests = harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds");
      expect(refundRequests).toHaveLength(1);
      expect(harness.fakes.stripe.writes().map((write) => write.idempotencyKey)).toEqual([key]);

      expect(rows.run.status).toBe("completed");
      const refund = rows.call("j2_refund");
      expect(refund).toMatchObject({
        integration: "stripe",
        connection_kind: "api",
        operation: "stripe.refunds.create",
        action_class: "financial",
        decision: "approved",
        status: "succeeded",
        is_error: 0,
        // A successful API call records no status; failures record the provider's.
        http_status: null,
        idempotency_key: key,
        upstream_tool: "POST /v1/refunds",
      });
      expect(rows.approval("j2_refund")).toMatchObject({
        id: refund.approval_id,
        action_class: "financial",
        operation: "stripe.refunds.create",
        status: "approved",
        decided_by: "user",
      });
      expect(rows.call("j2_note")).toMatchObject({
        integration: "hubspot",
        connection_kind: "mcp",
        upstream_tool: "hubspot-batch-create-objects",
        operation: "hubspot.notes.create",
        action_class: "internal_write",
        decision: "auto",
        status: "succeeded",
      });
      expect(rows.call("j2_post")).toMatchObject({
        integration: "slack",
        connection_kind: "api",
        operation: "slack.chat.post_message",
        action_class: "internal_write",
        decision: "auto",
        status: "succeeded",
      });
      expect(rows.approvals).toHaveLength(1);
      // The refund row's input is what was approved; no key or token was stored.
      expect(JSON.parse(refund.input_json)).toMatchObject({
        charge: "ch_KAhp_0922b",
        amount: 49_000,
      });
    });
  });

  it("J2 denied: no refund; the call and the approval say denied by the user", {
    timeout: TIMEOUT,
  }, async () => {
    await withHarness(J2_REFUND_DENIED, {}, async (harness) => {
      const { rows } = await play(harness, J2_REFUND_DENIED);
      expect(harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")).toHaveLength(0);
      expect(rows.run.status).toBe("completed");
      expect(rows.call("j2_refund")).toMatchObject({
        action_class: "financial",
        decision: "denied",
        status: "denied",
        idempotency_key: null,
      });
      expect(rows.approval("j2_refund")).toMatchObject({
        status: "denied",
        decided_by: "user",
        reason: "Not now.",
      });
      expect(logicalIds(rows.toolCalls)).not.toContain("j2_note");
      expect(logicalIds(rows.toolCalls)).not.toContain("j2_post");
    });
  });

  it("Stop while the refund waits: run and approval cancelled, no refund, no further model request", {
    timeout: TIMEOUT,
  }, async () => {
    await withHarness(J2_STOPPED_AT_APPROVAL, {}, async (harness) => {
      const { played, rows } = await play(harness, J2_STOPPED_AT_APPROVAL);
      expect(harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")).toHaveLength(0);
      // Four model requests led to the refund call; none followed the stop.
      expect(agentRequests(harness.model)).toHaveLength(4);
      expect(chunkTypes(played.chunks).at(-1)).toBe("abort");

      expect(rows.run).toMatchObject({ status: "cancelled", stop_reason: "user" });
      expect(rows.call("j2_refund")).toMatchObject({ decision: "stopped", status: "denied" });
      expect(rows.approval("j2_refund")).toMatchObject({
        status: "cancelled",
        decided_by: "stop",
      });
      expect(rows.conversation.status).toBe("idle");
      // The persisted assistant message has no call left spinning.
      const assistant = rows.messages.find((message) => message.role === "assistant");
      expect(assistant?.parts_json).not.toContain('"state":"input-available"');
      expect(assistant?.parts_json).not.toContain('"state":"approval-requested"');
    });
  });

  it("Stop at J3's invite: the invite is cancelled and the queued HubSpot task is stopped, plainly", {
    timeout: TIMEOUT,
  }, async () => {
    const { verify: _checksForTheApprovedPath, ...stopped } = {
      ...J3_COLLECTIONS,
      id: "j3-stopped-at-invite",
      approvals: { j3_call: "stop" as const },
      expected: { status: "cancelled" as const },
    };
    await withHarness(stopped, {}, async (harness) => {
      const { played, rows } = await play(harness, stopped);
      expect(rows.run).toMatchObject({ status: "cancelled", stop_reason: "user" });
      expect(rows.approval("j3_call")).toMatchObject({ status: "cancelled", decided_by: "stop" });
      expect(rows.call("j3_call")).toMatchObject({ decision: "stopped", status: "denied" });
      // The task was queued behind the invite and never ran: stopped, with a
      // plain reason instead of the Claude CLI's instruction to the model.
      const task = rows.call("j3_task");
      expect(task).toMatchObject({ decision: "stopped", status: "denied", is_error: 0 });
      expect(JSON.parse(task.output_json ?? "null")).toBe(STOPPED_BEFORE_RUN_REASON);
      expect(harness.fakes.hubspot.writes()).toHaveLength(0);
      expect(harness.fakes.composio.calendar.invitations).toHaveLength(0);
      expect(JSON.stringify(played.chunks)).not.toContain("want to proceed");
    });
  });

  it("An approval nobody decides expires: denied as timed out, nothing refunded", {
    timeout: TIMEOUT,
  }, async () => {
    const env = { AGENT_APPROVAL_TIMEOUT_MS: "1000" } as const;
    await withHarness(J2_REFUND_DUPLICATE, { env }, async (harness) => {
      const api = harness.api;
      if (api === null) throw new Error("no server");
      await api.session();
      const { conversation } = await api.expect("POST /api/conversations", { body: {} });
      let approvalRequests = 0;
      const chunks = await api.chat(conversation.id, J2_REFUND_DUPLICATE.prompt, {
        onChunk: (chunk) => {
          if (chunk.type === "tool-approval-request" && chunk.isAutomatic !== true) {
            approvalRequests += 1;
          }
        },
      });
      expect(approvalRequests).toBe(1);
      const response = chunks.find((chunk) => chunk.type === "tool-approval-response");
      expect(response).toMatchObject({ approved: false });
      const runId = (chunks[0]?.messageMetadata as { runId?: string } | undefined)?.runId;
      if (runId === undefined) throw new Error("no runId");

      expect(harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")).toHaveLength(0);
      const rows = readRunRows(harness.stateDir, runId);
      expect(rows.run.status).toBe("completed");
      expect(rows.call("j2_refund")).toMatchObject({ decision: "timed_out", status: "denied" });
      expect(rows.approval("j2_refund")).toMatchObject({
        status: "expired",
        decided_by: "timeout",
      });
      expect(harness.script?.problems ?? []).toEqual([]);
    });
  });

  it("J3: QuickBooks pages to the end, reminders are drafted, the external invite asks and is approved", {
    timeout: TIMEOUT,
  }, async () => {
    await withHarness(J3_COLLECTIONS, {}, async (harness) => {
      const { rows } = await play(harness, J3_COLLECTIONS);
      expect(rows.run.status).toBe("completed");

      // One tool call; the client read every page until an empty one.
      expect(rows.call("j3_overdue")).toMatchObject({
        integration: "quickbooks",
        connection_kind: "api",
        operation: "quickbooks.invoices.query",
        decision: "auto",
        status: "succeeded",
      });
      const invoicePages = harness.fakes.quickbooks.requests.filter(
        (entry) =>
          entry.path.endsWith("/query") &&
          (entry.query.query?.[0] ?? entry.body).includes("FROM Invoice"),
      );
      expect(invoicePages.length).toBeGreaterThanOrEqual(3);

      const drafts = rows.toolCalls.filter((row) => row.operation === "gmail.drafts.create");
      expect(drafts).toHaveLength(3);
      for (const draft of drafts) {
        expect(draft).toMatchObject({
          connection_kind: "composio",
          action_class: "internal_write",
          decision: "auto",
          status: "succeeded",
        });
      }
      const invite = rows.call("j3_call");
      expect(invite).toMatchObject({
        integration: "google_calendar",
        connection_kind: "composio",
        operation: "google_calendar.events.create",
        action_class: "outbound",
        decision: "approved",
        status: "succeeded",
      });
      expect(rows.approvals).toHaveLength(1);
      expect(rows.approval("j3_call")).toMatchObject({
        id: invite.approval_id,
        action_class: "outbound",
        status: "approved",
        decided_by: "user",
      });
      expect(rows.call("j3_task")).toMatchObject({
        integration: "hubspot",
        connection_kind: "mcp",
        operation: "hubspot.tasks.create",
        action_class: "internal_write",
        decision: "auto",
      });
      expect(harness.fakes.composio.gmail.outbox).toHaveLength(0);
    });
  });
});
