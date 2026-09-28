// query() options for one turn (docs/ARCHITECTURE.md §5 "Agent core").
//
// The Claude CLI child runs isolated: no settings sources, no built-in
// tools, only the gateway's servers, its own HOME, CLAUDE_CONFIG_DIR and
// working directory under the state directory, and an explicit environment
// allowlist that replaces the parent's environment (so no integration secret
// reaches it). canUseTool is the single policy point: no allowedTools, which
// would skip it. There is no fallbackModel: the configured model is what runs.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentEnv,
  type ModelSettings,
  SDK_CHILD_PASSTHROUGH_VARS,
  STATE_LAYOUT,
} from "../contracts/env.js";

export type StateDirectories = {
  /** The Claude CLI's cwd. */
  readonly work: string;
  /** HOME for the child. */
  readonly home: string;
  /** CLAUDE_CONFIG_DIR; holds the SDK sessions used for resume. */
  readonly claudeConfig: string;
};

export function stateDirectories(stateDir: string): StateDirectories {
  return {
    work: join(stateDir, STATE_LAYOUT.work),
    home: join(stateDir, STATE_LAYOUT.home),
    claudeConfig: join(stateDir, STATE_LAYOUT.claudeConfig),
  };
}

/** Creates the child's directories (idempotent). */
export function prepareStateDirectories(stateDir: string): StateDirectories {
  const directories = stateDirectories(stateDir);
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
  return directories;
}

/**
 * The child's whole environment. Nothing is inherited: PATH comes from the
 * host, HOME and CLAUDE_CONFIG_DIR point into the state directory, the model
 * key is the only secret, and the proxy/retry passthrough variables are
 * forwarded only when set.
 */
export function childEnvironment(input: {
  readonly env: AgentEnv;
  readonly directories: StateDirectories;
  readonly hostPath: string;
  /** CLAUDE_AGENT_SDK_CLIENT_APP, e.g. "revenue-desk/1.2.0". */
  readonly clientApp: string;
}): Record<string, string> {
  const { env, directories } = input;
  const child: Record<string, string> = {
    PATH: input.hostPath,
    HOME: directories.home,
    CLAUDE_CONFIG_DIR: directories.claudeConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_AGENT_SDK_CLIENT_APP: input.clientApp,
  };
  if (env.model.apiKey !== null) child.ANTHROPIC_API_KEY = env.model.apiKey.reveal();
  if (env.model.baseUrl !== null) child.ANTHROPIC_BASE_URL = env.model.baseUrl;
  for (const name of SDK_CHILD_PASSTHROUGH_VARS) {
    const value = env.passthrough[name];
    if (value !== null) child[name] = value;
  }
  return child;
}

export type QueryOptionsInput = {
  readonly env: AgentEnv;
  readonly model: ModelSettings;
  readonly directories: StateDirectories;
  /** From buildSystemPrompt(): stable rules, the dynamic boundary, then the run's part. */
  readonly systemPrompt: readonly string[];
  readonly mcpServers: Record<string, McpServerConfig>;
  readonly canUseTool: CanUseTool;
  readonly preToolUse: HookCallback;
  readonly resumeSessionId: string | null;
  readonly abortController: AbortController;
  readonly hostPath: string;
  readonly clientApp: string;
  readonly stderr?: (data: string) => void;
};

export function buildQueryOptions(input: QueryOptionsInput): Options {
  return {
    model: input.model.model,
    effort: input.model.effort,
    thinking: { type: "adaptive", display: input.model.thinkingDisplay },
    maxTurns: input.model.maxTurns,
    maxBudgetUsd: input.model.maxBudgetUsd,
    cwd: input.directories.work,
    settingSources: [],
    tools: [],
    strictMcpConfig: true,
    includePartialMessages: true,
    permissionMode: "default",
    // The prompt carries the run's date and systems, so it is rendered fresh
    // for every request instead of being recorded with the session.
    systemPrompt: { type: "custom", prompt: [...input.systemPrompt], snapshot: false },
    mcpServers: input.mcpServers,
    canUseTool: input.canUseTool,
    hooks: { PreToolUse: [{ hooks: [input.preToolUse] }] },
    ...(input.resumeSessionId === null ? {} : { resume: input.resumeSessionId }),
    abortController: input.abortController,
    env: childEnvironment({
      env: input.env,
      directories: input.directories,
      hostPath: input.hostPath,
      clientApp: input.clientApp,
    }),
    ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
  };
}
