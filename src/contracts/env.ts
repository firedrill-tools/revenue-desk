// Configuration contract: every environment variable Revenue Desk reads, and
// the immutable AgentEnv snapshot built from them (docs/ARCHITECTURE.md §3).
//
// Names, groups and the snapshot shape only. Parsing and validation live in
// src/config/env.ts (W1); it reads process.env once at start and never
// mutates it. .env.example lists exactly these names, in this order
// (test/unit/contracts.test.ts checks it).
//
// Shared by server, CLI and web: no Node-only globals, no implementation imports.

import type { IntegrationId, PolicyOverrides } from "./integration.js";

export type EnvVarSpec = {
  readonly group: "model" | "runtime" | IntegrationId;
  /** Secret values are wrapped in SecretValue and scrubbed by the redactor. */
  readonly secret: boolean;
  /** "test" variables exist for tests and the sandbox demo; production leaves them unset. */
  readonly scope: "product" | "test";
  readonly description: string;
};

export const ENV_VARS = {
  // --- Model ------------------------------------------------------------------
  ANTHROPIC_API_KEY: {
    group: "model",
    secret: true,
    scope: "product",
    description: "Required to run the agent.",
  },
  ANTHROPIC_BASE_URL: {
    group: "model",
    secret: false,
    scope: "test",
    description: "Messages API base URL; tests point it at the local scripted API.",
  },
  AGENT_MODEL: {
    group: "model",
    secret: false,
    scope: "product",
    description: "Model id. Default claude-sonnet-5. No silent fallback.",
  },
  AGENT_EFFORT: {
    group: "model",
    secret: false,
    scope: "product",
    description: "low, medium, high, xhigh or max. Default medium.",
  },
  AGENT_THINKING_DISPLAY: {
    group: "model",
    secret: false,
    scope: "product",
    description: "summarized or omitted. Default summarized in the UI, omitted in the CLI.",
  },
  AGENT_MAX_TURNS: {
    group: "model",
    secret: false,
    scope: "product",
    description: "Turn limit per run. Default 30.",
  },
  AGENT_MAX_BUDGET_USD: {
    group: "model",
    secret: false,
    scope: "product",
    description: "Spend limit per run in USD. Default 2.00.",
  },
  // --- Runtime ----------------------------------------------------------------
  PORT: {
    group: "runtime",
    secret: false,
    scope: "product",
    description: "API server port, always bound to 127.0.0.1. Default 4320.",
  },
  AGENT_STATE_DIR: {
    group: "runtime",
    secret: false,
    scope: "product",
    description: "Database, work directory and Claude config. Default ./data (git-ignored).",
  },
  AGENT_POLICY: {
    group: "runtime",
    secret: false,
    scope: "product",
    description: 'JSON approval modes per action class, e.g. {"financial":"deny"}. Locks them.',
  },
  AGENT_BUSINESS_DATE: {
    group: "runtime",
    secret: false,
    scope: "product",
    description: "YYYY-MM-DD the agent treats as today. Default: today in the workspace time zone.",
  },
  AGENT_APPROVAL_TIMEOUT_MS: {
    group: "runtime",
    secret: false,
    scope: "product",
    description: "How long a pending approval waits before it is denied. Default 900000.",
  },
  AGENT_SANDBOX: {
    group: "runtime",
    secret: false,
    scope: "test",
    description:
      "Set to 1 only by pnpm dev:sandbox: labels the app 'Local sandbox' and refuses any non-loopback endpoint.",
  },
  DOTENV_PATH: {
    group: "runtime",
    secret: false,
    scope: "product",
    description: "An env file outside the repository to load at start.",
  },
  // --- Gmail and Google Calendar (Composio) ------------------------------------
  COMPOSIO_API_KEY: {
    group: "gmail",
    secret: true,
    scope: "product",
    description: "Composio project key. Gmail and Google Calendar need it.",
  },
  COMPOSIO_USER_ID: {
    group: "gmail",
    secret: false,
    scope: "product",
    description: "The Composio user whose connections are used. No default in code.",
  },
  COMPOSIO_BASE_URL: {
    group: "gmail",
    secret: false,
    scope: "product",
    description: "Composio API base URL. Default https://backend.composio.dev.",
  },
  // --- HubSpot (MCP) -------------------------------------------------------------
  HUBSPOT_ACCESS_TOKEN: {
    group: "hubspot",
    secret: true,
    scope: "product",
    description: "Private-app token for the bundled @hubspot/mcp-server over stdio.",
  },
  HUBSPOT_API_BASE_URL: {
    group: "hubspot",
    secret: false,
    scope: "product",
    description:
      "HubSpot API base URL for the stdio server (BASE_URL_OVERRIDE). Default: the server's.",
  },
  HUBSPOT_MCP_URL: {
    group: "hubspot",
    secret: false,
    scope: "product",
    description: "Any Streamable HTTP MCP server for HubSpot; replaces the stdio server when set.",
  },
  HUBSPOT_MCP_TOKEN: {
    group: "hubspot",
    secret: true,
    scope: "product",
    description: "Bearer token for HUBSPOT_MCP_URL.",
  },
  HUBSPOT_MCP_COMMAND: {
    group: "hubspot",
    secret: false,
    scope: "test",
    description: "Replaces the stdio command (tests).",
  },
  HUBSPOT_MCP_ARGS: {
    group: "hubspot",
    secret: false,
    scope: "test",
    description: "JSON array of arguments for HUBSPOT_MCP_COMMAND (tests).",
  },
  // --- Stripe (API) ---------------------------------------------------------------
  STRIPE_SECRET_KEY: {
    group: "stripe",
    secret: true,
    scope: "product",
    description: "sk_test_/rk_test_ key. Live keys are refused unless ALLOW_LIVE_STRIPE=1.",
  },
  ALLOW_LIVE_STRIPE: {
    group: "stripe",
    secret: false,
    scope: "product",
    description: "Set to 1 to accept a live Stripe key.",
  },
  STRIPE_API_BASE_URL: {
    group: "stripe",
    secret: false,
    scope: "product",
    description: "Default https://api.stripe.com. A path prefix is kept.",
  },
  STRIPE_API_VERSION: {
    group: "stripe",
    secret: false,
    scope: "product",
    description: "Stripe-Version header. Default: the account's version.",
  },
  // --- QuickBooks Online (API) -----------------------------------------------------
  QBO_ACCESS_TOKEN: {
    group: "quickbooks",
    secret: true,
    scope: "product",
    description: "OAuth access token (expires hourly).",
  },
  QBO_REALM_ID: {
    group: "quickbooks",
    secret: false,
    scope: "product",
    description: "Company (realm) id.",
  },
  QBO_API_BASE_URL: {
    group: "quickbooks",
    secret: false,
    scope: "product",
    description: "Default https://sandbox-quickbooks.api.intuit.com. A path prefix is kept.",
  },
  QBO_MINOR_VERSION: {
    group: "quickbooks",
    secret: false,
    scope: "product",
    description: "minorversion query parameter. Default: omitted.",
  },
  // --- Slack (API) -------------------------------------------------------------------
  SLACK_BOT_TOKEN: {
    group: "slack",
    secret: true,
    scope: "product",
    description: "Bot token (xoxb-).",
  },
  SLACK_API_BASE_URL: {
    group: "slack",
    secret: false,
    scope: "product",
    description: "Default https://slack.com. A path prefix is kept.",
  },
} as const satisfies Record<string, EnvVarSpec>;

