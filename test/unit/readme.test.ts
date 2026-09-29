/**
 * README.md stays true to the contracts: its configuration table is
 * generated from ENV_VARS (src/contracts/env.ts), and it documents every CLI
 * flag and exit code (src/contracts/cli.ts).
 *
 * To regenerate the table after changing ENV_VARS:
 *   UPDATE_README=1 pnpm vitest run test/unit/readme.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_FLAGS, CLI_EXIT_CODES } from "../../src/contracts/cli.js";
import { ENV_VAR_NAMES, ENV_VARS, type EnvVarSpec } from "../../src/contracts/env.js";
import { INTEGRATIONS } from "../../src/contracts/integration.js";

const README = new URL("../../README.md", import.meta.url);
const START =
  "<!-- env-table:start: generated from src/contracts/env.ts by test/unit/readme.test.ts -->";
const END = "<!-- env-table:end -->";

const GROUP_LABEL: { readonly [G in EnvVarSpec["group"]]: string } = {
  model: "Model",
  runtime: "Runtime",
  gmail: "Composio (Gmail, Google Calendar, QuickBooks, Slack)",
  google_calendar: INTEGRATIONS.google_calendar.label,
  hubspot: INTEGRATIONS.hubspot.label,
  stripe: INTEGRATIONS.stripe.label,
  quickbooks: INTEGRATIONS.quickbooks.label,
  slack: INTEGRATIONS.slack.label,
};

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** The configuration table: names and meanings, never values. */
function renderEnvTable(): string {
  const rows = ENV_VAR_NAMES.map((name) => {
    const spec: EnvVarSpec = ENV_VARS[name];
    return `| \`${name}\` | ${GROUP_LABEL[spec.group]} | ${spec.secret ? "yes" : ""} | ${cell(
      spec.description,
    )} |`;
  });
  return ["| Variable | Group | Secret | Meaning |", "|---|---|---|---|", ...rows].join("\n");
}

function readme(): string {
  return readFileSync(README, "utf8");
}

describe("README.md", () => {
  it("has the configuration table generated from src/contracts/env.ts", () => {
    const text = readme();
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    expect(start, "README.md lacks the env-table markers").toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const current = text.slice(start + START.length, end).trim();
    const expected = renderEnvTable();
    if (current !== expected && process.env.UPDATE_README === "1") {
      writeFileSync(
        README,
        `${text.slice(0, start + START.length)}\n${expected}\n${text.slice(end)}`,
      );
      return;
    }
    expect(current).toBe(expected);
  });

  it("documents every CLI flag and exit code", () => {
    const text = readme();
    for (const flag of Object.values(ASK_FLAGS)) expect(text).toContain(`\`${flag}`);
    for (const code of Object.values(CLI_EXIT_CODES))
      expect(text).toMatch(new RegExp(`\\| ${code} \\|`));
  });

  it("contains no test-platform content", () => {
    expect(readme()).not.toMatch(/firedrill/i);
  });
});
