/**
 * Live write, Slack: the agent posts one message to the channel named in
 * LIVE_SLACK_TEST_CHANNEL (for example "#revenue-desk-test") through
 * Composio, and nowhere else.
 *
 * That channel is the workspace's only allowlisted channel, so the post runs
 * without asking; a post anywhere else, a direct message or a mention of
 * everyone is outbound, which the headless CLI refuses. The test finds the
 * message by its marker and deletes it.
 *
 * Skips with the reason when LIVE_SLACK_TEST_CHANNEL is not set or Slack is
 * not connected.
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
  storedRun,
  unavailableReason,
} from "../support.js";
import { composioTool, findString, objectsMentioning } from "./support.js";

requireLiveWrites();

const BUDGET_USD = 0.5;
/**
 * Posts to the allowlisted channel run (internal_write); anything outbound is
 * "ask", which headless mode refuses. "ask" rather than "deny" keeps the post
 * tool in the Composio session, whose exposure follows the policy.
 */
const POST_POLICY: Policy = {
  read: "auto",
  internal_write: "auto",
  outbound: "ask",
  financial: "deny",
  destructive: "deny",
};

describe("live write: one Slack post to the test channel", () => {
  it("posts only to LIVE_SLACK_TEST_CHANNEL", async (context) => {
    const raw = process.env.LIVE_SLACK_TEST_CHANNEL?.trim() ?? "";
    if (raw === "") {
      const reason = "LIVE_SLACK_TEST_CHANNEL is not set: name a channel the test may post to.";
      console.log(`live write slack: skipped. ${reason}`);
      context.skip(reason);
    }
    const channel = `#${raw.replace(/^#/, "").toLowerCase()}`;
    const state = liveStateDir("write-slack");
    context.onTestFinished(() => state.cleanup());
    const environment = liveEnvironment(state.dir, ["composio"], {
      AGENT_MAX_BUDGET_USD: BUDGET_USD.toFixed(2),
    });
    const connections = await checkLive(agentEnvOf(environment));
    const reason = unavailableReason(connections, "slack");
    if (reason !== null) {
      console.log(`live write slack: skipped. ${reason}`);
      context.skip(reason);
    }
    prepareWorkspace(state.dir, connections, {
      allowedSlackChannels: [channel],
      notifySlackChannel: channel,
    });

    const found = await composioTool("SLACK_FIND_CHANNELS", { query: channel.slice(1) });
    const channelId = objectsMentioning(found, channel.slice(1))
      .map((entry) => (entry.name === channel.slice(1) ? findString(entry, ["id"]) : null))
      .find((id) => id !== null);
    if (channelId === undefined || channelId === null) {
      throw new Error(`Slack has no channel ${channel} that the connected user can see.`);
    }

    const marker = liveMarker();
    context.onTestFinished(async () => {
      const history = await composioTool("SLACK_FETCH_CONVERSATION_HISTORY", {
        channel: channelId,
        limit: 20,
      });
      for (const message of objectsMentioning(history, marker)) {
        if (typeof message.ts === "string") {
          await composioTool("SLACK_DELETES_A_MESSAGE_FROM_A_CHAT", {
            channel: channelId,
            ts: message.ts,
          });
        }
      }
    });

    const { run, summary } = await askJson({
      state,
      environment,
      policy: POST_POLICY,
      budgetUsd: BUDGET_USD,
      prompt:
        `Post this exact message to the Slack channel ${channel}: "Revenue Desk live test ${marker}". ` +
        "Use the channel name exactly as written and do nothing else.",
    });
    console.log(describeRun("write slack", run, summary));
    expect(run.code, "exit code").toBe(0);
    expect(summary.status).toBe("completed");

    const posts = ranCalls(summary).filter(
      (call) => call.tool === "mcp__slack__SLACK_SEND_MESSAGE",
    );
    expect(posts.map((call) => [call.actionClass, call.decision, call.isError])).toEqual([
      ["internal_write", "auto", false],
    ]);
    expect(ranCalls(summary).filter((call) => call.actionClass === "outbound")).toEqual([]);
    const stored = storedRun(state.dir, summary.runId).calls.filter(
      (call) => call.tool_name === "mcp__slack__SLACK_SEND_MESSAGE",
    );
    expect(stored.map((call) => call.status)).toEqual(["succeeded"]);

    // Slack agrees: the message is in the channel.
    const history = await composioTool("SLACK_FETCH_CONVERSATION_HISTORY", {
      channel: channelId,
      limit: 20,
    });
    expect(objectsMentioning(history, marker).length).toBeGreaterThan(0);
  });
});
