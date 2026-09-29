// What an interactive run needs besides its ids (docs/ARCHITECTURE.md §3, §7):
// the workspace settings, the model settings after precedence, the effective
// policy, the business date and one connection plan per integration. The
// precedence rules are the configuration's and the policy's, shared with the CLI.

import { dateInTimeZone, resolveModelSettings } from "../config/run-settings.js";
import type { AgentEnv, ModelSettings } from "../contracts/env.js";
import type { ConnectionPlan, RunConnection } from "../contracts/events.js";
import type { PolicyModes, WorkspaceSettings } from "../contracts/integration.js";
import { readSavedPolicies } from "../db/repos/policies.js";
import { readSettings } from "../db/repos/settings.js";
import type { DbExecutor } from "../db/repos/types.js";
import { resolvePolicy } from "../policy/engine.js";
import type { ConnectionService } from "./connections.js";

export type RunContext = {
  readonly settings: WorkspaceSettings;
  readonly model: ModelSettings;
  readonly policy: PolicyModes;
  readonly businessDate: string;
  readonly connections: readonly ConnectionPlan[];
  /** The same availability as RunConnection rows, for the runs table before run.started. */
  readonly connectionSnapshot: readonly RunConnection[];
};

/** Settings (defaultModel, defaultEffort), then the environment; thinking summarized. */
export function uiModelSettings(env: AgentEnv, settings: WorkspaceSettings): ModelSettings {
  return resolveModelSettings({ env, settings, surface: "ui" });
}

/**
 * Today in the workspace time zone. Settings refuses unknown zones; a row
 * written some other way falls back to UTC.
 */
export function businessDate(settings: WorkspaceSettings, now: Date): string {
  try {
    return dateInTimeZone(now, settings.timezone);
  } catch {
    return dateInTimeZone(now, "UTC");
  }
}

export function effectiveRunPolicy(db: DbExecutor, env: AgentEnv): PolicyModes {
  return resolvePolicy({ saved: readSavedPolicies(db), environment: env.runtime.policyOverrides })
    .modes;
}

export function prepareRunContext(input: {
  readonly db: DbExecutor;
  readonly env: AgentEnv;
  readonly connections: ConnectionService;
  readonly now: Date;
}): RunContext {
  const settings = readSettings(input.db);
  const { plans, snapshot } = input.connections.plans();
  return {
    settings,
    model: uiModelSettings(input.env, settings),
    policy: effectiveRunPolicy(input.db, input.env),
    businessDate: businessDate(settings, input.now),
    connections: plans,
    connectionSnapshot: snapshot,
  };
}
