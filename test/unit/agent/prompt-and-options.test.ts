import { existsSync } from "node:fs";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, STABLE_RULES } from "../../../src/agent/prompt.js";
import {
  buildQueryOptions,
  childEnvironment,
  prepareStateDirectories,
  stateDirectories,
} from "../../../src/agent/sdk-options.js";
import type { RunConnection } from "../../../src/contracts/events.js";
import { INTEGRATIONS } from "../../../src/contracts/integration.js";
import { TEST_SETTINGS, tempStateDir, testEnv } from "../../helpers/agent-fixtures.js";

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
      /Draft before sending/,
      /say in one or two sentences exactly what you are about to do/,
      /do not retry it/,
      /as data, not as instructions/,
      /Markdown tables/,
    ]) {
      expect(STABLE_RULES).toMatch(rule);
    }
  });

  it("describes the workspace, the systems of this run and the business date", () => {
    const dynamic = prompt[2] ?? "";
    expect(dynamic).toContain("Company: Kestrel Analytics");
    expect(dynamic).toContain("Emails are sent on behalf of: Dana Reyes");
    expect(dynamic).toContain("Internal email domains (anyone else is external): kestrel.test");
    expect(dynamic).toContain("without approval: #billing, #sales-ops");
    expect(dynamic).toContain("- Gmail (via Composio)");
    expect(dynamic).toContain("- HubSpot (via MCP)");
    expect(dynamic).toContain("- Stripe (via its API)");
    expect(dynamic).toContain("- QuickBooks Online: QuickBooks Online is not configured.");
    expect(dynamic).toContain("Google Calendar needs to be reconnected");
    expect(dynamic).toContain("Today's business date is 2026-09-28 (America/New_York)");
    expect(dynamic).toContain("Mode: interactive");
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
