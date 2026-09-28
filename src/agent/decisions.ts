// The two points where a tool call is decided before it runs:
//
// 1. The PreToolUse hook (runs first): refuses a name that is not in the
//    run's registry and any input that fails the offered JSON schema. Such
//    calls are `rejected` before any policy or approval, so nobody is ever
//    asked to approve an invalid call.
// 2. canUseTool (the single policy point): classifies the complete input,
//    applies the policy, and for `ask` opens an approval through the
//    ApprovalGate and waits for its decision. A stop answers with
//    `interrupt: true`, which ends the turn.
//
// Events go through the ToolCallLedger, which holds them until the call's
// tool.input.available and step.finish are out (src/agent/tool-calls.ts).

import type { CanUseTool, HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Redactor } from "../config/redact.js";
import type {
  AgentMode,
  ApprovalDescriptor,
  ApprovalGate,
  ApprovalOutcome,
  PendingApproval,
} from "../contracts/events.js";
import type { PolicyModes } from "../contracts/integration.js";
import type { JsonObject } from "../contracts/json.js";
import type { ToolRegistry } from "../gateway/registry.js";
import { invalidArgumentsMessage } from "../gateway/validate.js";
import { USER_DENIAL_REASON } from "../policy/approvals.js";
import { decideCall } from "../policy/engine.js";
import type { ToolCallLedger } from "./tool-calls.js";

export type DecisionContext = {
  readonly runId: string;
  readonly conversationId: string;
  readonly registry: ToolRegistry;
  readonly policy: PolicyModes;
  readonly mode: AgentMode;
  /** Null in headless mode: nothing waits. */
  readonly approvals: ApprovalGate | null;
  readonly approvalTimeoutMs: number;
  /** The run's signal: aborting it settles pending approvals as stopped. */
  readonly runSignal: AbortSignal;
  readonly ledger: ToolCallLedger;
  readonly redact: Redactor;
  readonly now: () => Date;
  readonly newId: () => string;
};

export const UNKNOWN_TOOL_REASON = (name: string) =>
  `Tool ${name} is not available in this run. Nothing was run.`;
export const APPROVAL_UNAVAILABLE_REASON =
  "Revenue Desk could not record the approval request, so the action was not run. Do not retry it.";

function asJsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    return {};
  }
}

function hookDenial(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

/** The PreToolUse hook: registry and schema checks, before any policy. */
export function createPreToolUseHook(context: DecisionContext): HookCallback {
  const { ledger, registry } = context;
  const reject = (toolCallId: string, reason: string) => {
    if (ledger.settle(toolCallId, "rejected")) {
      ledger.emitFor(toolCallId, { type: "tool.denied", toolCallId, decision: "rejected", reason });
    }
    return hookDenial(reason);
  };
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolCallId = input.tool_use_id ?? toolUseID;
    if (toolCallId === undefined)
      return hookDenial("The call has no tool-use id. Nothing was run.");
    ledger.noteCallbackCall(toolCallId, input.tool_name, asJsonObject(input.tool_input));
    const tool = registry.get(input.tool_name);
    if (tool === undefined) return reject(toolCallId, UNKNOWN_TOOL_REASON(input.tool_name));
    const issues = tool.validate(input.tool_input);
    if (issues.length > 0) {
      return reject(
        toolCallId,
        context.redact(invalidArgumentsMessage(tool.descriptor.title, issues)),
      );
    }
    // Continue to canUseTool; never "allow" here, which would skip the policy.
    return {};
  };
}

function userDenialMessage(reason: string | null): string {
  const detail = reason === null || reason === USER_DENIAL_REASON ? "" : `: ${reason}`;
  return `The user declined this action${detail}. It was not run; do not retry it.`;
}

/** canUseTool: classification, policy and approvals. */
export function createCanUseTool(context: DecisionContext): CanUseTool {
  const { ledger, registry, redact } = context;

  const deny = (
    toolCallId: string,
    decision: "denied" | "policy_denied" | "timed_out" | "stopped" | "rejected",
    reason: string,
    interrupt = false,
  ): PermissionResult => {
    if (ledger.settle(toolCallId, decision)) {
      ledger.emitFor(toolCallId, { type: "tool.denied", toolCallId, decision, reason });
    }
    return { behavior: "deny", message: reason, ...(interrupt ? { interrupt: true } : {}) };
  };

  return async (toolName, input, options) => {
    const toolCallId = options.toolUseID;
    const args = asJsonObject(input);
    ledger.noteCallbackCall(toolCallId, toolName, args);
    const tool = registry.get(toolName);
    if (tool === undefined) return deny(toolCallId, "rejected", UNKNOWN_TOOL_REASON(toolName));

    const classification = tool.classify(args);
    const decision = decideCall(classification, context.policy, context.mode);
    if (decision.kind === "allow") {
      ledger.decide(toolCallId, "auto");
      return { behavior: "allow", updatedInput: input };
    }
    if (decision.kind === "deny" || context.approvals === null || classification === null) {
      const message = decision.kind === "deny" ? decision.message : APPROVAL_UNAVAILABLE_REASON;
      return deny(toolCallId, "policy_denied", message);
    }

    const { descriptor: spec } = tool;
    const expiresAt = new Date(context.now().getTime() + context.approvalTimeoutMs).toISOString();
    const details = classification.details ?? { consequence: classification.title, facts: [] };
    const descriptor = redact.json({
      ...details,
      actionClass: classification.actionClass,
      integration: spec.integration,
      connectionKind: spec.connectionKind,
      operation: classification.operation,
      title: classification.title,
      expiresAt,
    } satisfies ApprovalDescriptor) as ApprovalDescriptor;
    const approvalId = context.newId();
    const signal = AbortSignal.any([context.runSignal, options.signal]);

    let pending: PendingApproval;
    try {
      pending = await context.approvals.open(
        {
          approvalId,
          runId: context.runId,
          conversationId: context.conversationId,
          toolCallId,
          descriptor,
        },
        signal,
      );
    } catch {
      return deny(toolCallId, "policy_denied", APPROVAL_UNAVAILABLE_REASON);
    }
    ledger.decide(toolCallId, "pending");
    ledger.emitFor(toolCallId, { type: "approval.requested", approvalId, toolCallId, descriptor });

    const outcome: ApprovalOutcome = await pending.decision;
    ledger.emitFor(toolCallId, {
      type: "approval.resolved",
      approvalId,
      toolCallId,
      approved: outcome.approved,
      decidedBy: outcome.decidedBy,
      reason: outcome.reason === null ? null : redact(outcome.reason),
    });
    if (outcome.approved) {
      ledger.decide(toolCallId, "approved");
      return { behavior: "allow", updatedInput: input };
    }
    switch (outcome.decidedBy) {
      case "user":
        return deny(toolCallId, "denied", redact(userDenialMessage(outcome.reason)));
      case "timeout":
        return deny(toolCallId, "timed_out", redact(outcome.reason));
      case "stop":
        return deny(toolCallId, "stopped", redact(outcome.reason), true);
    }
  };
}