export type EnvVarName = keyof typeof ENV_VARS;

export const ENV_VAR_NAMES = Object.keys(ENV_VARS) as readonly EnvVarName[];

/**
 * Standard variables forwarded to the Claude CLI child when set, and never
 * otherwise read. Tests use them to trap non-loopback traffic and disable
 * model retries. They are not app configuration, so .env.example omits them.
 */
export const SDK_CHILD_PASSTHROUGH_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "CLAUDE_CODE_MAX_RETRIES",
] as const;
export type SdkChildPassthroughVar = (typeof SDK_CHILD_PASSTHROUGH_VARS)[number];

// ---------------------------------------------------------------------------
// Defaults and fixed layout
// ---------------------------------------------------------------------------

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Equal to the Agent SDK's EffortLevel (checked in test/unit/contracts.test.ts). */
export type AgentEffort = (typeof EFFORT_LEVELS)[number];

export type ThinkingDisplay = "summarized" | "omitted";

export const ENV_DEFAULTS = {
  AGENT_MODEL: "claude-sonnet-5",
  AGENT_EFFORT: "medium",
  /** Used when AGENT_THINKING_DISPLAY is unset. */
  THINKING_DISPLAY_UI: "summarized",
  THINKING_DISPLAY_CLI: "omitted",
  AGENT_MAX_TURNS: 30,
  AGENT_MAX_BUDGET_USD: 2,
  PORT: 4320,
  AGENT_STATE_DIR: "./data",
  AGENT_APPROVAL_TIMEOUT_MS: 900_000,
  COMPOSIO_BASE_URL: "https://backend.composio.dev",
  STRIPE_API_BASE_URL: "https://api.stripe.com",
  QBO_API_BASE_URL: "https://sandbox-quickbooks.api.intuit.com",
  SLACK_API_BASE_URL: "https://slack.com",
} as const satisfies {
  readonly AGENT_EFFORT: AgentEffort;
  readonly THINKING_DISPLAY_UI: ThinkingDisplay;
  readonly THINKING_DISPLAY_CLI: ThinkingDisplay;
  readonly [key: string]: string | number;
};

