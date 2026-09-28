import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_UNAVAILABLE_REASON,
  createCanUseTool,
  createPreToolUseHook,
  type DecisionContext,
} from "../../../src/agent/decisions.js";
import { ToolCallLedger } from "../../../src/agent/tool-calls.js";
import { createRedactorFor } from "../../../src/config/redact.js";
import type {
  AgentEvent,
  ApprovalGate,
  ApprovalOutcome,
  ApprovalRequest,
} from "../../../src/contracts/events.js";
import {
  DEFAULT_POLICY,
  HEADLESS_ASK_DENIAL,
  type PolicyModes,
} from "../../../src/contracts/integration.js";
import { apiInputSchema } from "../../../src/gateway/api-server.js";
import { profileDescriptors } from "../../../src/gateway/catalog.js";
import { registerTool, ToolRegistry } from "../../../src/gateway/registry.js";
import { approvalWaiters, createApprovalGate } from "../../../src/policy/approvals.js";
import { policyDenialMessage } from "../../../src/policy/engine.js";
import { TEST_SETTINGS, testCatalog } from "../../helpers/agent-fixtures.js";
import { MemoryApprovalStore } from "../../helpers/approval-store.js";

afterEach(() => approvalWaiters().clear());

const NOW = new Date("2026-09-28T12:00:00.000Z");

function registry(): ToolRegistry {
  const catalog = testCatalog();
  const settings = {
    internalEmailDomains: TEST_SETTINGS.internalEmailDomains,
    allowedSlackChannels: TEST_SETTINGS.allowedSlackChannels,
    internalCalendarIds: TEST_SETTINGS.internalCalendarIds,
    currency: "USD",
  };
  const stripeTools = catalog.stripe.tools(
    {
      integration: "stripe",
      kind: "api",
      profile: "stripe-api",
      endpointLabel: "x",
      api: {
        baseUrl: "http://127.0.0.1:9",
        secretKey: { reveal: () => "k", toString: () => "k", toJSON: () => "k" },
        keyMode: "test",
        apiVersion: null,
      },
    },
    { currency: "USD" },
  );
  return new ToolRegistry(
    profileDescriptors(catalog.stripe).map((descriptor) => {
      const tool = stripeTools.find((candidate) => candidate.name === descriptor.name);
      if (tool === undefined) throw new Error(`missing ${descriptor.name}`);
      return registerTool(descriptor, apiInputSchema(tool), catalog.stripe, settings);
    }),
  );
}

type Harness = {
  readonly events: AgentEvent[];
  readonly ledger: ToolCallLedger;
  readonly context: DecisionContext;
  readonly store: MemoryApprovalStore;
  readonly stop: AbortController;
};

function harness(
  overrides: {
    policy?: PolicyModes;
    mode?: "interactive" | "headless";
    approvals?: ApprovalGate | null;
  } = {},
): Harness {
  const events: AgentEvent[] = [];
  const ledger = new ToolCallLedger((event) => events.push(event));
  const store = new MemoryApprovalStore();
  const stop = new AbortController();
  let ids = 0;
  const mode = overrides.mode ?? "interactive";
  const approvals =
    overrides.approvals !== undefined
      ? overrides.approvals
      : mode === "interactive"
        ? createApprovalGate({ store, now: () => NOW })
        : null;
  const context: DecisionContext = {
    runId: "run_1",
    conversationId: "conv_1",
    registry: registry(),
    policy: overrides.policy ?? DEFAULT_POLICY,
    mode,
    approvals,
    approvalTimeoutMs: 60_000,
    runSignal: stop.signal,
    ledger,
    redact: createRedactorFor(["redact-me-please"]),
    now: () => NOW,
    newId: () => `appr_${++ids}`,
  };
  return { events, ledger, context, store, stop };
}

/** Marks the call announced and its step finished, so its events flow at once. */
function announce(h: Harness, id: string, name = "mcp__stripe__create_refund") {
  h.ledger.noteInputStart(id, name, null);
  h.ledger.noteInputAvailable(id);
  h.ledger.releaseIfReady(id);
}

const hookInput = (toolName: string, toolInput: unknown, id: string): PreToolUseHookInput => ({
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: id,
  session_id: "s",
  transcript_path: "/t",
  cwd: "/w",
});

