// The configuration snapshot (docs/ARCHITECTURE.md §3, src/contracts/env.ts).
//
// loadAgentEnv() reads an environment record once (process.env by default,
// or the record a caller already merged with its DOTENV_PATH file) into an
// immutable AgentEnv, applying ENV_DEFAULTS. It validates the model and
// runtime values it owns and the AGENT_SANDBOX loopback rule. Integration
// sections hold raw configuration: IntegrationDefinition.resolve() decides
// whether an integration is configured, not_configured or invalid.
//
// Problems name the variable and the rule, never the value. Secrets become
// SecretValue at once. Blank values count as unset. Nothing here mutates the
// environment or contacts anything.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  type AgentEffort,
  type AgentEnv,
  type ConfigProblem,
  EFFORT_LEVELS,
  ENV_DEFAULTS,
  type EnvVarName,
  type SDK_CHILD_PASSTHROUGH_VARS,
  type SecretValue,
  type ThinkingDisplay,
} from "../contracts/env.js";
import type { PolicyOverrides } from "../contracts/integration.js";
import { parsePolicyOverrides } from "../policy/engine.js";
import { isLoopbackUrl } from "./loopback.js";
import { secretValue } from "./secret.js";

/** Environment variables as strings; unset and blank are the same. */
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export type AgentEnvResult =
  | { readonly ok: true; readonly env: AgentEnv }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export type LoadAgentEnvOptions = {
  /** Resolves a relative AGENT_STATE_DIR. Default process.cwd(). */
  readonly cwd?: string;
};

const THINKING_DISPLAYS: readonly ThinkingDisplay[] = ["summarized", "omitted"];
const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PORT = 65_535;

class Reader {
  readonly problems: ConfigProblem[] = [];

  constructor(private readonly source: EnvironmentRecord) {}

  /** The trimmed value, or null when unset or blank. */
  text(name: EnvVarName | (typeof SDK_CHILD_PASSTHROUGH_VARS)[number]): string | null {
    const value = this.source[name];
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  secret(name: EnvVarName): SecretValue | null {
    const value = this.text(name);
    return value === null ? null : secretValue(value);
  }

  problem(variable: EnvVarName, message: string): void {
    this.problems.push({ variable, message });
  }

  integer(name: EnvVarName, fallback: number, min: number, max: number): number {
    const value = this.text(name);
    if (value === null) return fallback;
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      this.problem(name, `must be a whole number from ${min} to ${max}.`);
      return fallback;
    }
    return parsed;
  }

  positiveNumber(name: EnvVarName, fallback: number): number {
    const value = this.text(name);
    if (value === null) return fallback;
    const parsed = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.problem(name, "must be a positive number such as 2 or 0.50.");
      return fallback;
    }
    return parsed;
  }

  flag(name: EnvVarName): boolean {
    const value = this.text(name)?.toLowerCase() ?? null;
    if (value === null || value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
    this.problem(name, "must be 1 or 0.");
    return false;
  }

  oneOf<T extends string>(name: EnvVarName, allowed: readonly T[]): T | null {
    const value = this.text(name);
    if (value === null) return null;
    const match = allowed.find((candidate) => candidate === value.toLowerCase());
    if (match === undefined) this.problem(name, `must be one of ${allowed.join(", ")}.`);
    return match ?? null;
  }

  httpUrl(name: EnvVarName): string | null {
    const value = this.text(name);
    if (value === null) return null;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      this.problem(name, "must be an absolute http or https URL.");
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      this.problem(name, "must be an absolute http or https URL.");
      return null;
    }
    if (parsed.username !== "" || parsed.password !== "") {
      this.problem(name, "must not contain credentials.");
      return null;
    }
    return value;
  }
}

function validCalendarDate(value: string): boolean {
  const match = BUSINESS_DATE.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function readPolicy(reader: Reader): PolicyOverrides {
  const raw = reader.text("AGENT_POLICY");
  if (raw === null) return {};
  const parsed = parsePolicyOverrides(raw);
  if (!parsed.ok) {
    reader.problem("AGENT_POLICY", parsed.message);
    return {};
  }
  return parsed.overrides;
}

function readHubSpotCommand(reader: Reader): AgentEnv["hubspot"]["command"] {
  const command = reader.text("HUBSPOT_MCP_COMMAND");
  const rawArgs = reader.text("HUBSPOT_MCP_ARGS");
  if (command === null) {
    if (rawArgs !== null) reader.problem("HUBSPOT_MCP_ARGS", "requires HUBSPOT_MCP_COMMAND.");
    return null;
  }
  if (rawArgs === null) return { command, args: [] };
  let args: unknown;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    args = undefined;
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    reader.problem("HUBSPOT_MCP_ARGS", "must be a JSON array of strings.");
    return null;
  }
  return { command, args };
}

