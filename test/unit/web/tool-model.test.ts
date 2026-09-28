// Tool rows, approval facts and the assistant message layout
// (web/src/lib/tool-model.ts, lib/labels.ts, lib/present.ts).

import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";
import type { ApprovalView, ChatUIMessage, ToolCallView } from "../../../src/contracts/api.js";
import type { ApprovalDescriptor, ToolMetadata } from "../../../src/contracts/events.js";
import {
  isHighRiskClass,
  isSettledStatus,
  TOOL_ROW_STATUS_LABELS,
  toolRowStatusFromLog,
} from "../../../web/src/lib/labels.js";
import { presentValue } from "../../../web/src/lib/present.js";
import {
  approvalFactRows,
  factKind,
  humanizeToolName,
  isLongText,
  layoutAssistantParts,
  mergeToolRow,
  READ_GROUP_MIN,
  readApprovalFacts,
  readToolMetadata,
  sourceLabels,
  toolRowFromPart,
  toolRowFromView,
} from "../../../web/src/lib/tool-model.js";

const READ: ToolMetadata = {
  integration: "stripe",
  connectionKind: "api",
  operation: "stripe.charges.list",
  actionClass: "read",
};
const REFUND: ToolMetadata = {
  integration: "stripe",
  connectionKind: "api",
  operation: "stripe.refunds.create",
  actionClass: "financial",
};

const DESCRIPTOR: ApprovalDescriptor = {
  actionClass: "financial",
  integration: "stripe",
  connectionKind: "api",
  operation: "stripe.refunds.create",
  title: "Refund charge in Stripe",
  consequence: "Refund $49.00 to Harbor & Pine Outfitters",
  facts: [
    { label: "Amount", value: "$49.00 USD" },
    { label: "Charge", value: "ch_2" },
  ],
  amount: { amountMinor: 4900, currency: "USD" },
  recordIds: ["ch_2", "in_7"],
  recipients: ["dana@harborpine.test"],
  expiresAt: "2026-09-28T10:15:00Z",
};

type PartState = DynamicToolUIPart["state"];

function part(
  toolCallId: string,
  state: PartState,
  metadata: ToolMetadata | null = READ,
  extra: Partial<Record<string, unknown>> = {},
): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: `mcp__stripe__${toolCallId}`,
    title: `Title ${toolCallId}`,
    ...(metadata ? { toolMetadata: metadata } : {}),
    state,
    input: state === "input-streaming" ? undefined : { id: toolCallId },
    ...extra,
  } as DynamicToolUIPart;
}

describe("reading stream payloads", () => {
  it("accepts well-formed tool metadata only", () => {
    expect(readToolMetadata(READ)).toEqual(READ);
    expect(readToolMetadata({ ...READ, integration: "salesforce" })).toBeNull();
    expect(readToolMetadata({ ...READ, operation: "charges.list" })).toBeNull();
    expect(readToolMetadata("nope")).toBeNull();
  });

  it("reads approval descriptors and tolerates partial ones", () => {
    const facts = readApprovalFacts(DESCRIPTOR);
    expect(facts.consequence).toBe(DESCRIPTOR.consequence);
    expect(facts.actionClass).toBe("financial");
    expect(facts.expiresAt).toBe(DESCRIPTOR.expiresAt);
    const partial = readApprovalFacts({ facts: [{ label: "A" }, "x"] }, "Reason from the request");
    expect(partial).toMatchObject({
      consequence: "Reason from the request",
      facts: [],
      actionClass: null,
    });
    expect(readApprovalFacts(undefined).consequence).toBe("This action needs your approval.");
  });

  it("adds recipients and record ids that no fact shows", () => {
    expect(approvalFactRows(readApprovalFacts(DESCRIPTOR))).toEqual([
      { label: "Amount", value: "$49.00 USD" },
      { label: "Charge", value: "ch_2" },
      { label: "Recipient", value: "dana@harborpine.test" },
      { label: "Record", value: "in_7" },
    ]);
  });
});

