/**
 * Live write, QuickBooks through Composio, a sandbox company only: the agent
 * creates a customer (no opening balance) in the connected company.
 *
 * Refuses (skips with the reason, or fails when LIVE_REQUIRE names
 * quickbooks) unless every active QuickBooks account of
 * the Composio user has Intuit's sandbox server
 * (https://sandbox-quickbooks.api.intuit.com) as its base URL
 * (quickbooks-sandbox.ts); a real company is never written to. QuickBooks
 * does not delete customers and Composio's toolkit cannot make one inactive,
 * so the customer stays in the sandbox company, named with the test's marker.
 *
 * Runs only under `LIVE_E2E=1 LIVE_E2E_WRITES=1 pnpm test:live:writes`.
 */
import { describe, expect, it } from "vitest";
import {
  agentEnvOf,
  askJson,
  cannotTest,
  checkLive,
  describeRun,
  liveEnvironment,
  liveMarker,
  liveStateDir,
  type Policy,
  prepareWorkspace,
  ranCalls,
  requireLiveWrites,
  unavailableReason,
} from "../support.js";
import { quickBooksWriteRefusal } from "./quickbooks-sandbox.js";
import { composioTool, connectedAccounts, objectsMentioning } from "./support.js";

requireLiveWrites();

const BUDGET_USD = 0.5;
/** A customer without an opening balance is an internal write; nothing else writes. */
const CUSTOMER_POLICY: Policy = {
  read: "auto",
  internal_write: "auto",
  outbound: "deny",
  financial: "deny",
  destructive: "deny",
};

describe("live write: QuickBooks, in a sandbox company only", () => {
  it("creates a customer", async (context) => {
    const state = liveStateDir("write-quickbooks");
    context.onTestFinished(() => state.cleanup());
    const environment = liveEnvironment(state.dir, ["composio"], {
      AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
    });
    const connections = await checkLive(agentEnvOf(environment));
    const reason = unavailableReason(connections, "quickbooks");
    if (reason !== null) cannotTest(context, "live write quickbooks", "quickbooks", reason);
    const refusal = quickBooksWriteRefusal(await connectedAccounts("quickbooks"));
    if (refusal !== null) cannotTest(context, "live write quickbooks", "quickbooks", refusal);
    prepareWorkspace(state.dir, connections);

    const name = `Revenue Desk live test ${liveMarker()}`;
    const { run, summary } = await askJson({
      state,
      environment,
      policy: CUSTOMER_POLICY,
      budgetUsd: BUDGET_USD,
      prompt: `Create a QuickBooks customer with the display name "${name}" and no opening balance. Do nothing else.`,
    });
    console.log(describeRun("write quickbooks", run, summary));
    expect(run.code, "exit code").toBe(0);
    expect(summary.status).toBe("completed");
    const writes = ranCalls(summary).filter((call) => call.actionClass !== "read");
    expect(writes.map((call) => [call.tool, call.decision, call.isError])).toEqual([
      ["mcp__quickbooks__QUICKBOOKS_CREATE_CUSTOMER", "auto", false],
    ]);

    // QuickBooks agrees: the customer exists.
    const found = await composioTool("QUICKBOOKS_QUERY_CUSTOMERS", {
      query: `select * from Customer where DisplayName = '${name}'`,
    });
    expect(objectsMentioning(found, name).length).toBeGreaterThan(0);
    console.log(
      "live write quickbooks: the customer stays in the sandbox company (QuickBooks does not delete customers).",
    );
  });
});
