import { describe, expect, it } from "vitest";
import { loadAgentEnv } from "../../../src/config/env.js";
import { dateInTimeZone, resolveModelSettings } from "../../../src/config/run-settings.js";
import { ENV_VAR_NAMES } from "../../../src/contracts/env.js";
import type { WorkspaceSettings } from "../../../src/contracts/integration.js";
import { businessDate } from "../../../src/server/run-context.js";

function env(environment: Record<string, string> = {}) {
  const result = loadAgentEnv(environment, { cwd: "/" });
  if (!result.ok) throw new Error("unexpected problems");
  return result.env;
}

describe("resolveModelSettings", () => {
  it("uses the environment (with its defaults) when nothing else is set", () => {
    expect(
      resolveModelSettings({
        env: env(),
        settings: { defaultModel: null, defaultEffort: null },
        surface: "ui",
      }),
    ).toEqual({
      model: "claude-sonnet-5",
      effort: "medium",
      thinkingDisplay: "summarized",
      maxTurns: 30,
      maxBudgetUsd: 2,
    });
  });

  it("prefers the run's override, then Settings, then the environment", () => {
    const snapshot = env({ AGENT_MODEL: "env-model", AGENT_EFFORT: "low", AGENT_MAX_TURNS: "9" });
    const settings = { defaultModel: "settings-model", defaultEffort: "high" as const };
    expect(resolveModelSettings({ env: snapshot, settings, surface: "cli" })).toMatchObject({
      model: "settings-model",
      effort: "high",
      thinkingDisplay: "omitted",
      maxTurns: 9,
    });
    expect(
      resolveModelSettings({
        env: snapshot,
        settings,
        surface: "cli",
        overrides: { model: "flag-model", effort: "max", maxTurns: 3, maxBudgetUsd: 0.25 },
      }),
    ).toMatchObject({ model: "flag-model", effort: "max", maxTurns: 3, maxBudgetUsd: 0.25 });
  });

  it("lets AGENT_THINKING_DISPLAY override the surface default", () => {
    const snapshot = env({ AGENT_THINKING_DISPLAY: "omitted" });
    const settings = { defaultModel: null, defaultEffort: null };
    expect(resolveModelSettings({ env: snapshot, settings, surface: "ui" }).thinkingDisplay).toBe(
      "omitted",
    );
  });
});

describe("business date", () => {
  const instant = new Date("2026-09-29T02:30:00.000Z");

  it("is today in the workspace time zone", () => {
    expect(dateInTimeZone(instant, "America/New_York")).toBe("2026-09-28");
    expect(dateInTimeZone(instant, "Asia/Tokyo")).toBe("2026-09-29");
  });

  it("has no override: AGENT_BUSINESS_DATE is not configuration and changes nothing", () => {
    expect(ENV_VAR_NAMES).not.toContain("AGENT_BUSINESS_DATE");
    expect(env({ AGENT_BUSINESS_DATE: "2026-01-15" })).toEqual(env());
    const settings = { timezone: "America/New_York" } as WorkspaceSettings;
    expect(businessDate(settings, instant)).toBe("2026-09-28");
    // A time zone written some other way falls back to UTC.
    expect(businessDate({ timezone: "Mars/Olympus" } as WorkspaceSettings, instant)).toBe(
      "2026-09-29",
    );
  });

  it("refuses an unknown time zone", () => {
    expect(() => dateInTimeZone(instant, "Mars/Olympus")).toThrow(RangeError);
  });
});