/** Paths inside AGENT_STATE_DIR. The server and the CLI share one state directory. */
export const STATE_LAYOUT = {
  database: "revenue-desk.sqlite",
  /** The Claude CLI's cwd. */
  work: "work",
  /** HOME for the Claude CLI child. */
  home: "home",
  /** CLAUDE_CONFIG_DIR, which also holds SDK sessions used for resume. */
  claudeConfig: "claude",
} as const;

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * A configured secret. Implementations return "[redacted]" from toString(),
 * toJSON() and util.inspect, so logging or serialising a snapshot never leaks
 * a value; only reveal() yields it, at the point of use.
 */
export interface SecretValue {
  reveal(): string;
  toString(): string;
  toJSON(): string;
}

/** A configuration value that was present but refused. Never contains the value. */
export type ConfigProblem = {
  readonly variable: EnvVarName;
  readonly message: string;
};

/** The model settings for one run, after precedence (CLI flag, Settings, env, default). */
export type ModelSettings = {
  readonly model: string;
  readonly effort: AgentEffort;
  readonly thinkingDisplay: ThinkingDisplay;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
};

/**
 * Immutable configuration snapshot, read once at start. Unset optional values
 * are null; defaults from ENV_DEFAULTS are already applied. Integration
 * sections hold raw configuration: IntegrationDefinition.resolve() decides
 * whether it is configured, missing or invalid.
 */
export type AgentEnv = {
  readonly model: {
    readonly apiKey: SecretValue | null;
    readonly baseUrl: string | null;
    readonly model: string;
    readonly effort: AgentEffort;
    /** null: summarized in the UI, omitted in the CLI. */
    readonly thinkingDisplay: ThinkingDisplay | null;
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
  };
  readonly runtime: {
    readonly port: number;
    /** Absolute path. */
    readonly stateDir: string;
    /** From AGENT_POLICY; these classes are locked in the Settings screen. */
    readonly policyOverrides: PolicyOverrides;
    /** YYYY-MM-DD, or null for today in the workspace time zone. */
    readonly businessDate: string | null;
    readonly approvalTimeoutMs: number;
    /** AGENT_SANDBOX=1: the labelled local sandbox demo. */
    readonly sandbox: boolean;
    readonly dotenvPath: string | null;
  };
  /** Forwarded to the Claude CLI child when set. */
  readonly passthrough: { readonly [V in SdkChildPassthroughVar]: string | null };
  readonly composio: {
    readonly apiKey: SecretValue | null;
    readonly userId: string | null;
    readonly baseUrl: string;
  };
  readonly hubspot: {
    readonly accessToken: SecretValue | null;
    readonly apiBaseUrl: string | null;
    readonly mcpUrl: string | null;
    readonly mcpToken: SecretValue | null;
    readonly command: { readonly command: string; readonly args: readonly string[] } | null;
  };
  readonly stripe: {
    readonly secretKey: SecretValue | null;
    readonly allowLive: boolean;
    readonly apiBaseUrl: string;
    readonly apiVersion: string | null;
  };
  readonly quickbooks: {
    readonly accessToken: SecretValue | null;
    readonly realmId: string | null;
    readonly apiBaseUrl: string;
    readonly minorVersion: string | null;
  };
  readonly slack: {
    readonly botToken: SecretValue | null;
    readonly apiBaseUrl: string;
  };
};
