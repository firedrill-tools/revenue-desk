import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  configuredSecrets,
  loadAgentEnv,
  sandboxEndpointProblems,
  withDotenvFile,
} from "../../../src/config/env.js";
import { isLoopbackHost, isLoopbackUrl } from "../../../src/config/loopback.js";
import { isSecretValue, REDACTED, secretValue } from "../../../src/config/secret.js";
import { ENV_DEFAULTS, ENV_VAR_NAMES, ENV_VARS } from "../../../src/contracts/env.js";

const ok = (environment: Record<string, string | undefined>, cwd = "/work") => {
  const result = loadAgentEnv(environment, { cwd });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.env;
};

const problems = (environment: Record<string, string | undefined>) => {
  const result = loadAgentEnv(environment, { cwd: "/work" });
  if (result.ok) throw new Error("expected problems");
  return result.problems;
};

describe("loadAgentEnv", () => {
  it("applies every default to an empty environment", () => {
    const env = ok({});
    expect(env.model).toEqual({
      apiKey: null,
      baseUrl: null,
      model: ENV_DEFAULTS.AGENT_MODEL,
      effort: "medium",
      thinkingDisplay: null,
      maxTurns: 30,
      maxBudgetUsd: 2,
    });
    expect(env.runtime).toEqual({
      port: 4320,
      stateDir: "/work/data",
      policyOverrides: {},
      businessDate: null,
      approvalTimeoutMs: 900_000,
      sandbox: false,
      dotenvPath: null,
    });
    expect(env.composio).toEqual({
      apiKey: null,
      userId: null,
      baseUrl: "https://backend.composio.dev",
    });
    expect(env.stripe).toMatchObject({ apiBaseUrl: "https://api.stripe.com", allowLive: false });
    expect(env.quickbooks.apiBaseUrl).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(env.slack.apiBaseUrl).toBe("https://slack.com");
    expect(env.hubspot).toEqual({
      accessToken: null,
      apiBaseUrl: null,
      mcpUrl: null,
      mcpToken: null,
      command: null,
    });
    expect(env.passthrough).toEqual({
      HTTP_PROXY: null,
      HTTPS_PROXY: null,
      NO_PROXY: null,
      CLAUDE_CODE_MAX_RETRIES: null,
    });
  });

  it("parses every value it owns, trims them, and treats blanks as unset", () => {
    const env = ok({
      ANTHROPIC_API_KEY: "  sk-ant-test-key-1234567890  ",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
      AGENT_MODEL: "claude-opus-5",
      AGENT_EFFORT: "HIGH",
      AGENT_THINKING_DISPLAY: "omitted",
      AGENT_MAX_TURNS: "12",
      AGENT_MAX_BUDGET_USD: "0.50",
      PORT: "5000",
      AGENT_STATE_DIR: "state",
      AGENT_POLICY: '{"financial":"deny","outbound":"auto"}',
      AGENT_BUSINESS_DATE: "2026-02-28",
      AGENT_APPROVAL_TIMEOUT_MS: "60000",
      COMPOSIO_USER_ID: "  ",
      HUBSPOT_MCP_COMMAND: "node",
      HUBSPOT_MCP_ARGS: '["server.js","--flag"]',
      STRIPE_SECRET_KEY: "sk_test_abcdefgh",
      ALLOW_LIVE_STRIPE: "1",
      HTTP_PROXY: "http://127.0.0.1:1",
      CLAUDE_CODE_MAX_RETRIES: "0",
    });
    expect(env.model.apiKey?.reveal()).toBe("sk-ant-test-key-1234567890");
    expect(env.model).toMatchObject({
      baseUrl: "http://127.0.0.1:9999",
      model: "claude-opus-5",
      effort: "high",
      thinkingDisplay: "omitted",
      maxTurns: 12,
      maxBudgetUsd: 0.5,
    });
    expect(env.runtime).toMatchObject({
      port: 5000,
      stateDir: "/work/state",
      policyOverrides: { financial: "deny", outbound: "auto" },
      businessDate: "2026-02-28",
      approvalTimeoutMs: 60_000,
    });
    expect(env.composio.userId).toBeNull();
    expect(env.hubspot.command).toEqual({ command: "node", args: ["server.js", "--flag"] });
    expect(env.stripe.allowLive).toBe(true);
    expect(env.passthrough).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:1",
      CLAUDE_CODE_MAX_RETRIES: "0",
    });
  });

  it("names each refused variable without echoing its value", () => {
    const found = problems({
      AGENT_EFFORT: "extreme",
      AGENT_THINKING_DISPLAY: "loud",
      AGENT_MAX_TURNS: "0",
      AGENT_MAX_BUDGET_USD: "-1",
      PORT: "70000",
      AGENT_POLICY: '{"refunds":"auto"}',
      AGENT_BUSINESS_DATE: "2026-02-30",
      AGENT_APPROVAL_TIMEOUT_MS: "abc",
      ANTHROPIC_BASE_URL: "ftp://secret-host.example/x",
      ALLOW_LIVE_STRIPE: "yes-please",
      HUBSPOT_MCP_ARGS: '["x"]',
    });
    expect(found.map((problem) => problem.variable).sort()).toEqual(
      [
        "AGENT_APPROVAL_TIMEOUT_MS",
        "AGENT_BUSINESS_DATE",
        "AGENT_EFFORT",
        "AGENT_MAX_BUDGET_USD",
        "AGENT_MAX_TURNS",
        "AGENT_POLICY",
        "AGENT_THINKING_DISPLAY",
        "ALLOW_LIVE_STRIPE",
        "ANTHROPIC_BASE_URL",
        "HUBSPOT_MCP_ARGS",
        "PORT",
      ].sort(),
    );
    const text = JSON.stringify(found);
    for (const value of ["extreme", "loud", "70000", "secret-host", "yes-please", "abc"]) {
      expect(text).not.toContain(value);
    }
  });

  it("refuses malformed HubSpot arguments and a policy that is not an object", () => {
    expect(problems({ HUBSPOT_MCP_COMMAND: "node", HUBSPOT_MCP_ARGS: "[1,2]" })).toEqual([
      { variable: "HUBSPOT_MCP_ARGS", message: "must be a JSON array of strings." },
    ]);
    expect(problems({ AGENT_POLICY: "[]" })[0]?.variable).toBe("AGENT_POLICY");
    expect(problems({ AGENT_POLICY: '{"read":"sometimes"}' })[0]?.message).toContain(
      "unknown mode",
    );
  });

  it("returns a deeply frozen snapshot whose secrets never print", () => {
    const env = ok({ STRIPE_SECRET_KEY: "sk_test_visible_value", SLACK_BOT_TOKEN: "xoxb-1-2-3" });
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.stripe)).toBe(true);
    expect(Object.isFrozen(env.runtime.policyOverrides)).toBe(true);
    expect(() => {
      (env.model as { model: string }).model = "other";
    }).toThrow(TypeError);
    const printed = [
      JSON.stringify(env),
      inspect(env, { depth: 10 }),
      String(env.stripe.secretKey),
    ];
    for (const text of printed) {
      expect(text).not.toContain("sk_test_visible_value");
      expect(text).not.toContain("xoxb-1-2-3");
    }
    expect(JSON.stringify(env.stripe)).toContain(REDACTED);
    expect(env.stripe.secretKey?.reveal()).toBe("sk_test_visible_value");
  });

  it("never mutates the environment it reads", () => {
    const environment = { AGENT_MODEL: " x ", PORT: "1" };
    const copy = { ...environment };
    ok(environment);
    expect(environment).toEqual(copy);
  });

  it("reads process.env by default", () => {
    const result = loadAgentEnv();
    expect(result.ok || result.problems.length > 0).toBe(true);
  });
});