const options = (id: string) => ({
  signal: new AbortController().signal,
  toolUseID: id,
  requestId: `req_${id}`,
});

describe("the PreToolUse hook", () => {
  it("lets a valid call through to canUseTool without deciding it", async () => {
    const h = harness();
    const hook = createPreToolUseHook(h.context);
    const output = await hook(
      hookInput("mcp__stripe__create_refund", { charge: "ch_2" }, "t1"),
      "t1",
      {
        signal: new AbortController().signal,
      },
    );
    expect(output).toEqual({});
    expect(h.ledger.isSettled("t1")).toBe(false);
  });

  it("rejects invalid arguments before any approval, with a compact message", async () => {
    const h = harness();
    announce(h, "t2");
    const hook = createPreToolUseHook(h.context);
    const output = await hook(
      hookInput("mcp__stripe__create_refund", { charge: "ch_2", amount: "49.00", memo: "x" }, "t2"),
      "t2",
      { signal: new AbortController().signal },
    );
    const reason = h.events.find((event) => event.type === "tool.denied");
    expect(reason).toMatchObject({ type: "tool.denied", toolCallId: "t2", decision: "rejected" });
    const text = reason?.type === "tool.denied" ? reason.reason : "";
    expect(text).toContain('Invalid arguments for "Refund charge in Stripe"');
    expect(text).toContain("`amount` must be integer");
    expect(text).toContain('unexpected property "memo"');
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: text,
      },
    });
    expect(h.store.rows.size).toBe(0);
  });

  it("rejects a tool that is not registered", async () => {
    const h = harness();
    announce(h, "t3", "mcp__stripe__delete_everything");
    const output = await createPreToolUseHook(h.context)(
      hookInput("mcp__stripe__delete_everything", {}, "t3"),
      "t3",
      { signal: new AbortController().signal },
    );
    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(h.events).toEqual([
      {
        type: "tool.denied",
        toolCallId: "t3",
        decision: "rejected",
        reason:
          "Tool mcp__stripe__delete_everything is not available in this run. Nothing was run.",
      },
    ]);
  });
});

