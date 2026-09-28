// The settings of one CLI run, after precedence (docs/ARCHITECTURE.md §3, §7).
// Pure functions.

import type { AskCommand } from "../contracts/cli.js";
import { type AgentEnv, ENV_DEFAULTS, type ModelSettings } from "../contracts/env.js";
import type { ConnectionPlan, RunConnection } from "../contracts/events.js";
import {
  ACTION_CLASSES,
  DEFAULT_POLICY,
  INTEGRATIONS,
  type PolicyModes,
  type PolicyOverrides,
  type WorkspaceSettings,
} from "../contracts/integration.js";

/** Later layers win: default, saved (Settings), AGENT_POLICY, then --policy. */
export function effectivePolicy(...layers: readonly PolicyOverrides[]): PolicyModes {
  const modes = { ...DEFAULT_POLICY };
  for (const actionClass of ACTION_CLASSES) {
    for (const layer of layers) {
      const mode = layer[actionClass];
      if (mode !== undefined) modes[actionClass] = mode;
    }
  }
  return modes;
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
  return {
    model: command.model ?? settings.defaultModel ?? env.model.model,
    effort: command.effort ?? settings.defaultEffort ?? env.model.effort,
    thinkingDisplay: env.model.thinkingDisplay ?? ENV_DEFAULTS.THINKING_DISPLAY_CLI,
    maxTurns: command.maxTurns ?? env.model.maxTurns,
    maxBudgetUsd: command.maxBudgetUsd ?? env.model.maxBudgetUsd,
  };
}

/** YYYY-MM-DD of `now` in an IANA time zone. Throws RangeError for an unknown zone. */
export function dateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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
