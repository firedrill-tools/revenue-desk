/**
 * Live write, HubSpot over MCP, a test account only: the agent creates a
 * task through the official HubSpot MCP server.
 *
 * Refuses (skips with the reason) unless HUBSPOT_ACCESS_TOKEN is set and
 * HubSpot reports the account as a developer test account or a sandbox; a
 * standard account is never written to. Internal writes run without asking;
 * nothing else that writes does. The test finds the task by its subject and
 * deletes it.
 *
 * Runs only under `LIVE_E2E=1 LIVE_E2E_WRITES=1 pnpm test:live:writes`.
 */
import { describe, expect, it } from "vitest";
import {
  agentEnvOf,
  askJson,
  checkLive,
  describeRun,
  liveEnvironment,
  liveMarker,
  liveStateDir,
  liveValue,
  type Policy,
  prepareWorkspace,
  ranCalls,
  requireLiveWrites,
  unavailableReason,
} from "../support.js";
import { HUBSPOT_TEST_ACCOUNT_TYPES, hubspotApi } from "./support.js";

requireLiveWrites();

const BUDGET_USD = 0.5;
const NOTE_POLICY: Policy = {
  read: "auto",
  internal_write: "auto",
  outbound: "deny",
  financial: "deny",
  destructive: "deny",
};

type SearchResult = { results?: { id: string }[] };

async function tasksWithSubject(subject: string): Promise<string[]> {
  const found = (await hubspotApi("POST", "/crm/v3/objects/tasks/search", {
    filterGroups: [
      { filters: [{ propertyName: "hs_task_subject", operator: "EQ", value: subject }] },
    ],
    limit: 10,
  })) as SearchResult | null;
  return (found?.results ?? []).map((task) => task.id);
}

describe("live write: HubSpot, on a test account only", () => {
  it("creates a task through the MCP server", async (context) => {
    if (liveValue("HUBSPOT_ACCESS_TOKEN") === null) {
      const reason = "HUBSPOT_ACCESS_TOKEN is not set: the account type cannot be checked.";
      console.log(`live write hubspot: skipped. ${reason}`);
      context.skip(reason);
    }
    const account = await hubspotApi("GET", "/account-info/v3/details");
    const accountType = String(account?.accountType ?? "unknown");
    if (!HUBSPOT_TEST_ACCOUNT_TYPES.has(accountType)) {
      const reason = `Refused: the HubSpot account type is ${accountType}, not a developer test account or a sandbox.`;
      console.log(`live write hubspot: skipped. ${reason}`);
      context.skip(reason);
    }

    const state = liveStateDir("write-hubspot");
    context.onTestFinished(() => state.cleanup());
    const environment = liveEnvironment(state.dir, ["hubspot"], {
      AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
    });
    const connections = await checkLive(agentEnvOf(environment));
    const reason = unavailableReason(connections, "hubspot");
    if (reason !== null) context.skip(reason);
    prepareWorkspace(state.dir, connections);

    const subject = `Revenue Desk live test ${liveMarker()}`;
    context.onTestFinished(async () => {
      for (const id of await tasksWithSubject(subject)) {
        await hubspotApi("DELETE", `/crm/v3/objects/tasks/${id}`);
      }
    });

    const { run, summary } = await askJson({
      state,
      environment,
      policy: NOTE_POLICY,
      budgetUsd: BUDGET_USD,
      prompt:
        `Create one HubSpot task with the subject "${subject}", due tomorrow at 09:00 UTC, ` +
        "not associated with any record. Do nothing else.",
    });
    console.log(describeRun("write hubspot", run, summary));
    expect(run.code, "exit code").toBe(0);
    expect(summary.status).toBe("completed");
    const writes = ranCalls(summary).filter((call) => call.actionClass !== "read");
    expect(writes.map((call) => [call.tool, call.decision, call.isError])).toEqual([
      ["mcp__hubspot__hubspot-batch-create-objects", "auto", false],
    ]);

    // HubSpot agrees: the task exists. (Search is eventually consistent.)
    await expect
      .poll(() => tasksWithSubject(subject), { timeout: 30_000, interval: 2_000 })
      .toHaveLength(1);
  });
});
