// Configuration contract: every environment variable Revenue Desk reads, and
// the immutable AgentEnv snapshot built from them (docs/ARCHITECTURE.md §3).
//
// Names, groups and the snapshot shape only. Parsing and validation live in
// src/config/env.ts (W1); it reads process.env once at start and never
// mutates it. .env.example lists exactly these names, in this order
// (test/unit/contracts.test.ts checks it).
//
// No variable chooses where a service is reached: the vendor endpoints are
// pinned in code (src/integrations/shared/vendors.ts), so configuration can
// supply credentials but can never point Revenue Desk at another server.
//
// Shared by server, CLI and web: no Node-only globals, no implementation imports.

import type { IntegrationId, PolicyOverrides } from "./integration.js";

export type EnvVarSpec = {
  readonly group: "model" | "runtime" | IntegrationId;
  /** Secret values are wrapped in SecretValue and scrubbed by the redactor. */
  readonly secret: boolean;
  readonly description: string;
};

export const ENV_VARS = {
  // --- Model ------------------------------------------------------------------
  ANTHROPIC_API_KEY: {
    group: "model",
    secret: true,
    description: "Required to run the agent.",
  },
  AGENT_MODEL: {
    group: "model",
    secret: false,
    description: "Model id. Default claude-sonnet-5. No silent fallback.",
  },
  AGENT_EFFORT: {
    group: "model",
    secret: false,
    description: "low, medium, high, xhigh or max. Default medium.",
  },
  AGENT_THINKING_DISPLAY: {
    group: "model",
    secret: false,
    description: "summarized or omitted. Default summarized in the UI, omitted in the CLI.",
  },
  AGENT_MAX_TURNS: {
    group: "model",
    secret: false,
    description: "Turn limit per run. Default 30.",
  },
  AGENT_MAX_BUDGET_USD: {
    group: "model",
    secret: false,
    description: "Spend limit per run in USD. Default 2.00.",
  },
  // --- Runtime ----------------------------------------------------------------
  PORT: {
    group: "runtime",
    secret: false,
    description: "API server port, always bound to 127.0.0.1. Default 4320.",
  },
  AGENT_STATE_DIR: {
    group: "runtime",
    secret: false,
    description: "Database, work directory and Claude config. Default ./data (git-ignored).",
  },
  AGENT_POLICY: {
    group: "runtime",
    secret: false,
    description: 'JSON approval modes per action class, e.g. {"financial":"deny"}. Locks them.',
  },
  AGENT_APPROVAL_TIMEOUT_MS: {
    group: "runtime",
    secret: false,
    description: "How long a pending approval waits before it is denied. Default 900000.",
  },
  DOTENV_PATH: {
    group: "runtime",
    secret: false,
    description: "An env file outside the repository to load at start.",
  },
  // --- Gmail, Google Calendar, QuickBooks and Slack (Composio) ------------------
  COMPOSIO_API_KEY: {
    group: "gmail",
    secret: true,
    description: "Composio project key. Gmail, Google Calendar, QuickBooks and Slack need it.",
  },
  COMPOSIO_USER_ID: {
    group: "gmail",
    secret: false,
    description: "The Composio user whose connections are used. No default in code.",
  },
  // --- HubSpot (MCP) -------------------------------------------------------------
  HUBSPOT_ACCESS_TOKEN: {
    group: "hubspot",
    secret: true,
    description:
      "Private-app token for HubSpot's official @hubspot/mcp-server 0.4.x, run over stdio.",
  },
  // --- Stripe (API) ---------------------------------------------------------------
  STRIPE_SECRET_KEY: {
    group: "stripe",
    secret: true,
    description: "sk_test_/rk_test_ key. Live keys are refused unless ALLOW_LIVE_STRIPE=1.",
  },
  ALLOW_LIVE_STRIPE: {
    group: "stripe",
    secret: false,
    description: "Set to 1 to accept a live Stripe key.",
  },
  STRIPE_API_VERSION: {
    group: "stripe",
    secret: false,
    description: "Stripe-Version header. Default: the account's version.",
  },
} as const satisfies Record<string, EnvVarSpec>;

export type EnvVarName = keyof typeof ENV_VARS;

export const ENV_VAR_NAMES = Object.keys(ENV_VARS) as readonly EnvVarName[];

/**
 * Standard variables forwarded to the Claude CLI child when set, and never
 * otherwise read: an outbound proxy and the CLI's model retry count. They
 * are not app configuration, so .env.example omits them.
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
    readonly approvalTimeoutMs: number;
    readonly dotenvPath: string | null;
  };
  /** Forwarded to the Claude CLI child when set. */
  readonly passthrough: { readonly [V in SdkChildPassthroughVar]: string | null };
  readonly composio: {
    readonly apiKey: SecretValue | null;
    readonly userId: string | null;
  };
  readonly hubspot: {
    readonly accessToken: SecretValue | null;
  };
  readonly stripe: {
    readonly secretKey: SecretValue | null;
    readonly allowLive: boolean;
    readonly apiVersion: string | null;
  };
};