describe("configuredSecrets", () => {
  it("returns the value of every secret variable in the contract", () => {
    const secretNames = ENV_VAR_NAMES.filter((name) => ENV_VARS[name].secret);
    const environment = Object.fromEntries(secretNames.map((name) => [name, `value-of-${name}`]));
    const env = ok(environment);
    expect(configuredSecrets(env).sort()).toEqual(
      secretNames.map((name) => `value-of-${name}`).sort(),
    );
    expect(configuredSecrets(ok({}))).toEqual([]);
  });
});

describe("the AGENT_SANDBOX loopback rule", () => {
  const configured = {
    AGENT_SANDBOX: "1",
    COMPOSIO_API_KEY: "composio-key",
    COMPOSIO_USER_ID: "user",
    HUBSPOT_ACCESS_TOKEN: "pat-na1-token",
    STRIPE_SECRET_KEY: "sk_test_key",
    QBO_ACCESS_TOKEN: "qbo-token",
    QBO_REALM_ID: "123",
    SLACK_BOT_TOKEN: "xoxb-token",
  };

  it("refuses every configured integration whose endpoint is not loopback", () => {
    expect(
      problems(configured)
        .map((problem) => problem.variable)
        .sort(),
    ).toEqual([
      "COMPOSIO_BASE_URL",
      "HUBSPOT_API_BASE_URL",
      "QBO_API_BASE_URL",
      "SLACK_API_BASE_URL",
      "STRIPE_API_BASE_URL",
    ]);
  });

  it("accepts loopback endpoints and ignores unconfigured integrations", () => {
    const env = ok({
      ...configured,
      COMPOSIO_BASE_URL: "http://127.0.0.1:4001",
      HUBSPOT_API_BASE_URL: "http://localhost:4002/hubspot",
      STRIPE_API_BASE_URL: "http://[::1]:4003",
      QBO_API_BASE_URL: "http://127.0.0.1:4004",
      SLACK_API_BASE_URL: "http://127.0.0.1:4005",
    });
    expect(env.runtime.sandbox).toBe(true);
    expect(ok({ AGENT_SANDBOX: "1" }).runtime.sandbox).toBe(true);
  });

  it("checks HUBSPOT_MCP_URL when set, allows a stdio command override, and the real model", () => {
    expect(
      problems({ AGENT_SANDBOX: "1", HUBSPOT_MCP_URL: "https://mcp.hubspot.com" }),
    ).toHaveLength(1);
    expect(
      ok({ AGENT_SANDBOX: "1", HUBSPOT_ACCESS_TOKEN: "t", HUBSPOT_MCP_COMMAND: "node" }).runtime
        .sandbox,
    ).toBe(true);
    expect(ok({ AGENT_SANDBOX: "1", ANTHROPIC_API_KEY: "k" }).model.baseUrl).toBeNull();
    expect(problems({ AGENT_SANDBOX: "1", ANTHROPIC_BASE_URL: "https://api.example.com" })).toEqual(
      [expect.objectContaining({ variable: "ANTHROPIC_BASE_URL" })],
    );
  });

  it("does not apply outside sandbox mode", () => {
    const env = ok({ ...configured, AGENT_SANDBOX: "0" });
    expect(sandboxEndpointProblems(env)).toHaveLength(5);
  });
});

