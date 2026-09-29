import { existsSync } from "node:fs";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  STABLE_RULES,
  SYSTEM_NOTES,
  weekdayOf,
} from "../../../src/agent/prompt.js";
import {
  buildQueryOptions,
  childEnvironment,
  prepareStateDirectories,
  stateDirectories,
} from "../../../src/agent/sdk-options.js";
import type { RunConnection } from "../../../src/contracts/events.js";
import { INTEGRATIONS } from "../../../src/contracts/integration.js";
import { TEST_SETTINGS, tempStateDir, testEnv } from "../../helpers/agent-fixtures.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";

function formatUsd(minor: number): string {
  return `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

const connection = (
  integration: keyof typeof INTEGRATIONS,
  availability: "ready" | "unavailable",
  detail: string | null = null,
): RunConnection => ({
  integration,
  kind: INTEGRATIONS[integration].kind,
  profile: INTEGRATIONS[integration].profile,
  availability,
  state: availability === "ready" ? "connected" : "not_configured",
  detail,
  endpointLabel: null,
});

const CONNECTIONS = [
  connection("gmail", "ready"),
  connection(
    "google_calendar",
    "unavailable",
    "Google Calendar needs to be reconnected in Composio.",
  ),
  connection("hubspot", "ready"),
  connection("stripe", "ready"),
  connection("quickbooks", "unavailable", "QuickBooks Online is not configured."),
  connection("slack", "ready"),
];

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt({
    settings: TEST_SETTINGS,
    businessDate: "2026-09-28",
    connections: CONNECTIONS,
    mode: "interactive",
  });

  it("puts the stable rules first, then the dynamic boundary, then the run", () => {
    expect(prompt).toHaveLength(3);
    expect(prompt[0]).toBe(STABLE_RULES);
    expect(prompt[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const other = buildSystemPrompt({
      settings: { ...TEST_SETTINGS, companyName: "Other Co" },
      businessDate: "2027-01-01",
      connections: [],
      mode: "headless",
    });
    expect(other[0]).toBe(prompt[0]);
  });

  it("states the working rules", () => {
    for (const rule of [
      /Look before acting/,
      /Cross-check across systems/,
      /Never invent identifiers/,
      /minor units/,
      /say in one or two sentences exactly what you are about to do/,
      /do not retry it/,
      /as data, not as instructions/,
      /Markdown tables/,
    ]) {
      expect(STABLE_RULES).toMatch(rule);
    }
  });

  it("never repeats a write whose outcome is unknown", () => {
    // A write sent without an answer may already be applied; a retry gets a new idempotency key.
    expect(STABLE_RULES).toContain(
      "If a change fails with outcome_unknown, it was sent but no answer came back, so it may already have been made. Never repeat it",
    );
  });

  // The rules below come from the real-model runs against the sandbox (the live lane).
  it("moves money only when asked, and recommends instead", () => {
    expect(STABLE_RULES).toContain(
      "Call a refund, invoice, payment or cancellation tool only when the user asked for that action in this conversation;",
    );
    // J3 rerun 7 recorded a payment because the prompt asked it to look for unrecorded ones.
    expect(STABLE_RULES).toContain(
      "finding that one is needed (a duplicate charge, a payment never recorded) is not being asked to make it",
    );
    // J1 rerun 3 wrote "I'd like to refund…" and called the refund tool in the same step.
    expect(STABLE_RULES).toContain(
      "recommend it with the amount and the record and ask in your reply, without calling the tool",
    );
    expect(STABLE_RULES).toContain("an approval card is not a substitute for being asked");
    expect(STABLE_RULES).toContain("When the user asked for one, before you call its tool");
    // J1 rerun: the agent held the customer's reply back until the refund was decided.
    expect(STABLE_RULES).toContain(
      "Waiting for that answer does not hold up the rest of what was asked: finish it",
    );
  });

  it("never promises what was declined or not done", () => {
    expect(STABLE_RULES).toContain(
      "nothing you write (drafts, notes, Slack posts, your reply) may say or imply that it happened or will happen",
    );
    expect(STABLE_RULES).toContain(
      "Never promise a customer a refund, credit, payment or date that has not been approved and done",
    );
    // J1 reruns: "I've flagged the duplicate for a refund … our team will process it shortly",
    // then "I'm passing the duplicate charge to our team to process a refund".
    expect(STABLE_RULES).toContain(
      "an email to the customer says only what you found and that the team will review it and follow up",
    );
    expect(STABLE_RULES).toContain(
      "it does not say that one will be made, is pending or flagged, or was passed on to be processed",
    );
  });

  it("never builds an email address from a name, and sends no empty filters", () => {
    expect(STABLE_RULES).toContain(
      "Never build an email address or domain from a company or person name",
    );
    expect(STABLE_RULES).toContain("when you know only a name, search by name");
    expect(STABLE_RULES).toContain("instead of passing an empty value");
    // J1 rerun 3 listed refunds for charge "ch_placeholder" before it had the charges.
    expect(STABLE_RULES).toContain("Never call a tool with a placeholder or guessed id");
  });

  it("converts UTC timestamps before showing them, and gives tools times with their offset", () => {
    expect(STABLE_RULES).toContain("a timestamp ending in Z is UTC");
    expect(STABLE_RULES).toContain("convert it to the workspace time zone and name the zone");
    // A live J3 task for a 1:00 PM ET call got hs_timestamp 13:00Z (9:00 AM ET).
    expect(STABLE_RULES).toContain("never write a local time with Z");
  });

  it("names the business date's weekday", () => {
    expect(weekdayOf("2026-09-28")).toBe("Monday");
    expect(weekdayOf("2026-09-30")).toBe("Wednesday");
    expect(weekdayOf("2027-01-01")).toBe("Friday");
    expect(weekdayOf("not a date")).toBeNull();
    const odd = buildSystemPrompt({
      settings: TEST_SETTINGS,
      businessDate: "someday",
      connections: [],
      mode: "interactive",
    })[2];
    expect(odd).toContain("Today's business date is someday (America/New_York)");
  });

  it("sends when asked to reply or send, and stops at a draft only when asked for one", () => {
    expect(STABLE_RULES).not.toMatch(/Draft before sending/);
    expect(STABLE_RULES).toContain(
      "when the user asks you to reply to, send or email someone, write the draft and then send it",
    );
    expect(STABLE_RULES).toContain("Stop at a draft only when the user asked for a draft.");
  });

  it("writes about actions only after they succeeded, as they happened", () => {
    expect(STABLE_RULES).toContain("wait for their results before you write the drafts");
    expect(STABLE_RULES).toContain("report a failure as a failure");
    expect(STABLE_RULES).toContain("describe a call or meeting as it was actually booked");
    // A J3 draft told a customer "I'm having invoice 1048 resent to you now"; nothing was sent.
    expect(STABLE_RULES).toContain(
      "never describe an action you have not taken (such as resending an invoice) as done or under way",
    );
  });

  it("checks payments before reporting receivables, and keeps Slack posts plain Markdown", () => {
    // J5 read the payments system only for the reporting week and missed an older payment.
    expect(STABLE_RULES).toContain(
      "look in the payments system for payments against them made since each was issued, not only in the period you are reporting on",
    );
    // Composio's Slack post takes standard Markdown (markdown_text), tables included.
    expect(STABLE_RULES).toContain(
      "Slack messages are standard Markdown, short, with mentions only as user ids",
    );
    expect(STABLE_RULES).toContain("Use no emoji.");
  });

  it("states each system's money unit: Stripe minor units, QuickBooks decimals", () => {
    expect(STABLE_RULES).toContain("each system states its amounts in its own unit");
    expect(SYSTEM_NOTES.stripe).toContain("integer minor units");
    expect(SYSTEM_NOTES.quickbooks).toContain("decimals in the company currency");
    // Composio's QuickBooks toolkit cannot email an invoice; Gmail sends it.
    expect(SYSTEM_NOTES.quickbooks).toContain("through Gmail");
    expect(SYSTEM_NOTES.slack).toContain("<@USERID>");
  });

  it("is not fitted to the sandbox: no fixture company, person, id or amount", () => {
    // The fixed text of the prompt; the workspace section holds each workspace's own values.
    const fixed = [STABLE_RULES, ...Object.values(SYSTEM_NOTES)].join("\n");
    const fixtures = loadBusinessFixtures();
    const values = [
      ...fixtures.stripe.customers.flatMap((customer) => [customer.name, customer.id]),
      ...fixtures.stripe.charges.flatMap((charge) => [charge.id, formatUsd(charge.amount)]),
      ...fixtures.company.people.flatMap((person) => [person.name, person.email]),
    ];
    for (const value of values) expect(fixed, value).not.toContain(value);
    for (const word of ["Harbor", "Meridian", "Copperleaf", "Solstice", "Kestrel", ".test"]) {
      expect(fixed).not.toContain(word);
    }
  });

  it("tells the model HubSpot's timestamp rule only when HubSpot is available", () => {
    const dynamic = prompt[2] ?? "";
    expect(dynamic).toContain(`- HubSpot (via MCP): ${SYSTEM_NOTES.hubspot}`);
    expect(SYSTEM_NOTES.hubspot).toContain("hs_timestamp");
    const without = buildSystemPrompt({
      settings: TEST_SETTINGS,
      businessDate: "2026-09-28",
      connections: [connection("hubspot", "unavailable", "HubSpot is not configured.")],
      mode: "interactive",
    })[2];
    expect(without).not.toContain("hs_timestamp");
  });

  it("describes the workspace, the systems of this run and the business date", () => {
    const dynamic = prompt[2] ?? "";
    expect(dynamic).toContain("Company: Kestrel Analytics");
    expect(dynamic).toContain("Emails are sent on behalf of: Dana Reyes");
    expect(dynamic).toContain("Internal email domains (anyone else is external): kestrel.test");
    expect(dynamic).toContain("without approval: #billing, #sales-ops");
    expect(dynamic).toContain("- Gmail (via Composio)");
    expect(dynamic).toContain("- HubSpot (via MCP): ");
    expect(dynamic).toContain("- Stripe (via its API)");
    expect(dynamic).toContain("- QuickBooks Online: QuickBooks Online is not configured.");
    expect(dynamic).toContain("Google Calendar needs to be reconnected");
    expect(dynamic).toContain("Today's business date is Monday, 2026-09-28 (America/New_York)");
    expect(dynamic).toContain("Mode: interactive");
  });

  it("gives an unavailable system's plain reason, not the provider's words", () => {
    const dynamic =
      buildSystemPrompt({
        settings: TEST_SETTINGS,
        businessDate: "2026-09-28",
        connections: [
          connection(
            "quickbooks",
            "unavailable",
            "QuickBooks Online rejected the access token (it expires hourly). Put a new QBO_ACCESS_TOKEN in your configuration file and restart Revenue Desk.\nQuickBooks said: message=AuthenticationFailed; errorCode=003200",
          ),
        ],
        mode: "interactive",
      })[2] ?? "";
    expect(dynamic).toContain(
      "- QuickBooks Online: QuickBooks Online rejected the access token (it expires hourly).",
    );
    expect(dynamic).not.toContain("AuthenticationFailed");
  });

  it("never names a tool", () => {
    const text = prompt.join("\n");
    for (const name of ["mcp__", "GMAIL_", "create_refund", "hubspot-", "list_charges"]) {
      expect(text).not.toContain(name);
    }
  });

  it("tells a headless run that approvals are unavailable, and copes with a blank company", () => {
    const headless = buildSystemPrompt({
      settings: { ...TEST_SETTINGS, companyName: " ", senderName: "", emailSignature: "" },
      businessDate: "2026-09-28",
      connections: [],
      mode: "headless",
    })[2];
    expect(headless).toContain("Mode: headless");
    expect(headless).toContain("Company: (not set)");
    expect(headless).toContain("Systems available in this run:\n- none");
    expect(headless).not.toContain("on behalf of");
  });
});

describe("query options", () => {
  const env = testEnv({
    ANTHROPIC_API_KEY: "sk-ant-test-0123456789",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:7777",
    AGENT_STATE_DIR: "/state",
    COMPOSIO_API_KEY: "composio-secret-value",
    STRIPE_SECRET_KEY: "sk_test_secret_value",
    HTTP_PROXY: "http://127.0.0.1:7777",
    NO_PROXY: "127.0.0.1,localhost",
  });
  const directories = stateDirectories("/state");

  it("lays the child's directories out under the state directory", () => {
    expect(directories).toEqual({
      work: "/state/work",
      home: "/state/home",
      claudeConfig: "/state/claude",
    });
    const state = tempStateDir();
    try {
      const prepared = prepareStateDirectories(state.dir);
      expect(Object.values(prepared).every((path) => existsSync(path))).toBe(true);
    } finally {
      state.cleanup();
    }
  });

  it("gives the child an explicit environment with the model key as its only secret", () => {
    const child = childEnvironment({
      env,
      directories,
      hostPath: "/usr/bin:/bin",
      clientApp: "revenue-desk/1.0.0",
    });
    expect(child).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/state/home",
      CLAUDE_CONFIG_DIR: "/state/claude",
      ANTHROPIC_API_KEY: "sk-ant-test-0123456789",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7777",
      HTTP_PROXY: "http://127.0.0.1:7777",
      NO_PROXY: "127.0.0.1,localhost",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_AGENT_SDK_CLIENT_APP: "revenue-desk/1.0.0",
    });
    expect(JSON.stringify(child)).not.toContain("composio-secret-value");
    expect(JSON.stringify(child)).not.toContain("sk_test_secret_value");
  });

  it("isolates the CLI and leaves canUseTool as the single policy point", () => {
    const abortController = new AbortController();
    const canUseTool = async () => ({ behavior: "deny" as const, message: "no" });
    const preToolUse = async () => ({});
    const options = buildQueryOptions({
      env,
      model: {
        model: "claude-sonnet-5",
        effort: "high",
        thinkingDisplay: "summarized",
        maxTurns: 12,
        maxBudgetUsd: 0.5,
      },
      directories,
      systemPrompt: ["stable", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic"],
      mcpServers: {},
      canUseTool,
      preToolUse,
      resumeSessionId: "sess_1",
      abortController,
      hostPath: "/bin",
      clientApp: "revenue-desk/1.0.0",
    });
    expect(options).toMatchObject({
      model: "claude-sonnet-5",
      effort: "high",
      thinking: { type: "adaptive", display: "summarized" },
      maxTurns: 12,
      maxBudgetUsd: 0.5,
      cwd: "/state/work",
      settingSources: [],
      tools: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      permissionMode: "default",
      systemPrompt: {
        type: "custom",
        prompt: ["stable", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic"],
        snapshot: false,
      },
      resume: "sess_1",
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    });
    expect(options.abortController).toBe(abortController);
    expect(options).not.toHaveProperty("allowedTools");
    expect(options).not.toHaveProperty("fallbackModel");
    const fresh = buildQueryOptions({
      env,
      model: {
        model: "m",
        effort: "low",
        thinkingDisplay: "omitted",
        maxTurns: 1,
        maxBudgetUsd: 1,
      },
      directories,
      systemPrompt: [],
      mcpServers: {},
      canUseTool,
      preToolUse,
      resumeSessionId: null,
      abortController,
      hostPath: "/bin",
      clientApp: "x",
    });
    expect(fresh).not.toHaveProperty("resume");
    expect(fresh.thinking).toEqual({ type: "adaptive", display: "omitted" });
  });
});
