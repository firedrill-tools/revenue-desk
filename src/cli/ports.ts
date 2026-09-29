// What `revenue-desk ask` needs from the agent core (W1), the integrations
// (W2) and the database (W3). The CLI imports no implementation module
// directly: src/cli/services.ts wires them.
//
// Types only; no runtime code.

import type { ConversationStatus } from "../contracts/api.js";
import type { AgentEnv, ConfigProblem } from "../contracts/env.js";
import type { AgentEvent, ConnectionPlan, RunTurn, RunTurnInput } from "../contracts/events.js";
import type { PolicyModes, PolicyOverrides, WorkspaceSettings } from "../contracts/integration.js";

/**
 * Environment variables as the CLI hands them to the configuration layer:
 * process.env, then the DOTENV_PATH file for variables the environment leaves
 * unset or empty, then --state-dir as AGENT_STATE_DIR.
 */
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

/** The configuration snapshot, or the problems that refuse it (names and reasons, never values). */
export type ConfigResult =
  | { readonly ok: true; readonly env: AgentEnv }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export type ConversationRecord = {
  readonly id: string;
  readonly status: ConversationStatus;
  /** The Agent SDK session to resume; null before the first turn. */
  readonly sdkSessionId: string | null;
};

/** Persists one run from its events: the same rows the server writes. */
export interface RunRecorder {
  /**
   * Applies one event, in stream order. The last event is always exactly one
   * `run.finished`: the CLI synthesises it when the core ends without one
   * (a forced stop, a thrown error), so the run row never stays `running`.
   */
  record(event: AgentEvent): void | Promise<void>;
}

/** The state directory's database, opened for one CLI invocation. */
export interface CliWorkspace {
  settings(): WorkspaceSettings;
  /** Modes saved in the policies table: no defaults, no AGENT_POLICY. */
  savedPolicy(): PolicyOverrides;
  /** Null when the state directory has no such conversation. */
  findConversation(id: string): ConversationRecord | null;
  /** A new conversation with source "cli". The id is the CLI's. */
  createConversation(conversation: {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
  }): ConversationRecord;
  /**
   * Writes the user message and the run row (status running, source "cli")
   * and returns the recorder for the run's events. Throws when the
   * conversation already has an active run.
   */
  beginRun(input: RunTurnInput): RunRecorder | Promise<RunRecorder>;
  close(): void;
}

export type ConnectionPlanRequest = {
  readonly env: AgentEnv;
  /** The run's effective policy (it decides the Composio session exposure). */
  readonly policy: PolicyModes;
  readonly signal: AbortSignal;
};

/** Everything the CLI calls. One instance serves one invocation. */
export interface AskServices {
  /**
   * W1, src/config/env.ts: build the immutable snapshot; a relative
   * AGENT_STATE_DIR resolves against `cwd`. Never contacts anything.
   */
  loadConfig(environment: EnvironmentRecord, options: { readonly cwd: string }): ConfigResult;
  /** W1, src/config/redact.ts: scrubs configured secret values and token patterns. */
  createRedactor(env: AgentEnv): (text: string) => string;
  /** W3, src/db: opens <env.runtime.stateDir>/revenue-desk.sqlite and applies migrations. */
  openWorkspace(env: AgentEnv): CliWorkspace;
  /** W2, src/integrations/registry.ts: one plan per integration, ready or unavailable. */
  planConnections(request: ConnectionPlanRequest): Promise<readonly ConnectionPlan[]>;
  /** W1, src/agent/run-turn.ts. */
  readonly runTurn: RunTurn;
}
