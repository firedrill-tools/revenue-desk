// Per-run settings derived from the snapshot and the workspace settings
// (docs/ARCHITECTURE.md §3): the model precedence and the business date.

import { type AgentEnv, ENV_DEFAULTS, type ModelSettings } from "../contracts/env.js";
import type { WorkspaceSettings } from "../contracts/integration.js";

/** Values a caller sets for one run (the CLI's flags). Null or absent means "not given". */
export type ModelOverrides = {
  readonly model?: string | null;
  readonly effort?: ModelSettings["effort"] | null;
  readonly maxTurns?: number | null;
  readonly maxBudgetUsd?: number | null;
};

/**
 * Model settings for one run: the caller's override, then Settings
 * (defaultModel, defaultEffort), then the environment, which already holds
 * the defaults. Thinking is summarized in the UI and omitted in the CLI
 * unless AGENT_THINKING_DISPLAY says otherwise.
 */
export function resolveModelSettings(input: {
  readonly env: AgentEnv;
  readonly settings: Pick<WorkspaceSettings, "defaultModel" | "defaultEffort">;
  readonly surface: "ui" | "cli";
  readonly overrides?: ModelOverrides;
}): ModelSettings {
  const { env, settings, overrides = {} } = input;
  const surfaceDisplay =
    input.surface === "ui" ? ENV_DEFAULTS.THINKING_DISPLAY_UI : ENV_DEFAULTS.THINKING_DISPLAY_CLI;
  return {
    model: overrides.model ?? settings.defaultModel ?? env.model.model,
    effort: overrides.effort ?? settings.defaultEffort ?? env.model.effort,
    thinkingDisplay: env.model.thinkingDisplay ?? surfaceDisplay,
    maxTurns: overrides.maxTurns ?? env.model.maxTurns,
    maxBudgetUsd: overrides.maxBudgetUsd ?? env.model.maxBudgetUsd,
  };
}

/**
 * YYYY-MM-DD of `now` in an IANA time zone. The business date a run states
 * as today is always this, in the workspace time zone; there is no
 * override. Throws RangeError for an unknown zone.
 */
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
