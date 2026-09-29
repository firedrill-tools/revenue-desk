import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { configuredSecrets, loadAgentEnv, withDotenvFile } from "../../../src/config/env.js";
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
      approvalTimeoutMs: 900_000,
      dotenvPath: null,
    });
    expect(env.composio).toEqual({ apiKey: null, userId: null });
    expect(env.stripe).toEqual({ secretKey: null, allowLive: false, apiVersion: null });
    expect(env.hubspot).toEqual({ accessToken: null });
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
      AGENT_MODEL: "claude-opus-5",
      AGENT_EFFORT: "HIGH",
      AGENT_THINKING_DISPLAY: "omitted",
      AGENT_MAX_TURNS: "12",
      AGENT_MAX_BUDGET_USD: "0.50",
      PORT: "5000",
      AGENT_STATE_DIR: "state",
      AGENT_POLICY: '{"financial":"deny","outbound":"auto"}',
      AGENT_APPROVAL_TIMEOUT_MS: "60000",
      COMPOSIO_USER_ID: "  ",
      STRIPE_SECRET_KEY: "sk_test_abcdefgh",
      ALLOW_LIVE_STRIPE: "1",
      HTTP_PROXY: "http://127.0.0.1:1",
      CLAUDE_CODE_MAX_RETRIES: "0",
    });
    expect(env.model.apiKey?.reveal()).toBe("sk-ant-test-key-1234567890");
    expect(env.model).toMatchObject({
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
      approvalTimeoutMs: 60_000,
    });
    expect(env.composio.userId).toBeNull();
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
      AGENT_APPROVAL_TIMEOUT_MS: "abc",
      ALLOW_LIVE_STRIPE: "yes-please",
    });
    expect(found.map((problem) => problem.variable).sort()).toEqual(
      [
        "AGENT_APPROVAL_TIMEOUT_MS",
        "AGENT_EFFORT",
        "AGENT_MAX_BUDGET_USD",
        "AGENT_MAX_TURNS",
        "AGENT_POLICY",
        "AGENT_THINKING_DISPLAY",
        "ALLOW_LIVE_STRIPE",
        "PORT",
      ].sort(),
    );
    const text = JSON.stringify(found);
    for (const value of ["extreme", "loud", "70000", "yes-please", "abc"]) {
      expect(text).not.toContain(value);
    }
  });

  it("refuses a policy that is not an object", () => {
    expect(problems({ AGENT_POLICY: "[]" })[0]?.variable).toBe("AGENT_POLICY");
    expect(problems({ AGENT_POLICY: '{"read":"sometimes"}' })[0]?.message).toContain(
      "unknown mode",
    );
  });

  it("returns a deeply frozen snapshot whose secrets never print", () => {
    const env = ok({
      STRIPE_SECRET_KEY: "sk_test_visible_value",
      HUBSPOT_ACCESS_TOKEN: "pat-na1-visible",
    });
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
      expect(text).not.toContain("pat-na1-visible");
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

describe("variables that could point Revenue Desk somewhere other than the real services", () => {
  // Endpoints, a replacement MCP server and a fixed date: none is configuration.
  const REMOVED = {
    ANTHROPIC_BASE_URL: "https://model.example",
    AGENT_SANDBOX: "1",
    HUBSPOT_MCP_COMMAND: "node",
    HUBSPOT_MCP_ARGS: "server.js",
    COMPOSIO_BASE_URL: "https://composio.example",
    STRIPE_API_BASE_URL: "https://stripe.example",
    HUBSPOT_API_BASE_URL: "https://hubspot.example",
    HUBSPOT_MCP_URL: "https://mcp.example/mcp",
    HUBSPOT_MCP_TOKEN: "mcp-token-value",
    AGENT_BUSINESS_DATE: "2026-01-15",
  };

  it("are gone from the contract", () => {
    for (const name of Object.keys(REMOVED)) expect(ENV_VAR_NAMES).not.toContain(name);
  });

  it("change nothing when set: they are not read", () => {
    const configured = {
      COMPOSIO_API_KEY: "ak_x",
      COMPOSIO_USER_ID: "u",
      HUBSPOT_ACCESS_TOKEN: "t",
    };
    const env = ok({ ...configured, ...REMOVED });
    expect(env).toEqual(ok(configured));
    expect(configuredSecrets(env)).not.toContain(REMOVED.HUBSPOT_MCP_TOKEN);
  });

  it("appear nowhere in the product source, nor do the switches that honoured them", () => {
    // HubSpot's server reads BASE_URL_OVERRIDE; allowLoopbackHttp was the
    // plain-HTTP exception of the removed base URL check.
    const names = [...Object.keys(REMOVED), "BASE_URL_OVERRIDE", "allowLoopbackHttp"];
    const root = resolve(import.meta.dirname, "../../..");
    const files = [
      join(root, ".env.example"),
      ...["src", "web/src"].flatMap((dir) =>
        readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.(ts|tsx|js|mjs|css|html)$/.test(entry.name))
          .map((entry) => join(entry.parentPath, entry.name)),
      ),
    ];
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return names
        .filter((name) => text.includes(name))
        .map((name) => `${relative(root, file)}: ${name}`);
    });
    expect(found).toEqual([]);
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