describe("toolRowFromPart", () => {
  it.each<[PartState, boolean, string]>([
    ["input-streaming", false, "preparing"],
    ["input-available", false, "running"],
    ["input-available", true, "stopped"],
    ["output-available", false, "succeeded"],
    ["output-error", false, "failed"],
  ])("maps %s (run settled: %s) to %s", (state, settled, status) => {
    const extra =
      state === "output-available"
        ? { output: { ok: true } }
        : state === "output-error"
          ? { errorText: "402" }
          : {};
    expect(toolRowFromPart(part("a", state, READ, extra), settled).status).toBe(status);
  });

  it("carries metadata, the approval and outputs", () => {
    const row = toolRowFromPart(
      part("refund", "approval-requested", REFUND, {
        approval: { id: "apr_1", descriptor: DESCRIPTOR },
      }),
      false,
    );
    expect(row).toMatchObject({
      status: "awaiting_approval",
      integration: "stripe",
      integrationLabel: "Stripe",
      kind: "api",
      actionClass: "financial",
      approval: { id: "apr_1", state: "requested" },
    });
    expect(row.approval?.facts.consequence).toBe(DESCRIPTOR.consequence);
  });

  it("tells a denial from a policy block", () => {
    const denied = part("r", "output-denied", REFUND, {
      approval: { id: "a", approved: false, reason: "Not yet" },
    });
    expect(toolRowFromPart(denied, true)).toMatchObject({
      status: "denied",
      approval: { state: "denied", reason: "Not yet" },
    });
    const blocked = part("r", "output-denied", REFUND, {
      approval: { id: "a", approved: false, isAutomatic: true },
    });
    expect(toolRowFromPart(blocked, true)).toMatchObject({
      status: "blocked",
      approval: { state: "blocked" },
    });
    const approvedRunning = part("r", "approval-responded", REFUND, {
      approval: { id: "a", approved: true },
    });
    expect(toolRowFromPart(approvedRunning, false)).toMatchObject({
      status: "running",
      approval: { state: "approved" },
    });
  });

  it("closes a request the run ended before anyone decided", () => {
    const pending = part("r", "approval-requested", REFUND, { approval: { id: "a" } });
    expect(toolRowFromPart(pending, true)).toMatchObject({
      status: "stopped",
      approval: { state: "stopped" },
    });
    expect(toolRowFromPart(pending, false).approval?.state).toBe("requested");
  });

  it("falls back to a readable title and handles unknown tools", () => {
    const unknown = {
      ...part("x", "output-error", null, { errorText: "Unknown tool" }),
      title: undefined,
    };
    const row = toolRowFromPart(unknown as DynamicToolUIPart, true);
    expect(row).toMatchObject({
      title: "X",
      kind: null,
      integration: null,
      integrationLabel: null,
    });
    expect(humanizeToolName("mcp__hubspot__hubspot-search-objects")).toBe("Hubspot search objects");
  });
});

function toolCall(overrides: Partial<ToolCallView>): ToolCallView {
  return {
    id: "tc_1",
    toolCallId: "refund",
    runId: "run_1",
    integration: "stripe",
    connectionKind: "api",
    toolName: "mcp__stripe__create_refund",
    upstreamTool: "POST /v1/refunds",
    operation: "stripe.refunds.create",
    actionClass: "financial",
    title: "Refund charge in Stripe",
    status: "succeeded",
    decision: "approved",
    input: { charge: "ch_2" },
    output: { id: "re_1" },
    isError: false,
    error: null,
    httpStatus: 200,
    idempotencyKey: "k",
    approvalId: "apr_1",
    startedAt: "2026-09-28T10:00:00Z",
    finishedAt: "2026-09-28T10:00:01Z",
    durationMs: 930,
    ...overrides,
  };
}

function approvalView(status: ApprovalView["status"]): ApprovalView {
  return {
    id: "apr_1",
    runId: "run_1",
    conversationId: "c",
    toolCallId: "refund",
    integration: "stripe",
    actionClass: "financial",
    operation: "stripe.refunds.create",
    consequence: DESCRIPTOR.consequence,
    descriptor: DESCRIPTOR,
    status,
    decidedBy: status === "pending" ? null : "user",
    reason: status === "denied" ? "Wrong charge" : null,
    requestedAt: "2026-09-28T10:00:00Z",
    decidedAt: null,
    expiresAt: DESCRIPTOR.expiresAt,
  };
}

