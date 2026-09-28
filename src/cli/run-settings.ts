// The settings of one CLI run, after precedence (docs/ARCHITECTURE.md §3, §7),
// through the shared policy and model-settings rules. Pure functions.

import { dateInTimeZone, resolveModelSettings } from "../config/run-settings.js";
import type { AskCommand } from "../contracts/cli.js";
import type { AgentEnv, ModelSettings } from "../contracts/env.js";
import type { ConnectionPlan, RunConnection } from "../contracts/events.js";
import {
  INTEGRATIONS,
  type PolicyModes,
  type PolicyOverrides,
  type WorkspaceSettings,
} from "../contracts/integration.js";
import { resolvePolicy } from "../policy/engine.js";

export { dateInTimeZone };

/** Default, saved (Settings), AGENT_POLICY, then --policy: later layers win. */
export function effectivePolicy(
  saved: PolicyOverrides,
  environment: PolicyOverrides,
  run: PolicyOverrides,
): PolicyModes {
  return resolvePolicy({ saved, environment, run }).modes;
}

/**
 * Model settings: the CLI flag, then Settings (defaultModel, defaultEffort),
 * then the environment (which already holds the defaults). Thinking is
 * omitted in the CLI unless AGENT_THINKING_DISPLAY says otherwise.
 */
export function modelSettings(
  command: AskCommand,
  settings: Pick<WorkspaceSettings, "defaultModel" | "defaultEffort">,
  env: AgentEnv,
): ModelSettings {
  return resolveModelSettings({
    env,
    settings,
    surface: "cli",
    overrides: {
      model: command.model,
      effort: command.effort,
      maxTurns: command.maxTurns,
      maxBudgetUsd: command.maxBudgetUsd,
    },
  });
}

const TITLE_LIMIT = 80;

/** A conversation title from the prompt's first non-empty line. */
export function conversationTitle(prompt: string): string {
  const line =
    prompt
      .split(/\r?\n/)
      .map((candidate) => candidate.replace(/\s+/g, " ").trim())
      .find((candidate) => candidate !== "") ?? "";
  const characters = [...line];
  if (characters.length <= TITLE_LIMIT) return line;
  return `${characters
    .slice(0, TITLE_LIMIT - 1)
    .join("")
    .trimEnd()}…`;
}

/** What the run will report about each integration before the core says otherwise. */
export function plannedConnections(plans: readonly ConnectionPlan[]): RunConnection[] {
  return plans.map((plan) => {
    const { kind, profile } = INTEGRATIONS[plan.integration];
    if (plan.status === "available") {
      return {
        integration: plan.integration,
        kind,
        profile,
        availability: "ready",
        state: "connected",
        detail: null,
        endpointLabel: plan.connection.endpointLabel,
      };
    }
    return {
      integration: plan.integration,
      kind,
      profile,
      availability: "unavailable",
      state: plan.state,
      detail: plan.detail,
      endpointLabel: null,
    };
  });
}