describe("canUseTool", () => {
  it("allows an auto class without asking", async () => {
    const h = harness();
    const decision = await createCanUseTool(h.context)(
      "mcp__stripe__list_charges",
      { customer: "cus_1" },
      options("t1"),
    );
    expect(decision).toEqual({ behavior: "allow", updatedInput: { customer: "cus_1" } });
    expect(h.ledger.decisionOf("t1")).toBe("auto");
    expect(h.events).toEqual([]);
  });

  it("denies by policy", async () => {
    const h = harness({ policy: { ...DEFAULT_POLICY, financial: "deny" } });
    announce(h, "t1");
    const decision = await createCanUseTool(h.context)(
      "mcp__stripe__create_refund",
      { charge: "ch_2" },
      options("t1"),
    );
    expect(decision).toEqual({ behavior: "deny", message: policyDenialMessage("financial") });
    expect(h.events).toEqual([
      {
        type: "tool.denied",
        toolCallId: "t1",
        decision: "policy_denied",
        reason: policyDenialMessage("financial"),
      },
    ]);
  });

  it("denies ask in headless mode with the contract's text", async () => {
    const h = harness({ mode: "headless" });
    announce(h, "t1");
    const decision = await createCanUseTool(h.context)(
      "mcp__stripe__create_refund",
      { charge: "ch_2" },
      options("t1"),
    );
    expect(decision).toEqual({ behavior: "deny", message: HEADLESS_ASK_DENIAL });
  });

  it("asks, emits the request after the gate persisted it, and allows on approval", async () => {
    const h = harness();
    announce(h, "t1");
    const pending = createCanUseTool(h.context)(
      "mcp__stripe__create_refund",
      { charge: "ch_2", amount: 4900 },
      options("t1"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const requested = h.events.find((event) => event.type === "approval.requested");
    expect(requested).toEqual({
      type: "approval.requested",
      approvalId: "appr_1",
      toolCallId: "t1",
      descriptor: {
        consequence: "Refund $49.00 of ch_2",
        facts: [
          { label: "Charge", value: "ch_2" },
          { label: "Amount", value: "$49.00" },
        ],
        amount: { amountMinor: 4900, currency: "USD" },
        recordIds: ["ch_2"],
        actionClass: "financial",
        integration: "stripe",
        connectionKind: "api",
        operation: "stripe.refunds.create",
        title: "Refund charge in Stripe",
        expiresAt: "2026-09-28T12:01:00.000Z",
      },
    });
    expect(h.store.rows.get("appr_1")?.status).toBe("pending");
    expect(h.ledger.decisionOf("t1")).toBe("pending");
    const gate = h.context.approvals as ReturnType<typeof createApprovalGate>;
    expect(gate.decide("appr_1", { approved: true })).toBe("accepted");
    await expect(pending).resolves.toEqual({
      behavior: "allow",
      updatedInput: { charge: "ch_2", amount: 4900 },
    });
    expect(h.events.at(-1)).toEqual({
      type: "approval.resolved",
      approvalId: "appr_1",
      toolCallId: "t1",
      approved: true,
      decidedBy: "user",
      reason: null,
    });
    expect(h.ledger.decisionOf("t1")).toBe("approved");
  });

  it("denies with the user's reason and tells the model not to retry", async () => {
    const h = harness();
    announce(h, "t1");
    const pending = createCanUseTool(h.context)(
      "mcp__stripe__create_refund",
      { charge: "ch_2" },
      options("t1"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    (h.context.approvals as ReturnType<typeof createApprovalGate>).decide("appr_1", {
      approved: false,
      reason: "Wrong customer",
    });
    const message =
      "The user declined this action: Wrong customer. It was not run; do not retry it.";
    await expect(pending).resolves.toEqual({ behavior: "deny", message });
    expect(h.events.slice(-2)).toEqual([
      {
        type: "approval.resolved",
        approvalId: "appr_1",
        toolCallId: "t1",
        approved: false,
        decidedBy: "user",
        reason: "Wrong customer",
      },
      { type: "tool.denied", toolCallId: "t1", decision: "denied", reason: message },
    ]);
  });

  it("denies with interrupt when the run is stopped mid-approval", async () => {
    const h = harness();
    announce(h, "t1");
    const pending = createCanUseTool(h.context)(
      "mcp__stripe__create_refund",
      { charge: "ch_2" },
      options("t1"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    h.stop.abort("user");
    const decision = await pending;
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    expect(h.events.map((event) => event.type).slice(-3)).toEqual([
      "approval.requested",
      "approval.resolved",
      "tool.denied",
    ]);
    expect(h.events.at(-1)).toMatchObject({ decision: "stopped" });
    expect(h.store.rows.get("appr_1")?.status).toBe("cancelled");
  });

  it("maps a timeout to timed_out", async () => {
    const outcome: ApprovalOutcome = {
      approved: false,
      decidedBy: "timeout",
      reason: "Not approved within 1 minute; the action was not run.",
    };
    const approvals: ApprovalGate = {
      open: async () => ({ decision: Promise.resolve(outcome) }),
    };
    const h = harness({ approvals });
    announce(h, "t1");
    const decision = await createCanUseTool(h.context)(
      "mcp__stripe__create_refund",
      { charge: "ch_2" },
      options("t1"),
    );
    expect(decision).toEqual({ behavior: "deny", message: outcome.reason });
    expect(h.events.at(-1)).toMatchObject({ type: "tool.denied", decision: "timed_out" });
  });

  it("fails closed when the gate cannot open the approval", async () => {
    const approvals: ApprovalGate = {
      open: async (_request: ApprovalRequest) => {
        throw new Error("database is locked");
      },
    };
    const h = harness({ approvals });
    announce(h, "t1");
    const decision = await createCanUseTool(h.context)(
      "mcp__stripe__create_refund",
      { charge: "ch_2" },
      options("t1"),
    );
    expect(decision).toEqual({ behavior: "deny", message: APPROVAL_UNAVAILABLE_REASON });
    expect(h.events).toEqual([
      {
        type: "tool.denied",
        toolCallId: "t1",
        decision: "policy_denied",
        reason: APPROVAL_UNAVAILABLE_REASON,
      },
    ]);
  });

  it("rejects a tool that is not registered", async () => {
    const h = harness();
    announce(h, "t9", "Bash");
    const decision = await createCanUseTool(h.context)("Bash", { command: "ls" }, options("t9"));
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(h.events).toEqual([expect.objectContaining({ decision: "rejected" })]);
  });
});