describe("action-log rows", () => {
  it("maps decisions before statuses", () => {
    expect(toolRowStatusFromLog("denied", "policy_denied")).toBe("blocked");
    expect(toolRowStatusFromLog("failed", "rejected")).toBe("rejected");
    expect(toolRowStatusFromLog("denied", "timed_out")).toBe("timed_out");
    expect(toolRowStatusFromLog("denied", "stopped")).toBe("stopped");
    expect(toolRowStatusFromLog("interrupted", "auto")).toBe("stopped");
    expect(toolRowStatusFromLog("running", "auto")).toBe("running");
    expect(toolRowStatusFromLog("succeeded", "approved")).toBe("succeeded");
  });

  it("builds read-only rows with their approval", () => {
    const row = toolRowFromView(toolCall({}), [approvalView("approved")]);
    expect(row).toMatchObject({
      status: "succeeded",
      durationMs: 930,
      approval: { state: "approved" },
    });
    const failed = toolRowFromView(
      toolCall({
        status: "failed",
        decision: "auto",
        isError: true,
        error: {
          provider: "stripe",
          status: 402,
          code: "card_declined",
          message: "Your card was declined.",
        },
      }),
    );
    expect(failed).toMatchObject({
      status: "failed",
      errorText: "Your card was declined.",
      approval: null,
    });
    const denied = toolRowFromView(
      toolCall({ status: "denied", decision: "denied", output: null }),
      [approvalView("denied")],
    );
    expect(denied.approval).toMatchObject({ state: "denied", reason: "Wrong charge" });
  });

  it("names how an unapproved call ended", () => {
    const outcome = (view: ToolCallView, approval: ApprovalView) =>
      toolRowFromView(view, [approval]).approval?.state;
    const denied = approvalView("denied");
    expect(
      outcome(toolCall({ status: "denied", decision: "stopped" }), {
        ...denied,
        decidedBy: "stop",
      }),
    ).toBe("stopped");
    expect(
      outcome(toolCall({ status: "denied", decision: "timed_out" }), {
        ...denied,
        decidedBy: "timeout",
      }),
    ).toBe("timed_out");
    expect(
      outcome(toolCall({ status: "interrupted", decision: "stopped" }), approvalView("cancelled")),
    ).toBe("stopped");
    expect(
      outcome(toolCall({ status: "denied", decision: "timed_out" }), approvalView("expired")),
    ).toBe("timed_out");
    expect(outcome(toolCall({ status: "denied", decision: "policy_denied" }), denied)).toBe(
      "blocked",
    );
    expect(outcome(toolCall({ status: "denied", decision: "denied" }), denied)).toBe("denied");
  });

  it("enriches live rows with the log's duration and exact decision", () => {
    const live = toolRowFromPart(
      part("refund", "output-denied", REFUND, { approval: { id: "a", approved: false } }),
      true,
    );
    const merged = mergeToolRow(
      live,
      toolCall({ status: "denied", decision: "timed_out", durationMs: null }),
    );
    expect(merged.status).toBe("timed_out");
    expect(merged.approval?.state).toBe("timed_out");
    const waiting = toolRowFromPart(
      part("refund", "approval-requested", REFUND, { approval: { id: "a" } }),
      false,
    );
    const stale = toolCall({ status: "denied", decision: "policy_denied", durationMs: 139_000 });
    expect(mergeToolRow(waiting, stale)).toBe(waiting);
    const running = toolRowFromPart(part("refund", "input-available", REFUND), false);
    expect(
      mergeToolRow(running, toolCall({ status: "running", decision: "auto", durationMs: null }))
        .status,
    ).toBe("running");
    expect(mergeToolRow(running, undefined)).toBe(running);
  });

  it("knows which statuses are settled and which classes are high risk", () => {
    expect(isSettledStatus("running")).toBe(false);
    expect(isSettledStatus("awaiting_approval")).toBe(false);
    expect(isSettledStatus("blocked")).toBe(true);
    expect(TOOL_ROW_STATUS_LABELS.blocked.label).toBe("Blocked by policy");
    expect(isHighRiskClass("financial")).toBe(true);
    expect(isHighRiskClass("destructive")).toBe(true);
    expect(isHighRiskClass("outbound")).toBe(false);
  });
});

