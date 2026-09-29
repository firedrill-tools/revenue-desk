/**
 * Live write, Gmail: the agent creates a draft addressed to the connected
 * account's own address through Composio, and never sends it.
 *
 * Drafts are allowed without asking and nothing outbound is (so the run's
 * Composio session offers no send tool at all). The test finds the draft by
 * its marker in the subject and deletes it. The address is read from the
 * account and never printed.
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
  type Policy,
  prepareWorkspace,
  ranCalls,
  requireLiveWrites,
  unavailableReason,
} from "../support.js";
import { composioTool, findString, objectsMentioning } from "./support.js";

requireLiveWrites();

const BUDGET_USD = 0.5;
/** Drafts and labels allowed without asking; nothing that reaches anyone. */
const DRAFT_POLICY: Policy = {
  read: "auto",
  internal_write: "auto",
  outbound: "deny",
  financial: "deny",
  destructive: "deny",
};

describe("live write: a Gmail draft to the account's own address", () => {
  it("creates the draft and sends nothing", async (context) => {
    const state = liveStateDir("write-gmail");
    context.onTestFinished(() => state.cleanup());
    const environment = liveEnvironment(state.dir, ["composio"], {
      AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
    });
    const connections = await checkLive(agentEnvOf(environment));
    const reason = unavailableReason(connections, "gmail");
    if (reason !== null) {
      console.log(`live write gmail: skipped. ${reason}`);
      context.skip(reason);
    }
    const own = findString(await composioTool("GMAIL_GET_PROFILE", {}), [
      "emailAddress",
      "email_address",
    ]);
    if (own === null) throw new Error("GMAIL_GET_PROFILE returned no address.");
    prepareWorkspace(state.dir, connections, {
      internalEmailDomains: [own.split("@")[1]?.toLowerCase() ?? ""],
    });

    const marker = liveMarker();
    context.onTestFinished(async () => {
      const drafts = await composioTool("GMAIL_LIST_DRAFTS", { max_results: 25, verbose: true });
      const ids = new Set<string>();
      for (const draft of objectsMentioning(drafts, marker)) {
        const text = (key: string) => (typeof draft[key] === "string" ? String(draft[key]) : null);
        // A draft carries its own id next to the message it holds (Gmail's draft
        // resource), or as draft_id when Composio flattens it.
        const id = text("draft_id") ?? text("draftId") ?? ("message" in draft ? text("id") : null);
        if (id !== null) ids.add(id);
      }
      for (const id of ids) await composioTool("GMAIL_DELETE_DRAFT", { draft_id: id });
    });

    const { run, summary } = await askJson({
      state,
      environment,
      policy: DRAFT_POLICY,
      budgetUsd: BUDGET_USD,
      prompt:
        `Create a Gmail draft to ${own} with the subject "Revenue Desk live test ${marker}" ` +
        `and the body "This draft was made by the Revenue Desk live write test and can be deleted." ` +
        "Do not send it, and do nothing else.",
    });
    console.log(describeRun("write gmail", run, summary));
    expect(run.code, "exit code").toBe(0);
    expect(summary.status).toBe("completed");

    const ran = ranCalls(summary);
    expect(
      ran
        .filter((call) => call.tool === "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT")
        .map((call) => [call.decision, call.isError]),
    ).toEqual([["auto", false]]);
    // Nothing that reaches anyone ran; the session did not even offer it.
    expect(ran.filter((call) => call.actionClass === "outbound")).toEqual([]);
    expect(summary.toolCalls.map((call) => call.tool)).not.toContain(
      "mcp__gmail__GMAIL_SEND_DRAFT",
    );

    // Gmail agrees: the draft is there.
    const drafts = await composioTool("GMAIL_LIST_DRAFTS", { max_results: 25, verbose: true });
    expect(objectsMentioning(drafts, marker).length).toBeGreaterThan(0);
  });
});