/**
 * The AGENT_SANDBOX rule: every integration endpoint that would be used must
 * be loopback. The model endpoint is checked only when ANTHROPIC_BASE_URL is
 * set: the sandbox demo may run the real model (by explicit choice), which
 * leaves it unset.
 */
export function sandboxEndpointProblems(env: AgentEnv): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const require = (variable: EnvVarName, url: string | null) => {
    if (url === null || !isLoopbackUrl(url)) {
      problems.push({
        variable,
        message:
          "AGENT_SANDBOX=1 requires a loopback endpoint (127.0.0.1, localhost or [::1]) for every configured integration.",
      });
    }
  };
  if (env.model.baseUrl !== null) require("ANTHROPIC_BASE_URL", env.model.baseUrl);
  if (env.composio.apiKey !== null || env.composio.userId !== null) {
    require("COMPOSIO_BASE_URL", env.composio.baseUrl);
  }
  if (env.hubspot.mcpUrl !== null) require("HUBSPOT_MCP_URL", env.hubspot.mcpUrl);
  else if (env.hubspot.accessToken !== null && env.hubspot.command === null) {
    require("HUBSPOT_API_BASE_URL", env.hubspot.apiBaseUrl);
  }
  if (env.stripe.secretKey !== null) require("STRIPE_API_BASE_URL", env.stripe.apiBaseUrl);
  if (env.quickbooks.accessToken !== null || env.quickbooks.realmId !== null) {
    require("QBO_API_BASE_URL", env.quickbooks.apiBaseUrl);
  }
  if (env.slack.botToken !== null) require("SLACK_API_BASE_URL", env.slack.apiBaseUrl);
  return problems;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reads the environment once into an immutable AgentEnv, or the problems that refuse it. */
