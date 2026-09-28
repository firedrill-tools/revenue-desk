// The approval policy (docs/ARCHITECTURE.md §7): one mode per action class,
// layered default < saved (Settings) < AGENT_POLICY (locks the class) <
// the CLI's --policy (one run), and the decision for one classified call.
//
// Pure functions; no I/O.

import type { AgentMode } from "../contracts/events.js";
import {
  ACTION_CLASSES,
  type ActionClass,
  APPROVAL_MODES,
  type ApprovalMode,
  type Classification,
  DEFAULT_POLICY,
  HEADLESS_ASK_DENIAL,
  type PolicyModes,
  type PolicyOverrides,
} from "../contracts/integration.js";

export type PolicySource = "default" | "saved" | "environment" | "run";

export type PolicyLayers = {
  /** The policies table. */
  readonly saved?: PolicyOverrides;
  /** AGENT_POLICY; these classes are locked in the app. */
  readonly environment?: PolicyOverrides;
  /** The CLI's --policy, for one run. */
  readonly run?: PolicyOverrides;
};

export type EffectivePolicy = {
  readonly modes: PolicyModes;
  readonly sources: { readonly [C in ActionClass]: PolicySource };
  /** Classes set by AGENT_POLICY: the Settings screen cannot change them. */
  readonly locked: readonly ActionClass[];
};

/** Applies the layers in precedence order (later wins). */
export function resolvePolicy(layers: PolicyLayers = {}): EffectivePolicy {
  const modes: Record<ActionClass, ApprovalMode> = { ...DEFAULT_POLICY };
  const sources: Record<ActionClass, PolicySource> = {
    read: "default",
    internal_write: "default",
    outbound: "default",
    financial: "default",
    destructive: "default",
  };
  const ordered: readonly [PolicySource, PolicyOverrides | undefined][] = [
    ["saved", layers.saved],
    ["environment", layers.environment],
    ["run", layers.run],
  ];
  for (const [source, layer] of ordered) {
    if (layer === undefined) continue;
    for (const actionClass of ACTION_CLASSES) {
      const mode = layer[actionClass];
      if (mode === undefined) continue;
      modes[actionClass] = mode;
      sources[actionClass] = source;
    }
  }
  const locked = ACTION_CLASSES.filter((actionClass) => layers.environment?.[actionClass]);
  return { modes, sources, locked };
}

export type PolicyParseResult =
  | { readonly ok: true; readonly overrides: PolicyOverrides }
  | { readonly ok: false; readonly message: string };

function isActionClass(value: string): value is ActionClass {
  return (ACTION_CLASSES as readonly string[]).includes(value);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * Parses a JSON policy such as `{"financial":"deny"}` (AGENT_POLICY, --policy).
 * Unknown classes and modes are refused, never ignored. Messages name the
 * offending key but never echo a value.
 */
export function parsePolicyOverrides(json: string): PolicyParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: 'must be a JSON object such as {"financial":"deny"}.' };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: 'must be a JSON object such as {"financial":"deny"}.' };
  }
  const overrides: Partial<Record<ActionClass, ApprovalMode>> = {};
  for (const [key, mode] of Object.entries(parsed)) {
    if (!isActionClass(key)) {
      return {
        ok: false,
        message: `has an unknown action class "${key}"; use ${ACTION_CLASSES.join(", ")}.`,
      };
    }
    if (!isApprovalMode(mode)) {
      return { ok: false, message: `sets "${key}" to an unknown mode; use auto, ask or deny.` };
    }
    overrides[key] = mode;
  }
  return { ok: true, overrides };
}

/** What happens to one call. */
export type PolicyDecision =
  | { readonly kind: "allow"; readonly actionClass: ActionClass }
  | { readonly kind: "ask"; readonly actionClass: ActionClass }
  | {
      readonly kind: "deny";
      readonly actionClass: ActionClass | null;
      /** The tool result text the model receives. */
      readonly message: string;
    };

const CLASS_LABEL: { readonly [C in ActionClass]: string } = {
  read: "Reading data",
  internal_write: "Internal changes",
  outbound: "Actions that reach people outside the company",
  financial: "Financial actions",
  destructive: "Destructive actions",
};

/** The model-facing text for a class the policy denies. */
export function policyDenialMessage(actionClass: ActionClass): string {
  return `Blocked by policy: ${CLASS_LABEL[actionClass]} are set to deny in this workspace. The action was not run; do not retry it.`;
}

export const UNCLASSIFIED_DENIAL =
  "Blocked by policy: Revenue Desk could not determine what this call would do, so it was not run.";

/**
 * Decides one call from its classification. Null (unknown or unclassifiable)
 * is denied. In headless mode nobody can answer, so `ask` becomes a denial.
 */
export function decideCall(
  classification: Classification | null,
  modes: PolicyModes,
  mode: AgentMode,
): PolicyDecision {
  if (classification === null) {
    return { kind: "deny", actionClass: null, message: UNCLASSIFIED_DENIAL };
  }
  const { actionClass } = classification;
  switch (modes[actionClass]) {
    case "auto":
      return { kind: "allow", actionClass };
    case "deny":
      return { kind: "deny", actionClass, message: policyDenialMessage(actionClass) };
    case "ask":
      return mode === "headless"
        ? { kind: "deny", actionClass, message: HEADLESS_ASK_DENIAL }
        : { kind: "ask", actionClass };
  }
}