describe("layoutAssistantParts", () => {
  const text = (value: string) => ({ type: "text", text: value, state: "done" }) as const;
  const step = { type: "step-start" } as const;

  it(`groups ${READ_GROUP_MIN} or more consecutive reads across step boundaries`, () => {
    const parts: ChatUIMessage["parts"] = [
      step,
      text("Checking."),
      part("a", "output-available", READ, { output: 1 }),
      step,
      part(
        "b",
        "output-available",
        {
          ...READ,
          integration: "hubspot",
          connectionKind: "mcp",
          operation: "hubspot.objects.search",
        },
        { output: 1 },
      ),
      part("c", "input-available", READ),
      text("Found it."),
      part("d", "output-available", READ, { output: 1 }),
    ];
    const blocks = layoutAssistantParts("m1", parts);
    expect(blocks.map((block) => block.kind)).toEqual(["part", "reads", "part", "tool"]);
    const group = blocks[1];
    expect(group?.kind === "reads" ? group.parts.map((item) => item.toolCallId) : []).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps two reads, writes and reads awaiting approval as rows", () => {
    const parts: ChatUIMessage["parts"] = [
      part("a", "output-available", READ, { output: 1 }),
      part("b", "output-available", READ, { output: 1 }),
      part("w", "approval-requested", REFUND, { approval: { id: "x" } }),
      part("r1", "output-available", READ, { output: 1 }),
      part("r2", "approval-requested", READ, { approval: { id: "y" } }),
      part("r3", "output-available", READ, { output: 1 }),
    ];
    expect(layoutAssistantParts("m", parts).map((block) => block.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
    ]);
  });

  it("hides empty text, empty reasoning and data parts shown elsewhere", () => {
    const parts: ChatUIMessage["parts"] = [
      text("  "),
      { type: "reasoning", text: "", state: "done" },
      {
        type: "data-usage",
        data: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          numTurns: 1,
          modelRequests: 1,
          durationMs: 1,
          durationApiMs: 1,
        },
      },
      {
        type: "data-notice",
        data: {
          level: "warning",
          code: "connection_unavailable",
          integration: "quickbooks",
          message: "Not configured.",
        },
      },
    ];
    const blocks = layoutAssistantParts("m", parts);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind === "part" ? blocks[0].part.type : null).toBe("data-notice");
  });

  it("lists the systems of a group once each", () => {
    const rows = ["a", "b", "c"].map((id, index) =>
      toolRowFromPart(
        part(
          id,
          "output-available",
          index === 1
            ? {
                ...READ,
                integration: "hubspot",
                connectionKind: "mcp",
                operation: "hubspot.objects.search",
              }
            : READ,
          { output: 1 },
        ),
        false,
      ),
    );
    expect(sourceLabels(rows)).toEqual(["Stripe", "HubSpot"]);
  });
});

describe("presentValue", () => {
  it("pretty-prints JSON and unwraps MCP text content", () => {
    expect(presentValue({ ok: true })).toEqual({ language: "json", code: '{\n  "ok": true\n}' });
    expect(presentValue('{"a":1}')).toEqual({ language: "json", code: '{\n  "a": 1\n}' });
    expect(presentValue("plain words")).toEqual({ language: "text", code: "plain words" });
    expect(presentValue({ content: [{ type: "text", text: '{"total":1}' }] })).toEqual({
      language: "json",
      code: '{\n  "total": 1\n}',
    });
    expect(
      presentValue({
        content: [
          { type: "text", text: '{"a":1}' },
          { type: "text", text: "[2]" },
        ],
      })?.language,
    ).toBe("json");
    expect(
      presentValue({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toEqual({
      language: "text",
      code: "one\n\ntwo",
    });
    expect(presentValue({ content: [{ type: "image", data: "…" }] })?.language).toBe("json");
    expect(presentValue(undefined)).toBeNull();
    expect(presentValue("")).toBeNull();
  });
});

describe("approval card fact rows", () => {
  it("marks problems, message bodies and stored metadata", () => {
    expect(factKind("Check")).toBe("warning");
    expect(factKind("Mismatch")).toBe("warning");
    expect(factKind("May already be applied")).toBe("warning");
    expect(factKind("Body")).toBe("text");
    expect(factKind("Message")).toBe("text");
    expect(factKind("Stored on the refund")).toBe("muted");
    expect(factKind("Amount")).toBe("plain");
  });

  it("folds a long message body behind Show all", () => {
    expect(isLongText("Hi Dana,\n\nThanks.\n\nMaya")).toBe(false);
    expect(isLongText(Array.from({ length: 12 }, (_, index) => `Line ${index}`).join("\n"))).toBe(
      true,
    );
    expect(isLongText("x".repeat(700))).toBe(true);
  });
});