export function loadAgentEnv(
  environment: EnvironmentRecord = process.env,
  options: LoadAgentEnvOptions = {},
): AgentEnvResult {
  const reader = new Reader(environment);
  const cwd = options.cwd ?? process.cwd();

  const effort: AgentEffort =
    reader.oneOf("AGENT_EFFORT", EFFORT_LEVELS) ?? ENV_DEFAULTS.AGENT_EFFORT;
  const businessDate = reader.text("AGENT_BUSINESS_DATE");
  if (businessDate !== null && !validCalendarDate(businessDate)) {
    reader.problem("AGENT_BUSINESS_DATE", "must be a calendar date written YYYY-MM-DD.");
  }

  const env: AgentEnv = {
    model: {
      apiKey: reader.secret("ANTHROPIC_API_KEY"),
      baseUrl: reader.httpUrl("ANTHROPIC_BASE_URL"),
      model: reader.text("AGENT_MODEL") ?? ENV_DEFAULTS.AGENT_MODEL,
      effort,
      thinkingDisplay: reader.oneOf("AGENT_THINKING_DISPLAY", THINKING_DISPLAYS),
      maxTurns: reader.integer("AGENT_MAX_TURNS", ENV_DEFAULTS.AGENT_MAX_TURNS, 1, 1_000),
      maxBudgetUsd: reader.positiveNumber(
        "AGENT_MAX_BUDGET_USD",
        ENV_DEFAULTS.AGENT_MAX_BUDGET_USD,
      ),
    },
    runtime: {
      port: reader.integer("PORT", ENV_DEFAULTS.PORT, 1, MAX_PORT),
      stateDir: resolve(cwd, reader.text("AGENT_STATE_DIR") ?? ENV_DEFAULTS.AGENT_STATE_DIR),
      policyOverrides: readPolicy(reader),
      businessDate: businessDate !== null && validCalendarDate(businessDate) ? businessDate : null,
      approvalTimeoutMs: reader.integer(
        "AGENT_APPROVAL_TIMEOUT_MS",
        ENV_DEFAULTS.AGENT_APPROVAL_TIMEOUT_MS,
        1_000,
        7 * 24 * 60 * 60 * 1_000,
      ),
      sandbox: reader.flag("AGENT_SANDBOX"),
      dotenvPath: reader.text("DOTENV_PATH"),
    },
    passthrough: {
      HTTP_PROXY: reader.text("HTTP_PROXY"),
      HTTPS_PROXY: reader.text("HTTPS_PROXY"),
      NO_PROXY: reader.text("NO_PROXY"),
      CLAUDE_CODE_MAX_RETRIES: reader.text("CLAUDE_CODE_MAX_RETRIES"),
    },
    composio: {
      apiKey: reader.secret("COMPOSIO_API_KEY"),
      userId: reader.text("COMPOSIO_USER_ID"),
      baseUrl: reader.text("COMPOSIO_BASE_URL") ?? ENV_DEFAULTS.COMPOSIO_BASE_URL,
    },
    hubspot: {
      accessToken: reader.secret("HUBSPOT_ACCESS_TOKEN"),
      apiBaseUrl: reader.text("HUBSPOT_API_BASE_URL"),
      mcpUrl: reader.text("HUBSPOT_MCP_URL"),
      mcpToken: reader.secret("HUBSPOT_MCP_TOKEN"),
      command: readHubSpotCommand(reader),
    },
    stripe: {
      secretKey: reader.secret("STRIPE_SECRET_KEY"),
      allowLive: reader.flag("ALLOW_LIVE_STRIPE"),
      apiBaseUrl: reader.text("STRIPE_API_BASE_URL") ?? ENV_DEFAULTS.STRIPE_API_BASE_URL,
      apiVersion: reader.text("STRIPE_API_VERSION"),
    },
    quickbooks: {
      accessToken: reader.secret("QBO_ACCESS_TOKEN"),
      realmId: reader.text("QBO_REALM_ID"),
      apiBaseUrl: reader.text("QBO_API_BASE_URL") ?? ENV_DEFAULTS.QBO_API_BASE_URL,
      minorVersion: reader.text("QBO_MINOR_VERSION"),
    },
    slack: {
      botToken: reader.secret("SLACK_BOT_TOKEN"),
      apiBaseUrl: reader.text("SLACK_API_BASE_URL") ?? ENV_DEFAULTS.SLACK_API_BASE_URL,
    },
  };

  const problems = [...reader.problems];
  if (env.runtime.sandbox) problems.push(...sandboxEndpointProblems(env));
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, env: deepFreeze(env) };
}

export type DotenvResult =
  | { readonly ok: true; readonly environment: EnvironmentRecord }
  | { readonly ok: false; readonly problem: ConfigProblem };

/**
 * Merges the file named by DOTENV_PATH under the given environment: a
 * variable the environment sets (non-blank) always wins. The file's own
 * DOTENV_PATH is ignored. Neither the environment nor process.env is mutated.
 */
export function withDotenvFile(
  environment: EnvironmentRecord,
  options: { readonly cwd?: string; readonly readFile?: (path: string) => string } = {},
): DotenvResult {
  const named = environment.DOTENV_PATH?.trim() ?? "";
  if (named === "") return { ok: true, environment };
  const path = resolve(options.cwd ?? process.cwd(), named);
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  let content: string;
  try {
    content = readFile(path);
  } catch {
    return {
      ok: false,
      problem: { variable: "DOTENV_PATH", message: "names a file that could not be read." },
    };
  }
  const merged: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(parseEnv(content))) {
    if (name !== "DOTENV_PATH") merged[name] = value;
  }
  for (const [name, value] of Object.entries(environment)) {
    if ((value?.trim() ?? "") !== "" || merged[name] === undefined) merged[name] = value;
  }
  return { ok: true, environment: merged };
}

/** Every configured secret value in the snapshot, for the redactor. */
export function configuredSecrets(env: AgentEnv): string[] {
  const secrets = [
    env.model.apiKey,
    env.composio.apiKey,
    env.hubspot.accessToken,
    env.hubspot.mcpToken,
    env.stripe.secretKey,
    env.quickbooks.accessToken,
    env.slack.botToken,
  ];
  return secrets.flatMap((secret) => (secret === null ? [] : [secret.reveal()]));
}