describe("loopback detection", () => {
  it("knows loopback hosts and URLs", () => {
    for (const host of ["localhost", "api.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["example.com", "10.0.0.1", "128.0.0.1", "localhost.example.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    expect(isLoopbackUrl("http://127.0.0.1:1/x")).toBe(true);
    expect(isLoopbackUrl("ftp://127.0.0.1")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("withDotenvFile", () => {
  it("fills unset or blank variables from the file; the environment wins", () => {
    const files: Record<string, string> = {
      "/secrets/revenue.env": "A=from-file\nB=from-file\nC=from-file\nDOTENV_PATH=/elsewhere\n",
    };
    const result = withDotenvFile(
      { DOTENV_PATH: "revenue.env", A: "from-env", B: "  " },
      { cwd: "/secrets", readFile: (path) => files[path] ?? "" },
    );
    expect(result).toEqual({
      ok: true,
      environment: { A: "from-env", B: "from-file", C: "from-file", DOTENV_PATH: "revenue.env" },
    });
  });

  it("reports an unreadable file by variable name only", () => {
    const result = withDotenvFile(
      { DOTENV_PATH: "/nope/missing.env" },
      {
        readFile: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      problem: { variable: "DOTENV_PATH", message: "names a file that could not be read." },
    });
    expect(withDotenvFile({ A: "1" })).toEqual({ ok: true, environment: { A: "1" } });
  });
});

describe("SecretValue", () => {
  it("hides its value everywhere but reveal()", () => {
    const secret = secretValue("hunter2-hunter2");
    expect(`${secret}`).toBe(REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED}"}`);
    expect(inspect(secret)).toBe(REDACTED);
    expect(secret.reveal()).toBe("hunter2-hunter2");
    expect(isSecretValue(secret)).toBe(true);
    expect(isSecretValue("hunter2")).toBe(false);
    expect(() => secretValue("")).toThrow(TypeError);
  });
});
