/**
 * Live and read-only: the real model answers a question about each connected
 * system from the headless CLI, exactly as a person would run it, against the
 * real account.
 *
 * - Each run receives only the model key and the variables of the system
 *   under test, so it reaches nothing else.
 * - Every action class except read is denied, so a Composio session is
 *   created with access "read" and offers no write tool, and every other
 *   write is refused before it reaches a system. Each run is capped at $0.50.
 * - The connections are checked read-only first, as the app's Check does. A
 *   system that is not connected or not configured is skipped with the reason
 *   (Connect it in Connections, or set its variables), or fails when
 *   LIVE_REQUIRE names it; nothing stands in for it.
 * - Replies and tool outputs hold real data: the log line carries counts and
 *   tool names only (see support.ts for LIVE_OUT_DIR).
 *
 * Runs only under `LIVE_E2E=1 pnpm test:live`.
 */
import { describe, expect, test } from "vitest";
import type { IntegrationId } from "../../src/contracts/integration.js";
import {
  agentEnvOf,
  askJson,
  cannotTest,
  checkLive,
  describeRun,
  liveEnvironment,
  liveStateDir,
  prepareWorkspace,
  RAN,
  READ_ONLY_POLICY,
  ranCalls,
  requireLive,
  type Scope,
  STOPPED,
  storedRun,
  unavailableReason,
} from "./support.js";

requireLive();

const BUDGET_USD = 0.5;

type Case = {
  readonly integration: IntegrationId;
  readonly scope: Scope;
  readonly prompt: string;
};

const CASES: readonly Case[] = [
  {
    integration: "gmail",
    scope: "composio",
    prompt:
      "What are the three most recent emails in my inbox about? Just summarise them; don't change anything.",
  },
  {
    integration: "google_calendar",
    scope: "composio",
    prompt:
      "What is on my primary Google Calendar in the next seven days? Just list it; don't change anything.",
  },
  {
    integration: "quickbooks",
    scope: "composio",
    prompt:
      "Which QuickBooks invoices are still open, and for how much? List at most ten; don't change anything.",
  },
  {
    integration: "slack",
    scope: "composio",
    prompt: "Which Slack channels can I see? List at most ten by name; don't post anything.",
  },
  {
    integration: "hubspot",
    scope: "hubspot",
    prompt:
      "List the five most recently created HubSpot contacts with their email. Don't change anything.",
  },
  {
    integration: "stripe",
    scope: "stripe",
    prompt:
      "What is my Stripe balance, and what are the three most recent charges? Don't change anything.",
  },
];

describe("live: the model reads each connected system, and changes nothing", () => {
  test.for(CASES)("$integration", async ({ integration, scope, prompt }, context) => {
    const state = liveStateDir(`read-${integration}`);
    context.onTestFinished(() => state.cleanup());
    const environment = liveEnvironment(state.dir, [scope], {
      AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
    });
    const connections = await checkLive(agentEnvOf(environment));
    const reason = unavailableReason(connections, integration);
    if (reason !== null) cannotTest(context, `live read ${integration}`, integration, reason);
    prepareWorkspace(state.dir, connections);

    const { run, summary } = await askJson({
      state,
      environment,
      prompt,
      policy: READ_ONLY_POLICY,
      budgetUsd: BUDGET_USD,
    });
    console.log(describeRun(`read ${integration}`, run, summary));

    expect(run.code, "exit code").toBe(0);
    expect(summary.status, "run status").toBe("completed");
    expect(summary.error, "run error").toBeNull();
    expect((summary.reply ?? "").trim().length, "reply length").toBeGreaterThan(0);
    expect(
      summary.connections.find((connection) => connection.integration === integration)
        ?.availability,
      `${integration} offered to the run`,
    ).toBe("ready");

    // At least one read of this system ran, and only reads ran.
    const ran = ranCalls(summary);
    expect(
      ran.filter((call) => call.integration === integration && call.actionClass === "read").length,
      `reads of ${integration} that ran`,
    ).toBeGreaterThan(0);
    expect(
      ran.filter((call) => call.actionClass !== "read").map((call) => call.tool),
      "calls that ran other than reads",
    ).toEqual([]);
    // Anything that could change something was stopped before it reached a system.
    expect(
      summary.toolCalls
        .filter((call) => call.actionClass !== "read" && !STOPPED.has(call.decision))
        .map((call) => `${call.tool}:${call.decision}`),
      "non-read calls that were not stopped",
    ).toEqual([]);

    // The database agrees: the headless run used the read-only policy, and
    // every call that succeeded is a read.
    const stored = storedRun(state.dir, summary.runId);
    expect(stored.run).toMatchObject({ source: "cli", mode: "headless", status: "completed" });
    expect(JSON.parse(stored.run?.policy_snapshot ?? "{}")).toMatchObject(READ_ONLY_POLICY);
    expect(
      stored.calls
        .filter((call) => call.status === "succeeded" && call.action_class !== "read")
        .map((call) => call.tool_name),
    ).toEqual([]);
    expect(stored.calls.filter((call) => RAN.has(call.decision)).length).toBe(ran.length);

    const cost = summary.usage?.costUsd ?? Number.NaN;
    expect(cost, "cost in USD").toBeGreaterThan(0);
    expect(cost, "cost in USD").toBeLessThan(BUDGET_USD);
  });
});
