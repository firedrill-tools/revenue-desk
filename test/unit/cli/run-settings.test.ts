import { describe, expect, it } from "vitest";
import {
  conversationTitle,
  dateInTimeZone,
  effectivePolicy,
  modelSettings,
  plannedConnections,
} from "../../../src/cli/run-settings.js";
import { loadAgentEnv } from "../../../src/config/env.js";
import type { AskCommand } from "../../../src/contracts/cli.js";
import type { AgentEnv } from "../../../src/contracts/env.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";

const COMMAND: AskCommand = {
  command: "ask",
  prompt: { source: "argument", text: "x" },
  json: false,
  conversationId: null,
  policy: {},
  model: null,
  effort: null,
  maxTurns: null,
  maxBudgetUsd: null,
  timeoutMs: null,
  stateDir: null,
};

function envWith(environment: Record<string, string>): AgentEnv {
  const result = loadAgentEnv(environment, { cwd: "/" });
  if (!result.ok) throw new Error("test configuration refused");
  return result.env;
}

describe("effectivePolicy", () => {
  it("is the default policy when no layer sets a class", () => {
    expect(effectivePolicy({}, {}, {})).toEqual(DEFAULT_POLICY);
  });

  it("applies saved, AGENT_POLICY and --policy layers in order", () => {
    expect(
      effectivePolicy(
        { outbound: "auto", financial: "deny" },
        { financial: "ask", destructive: "ask" },
        { financial: "auto" },
      ),
    ).toEqual({
      read: "auto",
      internal_write: "auto",
      outbound: "auto",
      financial: "auto",
      destructive: "ask",
    });
  });
});

describe("modelSettings", () => {
  const env = envWith({ AGENT_MODEL: "claude-env", AGENT_EFFORT: "low" });

  it("uses the environment when neither flags nor Settings say otherwise", () => {
    expect(modelSettings(COMMAND, { defaultModel: null, defaultEffort: null }, env)).toEqual({
      model: "claude-env",
      effort: "low",
      thinkingDisplay: "omitted",
      maxTurns: 30,
      maxBudgetUsd: 2,
    });
  });

  it("prefers Settings over the environment and flags over Settings", () => {
    const settings = { defaultModel: "claude-settings", defaultEffort: "high" } as const;
    expect(modelSettings(COMMAND, settings, env)).toMatchObject({
      model: "claude-settings",
      effort: "high",
    });
    expect(
      modelSettings(
        { ...COMMAND, model: "claude-flag", effort: "max", maxTurns: 5, maxBudgetUsd: 0.25 },
        settings,
        env,
      ),
    ).toMatchObject({ model: "claude-flag", effort: "max", maxTurns: 5, maxBudgetUsd: 0.25 });
  });

  it("keeps an explicit AGENT_THINKING_DISPLAY", () => {
    const summarized: AgentEnv = { ...env, model: { ...env.model, thinkingDisplay: "summarized" } };
    expect(
      modelSettings(COMMAND, { defaultModel: null, defaultEffort: null }, summarized)
        .thinkingDisplay,
    ).toBe("summarized");
  });
});

describe("dateInTimeZone", () => {
  it("is the calendar date in the zone, not in UTC", () => {
    const now = new Date("2026-09-28T02:30:00.000Z");
    expect(dateInTimeZone(now, "UTC")).toBe("2026-09-28");
    expect(dateInTimeZone(now, "America/New_York")).toBe("2026-09-27");
    expect(dateInTimeZone(now, "Asia/Tokyo")).toBe("2026-09-28");
  });

  it("throws for an unknown zone", () => {
    expect(() => dateInTimeZone(new Date(), "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("conversationTitle", () => {
  it("uses the first non-empty line with whitespace collapsed", () => {
    expect(conversationTitle("\n\n  Why was   Contoso\tcharged twice?\nMore context")).toBe(
      "Why was Contoso charged twice?",
    );
  });

  it("names the conversation as the app does: the first sentence, whole words, about 60 characters", () => {
    const title = conversationTitle(`${"refund ".repeat(30)}now`);
    expect([...title].length).toBeLessThanOrEqual(60);
    expect(title).toMatch(/^(refund )+refund…$/);
    expect(conversationTitle("Chase overdue invoices. Then post to #billing.")).toBe(
      "Chase overdue invoices",
    );
  });
});

describe("plannedConnections", () => {
  it("describes available and unavailable plans without secrets", () => {
    const env = envWith({ STRIPE_SECRET_KEY: `sk_test_${"k".repeat(24)}` });
    const secretKey = env.stripe.secretKey;
    if (secretKey === null) throw new Error("no Stripe key in the test configuration");
    const connections = plannedConnections([
      {
        integration: "stripe",
        status: "available",
        connection: {
          integration: "stripe",
          kind: "api",
          profile: "stripe-api",
          endpointLabel: "api.stripe.com",
          api: { baseUrl: "https://api.stripe.com", secretKey, keyMode: "test", apiVersion: null },
        },
      },
      {
        integration: "google_calendar",
        status: "unavailable",
        state: "needs_auth",
        detail: "Google Calendar needs to be connected in Composio.",
      },
    ]);
    expect(connections).toEqual([
      {
        integration: "stripe",
        kind: "api",
        profile: "stripe-api",
        availability: "ready",
        state: "connected",
        detail: null,
        endpointLabel: "api.stripe.com",
      },
      {
        integration: "google_calendar",
        kind: "composio",
        profile: "composio",
        availability: "unavailable",
        state: "needs_auth",
        detail: "Google Calendar needs to be connected in Composio.",
        endpointLabel: null,
      },
    ]);
    expect(JSON.stringify(connections)).not.toContain(secretKey.reveal());
  });
});
