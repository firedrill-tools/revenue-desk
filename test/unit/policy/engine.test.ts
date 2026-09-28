import { describe, expect, it } from "vitest";
import {
  type Classification,
  DEFAULT_POLICY,
  HEADLESS_ASK_DENIAL,
} from "../../../src/contracts/integration.js";
import {
  decideCall,
  parsePolicyOverrides,
  policyDenialMessage,
  resolvePolicy,
  UNCLASSIFIED_DENIAL,
} from "../../../src/policy/engine.js";

const classification = (actionClass: Classification["actionClass"]): Classification =>
  actionClass === "read" || actionClass === "internal_write"
    ? { actionClass, operation: "stripe.charges.list", title: "List charges" }
    : {
        actionClass,
        operation: "stripe.refunds.create",
        title: "Refund",
        details: { consequence: "Refund $49.00", facts: [] },
      };

describe("resolvePolicy", () => {
  it("defaults to auto reads and internal writes, ask for outbound and money, deny destructive", () => {
    const policy = resolvePolicy();
    expect(policy.modes).toEqual(DEFAULT_POLICY);
    expect(policy.modes).toEqual({
      read: "auto",
      internal_write: "auto",
      outbound: "ask",
      financial: "ask",
      destructive: "deny",
    });
    expect(Object.values(policy.sources).every((source) => source === "default")).toBe(true);
    expect(policy.locked).toEqual([]);
  });

  it("layers saved < AGENT_POLICY (locks) < the run's --policy", () => {
    const policy = resolvePolicy({
      saved: { outbound: "auto", financial: "deny", internal_write: "ask" },
      environment: { financial: "ask", destructive: "deny" },
      run: { outbound: "deny" },
    });
    expect(policy.modes).toEqual({
      read: "auto",
      internal_write: "ask",
      outbound: "deny",
      financial: "ask",
      destructive: "deny",
    });
    expect(policy.sources).toEqual({
      read: "default",
      internal_write: "saved",
      outbound: "run",
      financial: "environment",
      destructive: "environment",
    });
    expect(policy.locked).toEqual(["financial", "destructive"]);
  });
});

describe("parsePolicyOverrides", () => {
  it("accepts known classes and modes", () => {
    expect(parsePolicyOverrides('{"financial":"auto","read":"deny"}')).toEqual({
      ok: true,
      overrides: { financial: "auto", read: "deny" },
    });
    expect(parsePolicyOverrides("{}")).toEqual({ ok: true, overrides: {} });
  });

  it("refuses anything else, never silently", () => {
    for (const json of ["", "nope", "[]", "null", '"auto"', '{"money":"auto"}', '{"read":1}']) {
      expect(parsePolicyOverrides(json).ok).toBe(false);
    }
  });
});

describe("decideCall", () => {
  it("allows, asks or denies by the class's mode", () => {
    expect(decideCall(classification("read"), DEFAULT_POLICY, "interactive")).toEqual({
      kind: "allow",
      actionClass: "read",
    });
    expect(decideCall(classification("financial"), DEFAULT_POLICY, "interactive")).toEqual({
      kind: "ask",
      actionClass: "financial",
    });
    expect(decideCall(classification("destructive"), DEFAULT_POLICY, "interactive")).toEqual({
      kind: "deny",
      actionClass: "destructive",
      message: policyDenialMessage("destructive"),
    });
  });

  it("denies ask in headless mode with the contract's text, but keeps auto", () => {
    expect(decideCall(classification("outbound"), DEFAULT_POLICY, "headless")).toEqual({
      kind: "deny",
      actionClass: "outbound",
      message: HEADLESS_ASK_DENIAL,
    });
    const auto = { ...DEFAULT_POLICY, financial: "auto" as const };
    expect(decideCall(classification("financial"), auto, "headless").kind).toBe("allow");
  });

  it("denies a call that could not be classified", () => {
    expect(decideCall(null, DEFAULT_POLICY, "interactive")).toEqual({
      kind: "deny",
      actionClass: null,
      message: UNCLASSIFIED_DENIAL,
    });
  });

  it("tells the model not to retry a policy denial", () => {
    expect(policyDenialMessage("financial")).toMatch(
      /Blocked by policy: Financial actions .* do not retry it\./,
    );
  });
});
