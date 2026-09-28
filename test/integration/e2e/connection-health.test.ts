/**
 * Full stack: a QuickBooks access token that expires mid-session (they
 * expire hourly). The boot check still passed, then every QuickBooks call
 * of a run answers 401. The connection must say so right away: the
 * Connections screen shows it expired with what to do, and the next run
 * leaves QuickBooks out instead of offering tools that can only fail.
 * Fails, never skips, without the native Claude CLI.
 */
import { describe, expect, it } from "vitest";
import { runConversationOverHttp } from "../../scenarios/run-over-http.js";
import { type Scenario, text } from "../../scenarios/script.js";
import { quickbooks } from "../../scenarios/tools.js";
import { startHarness } from "../../support/harness.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";
import { agentRequests, readRunRows } from "./support.js";

const LIST_INVOICES: Scenario = {
  id: "qbo-token-expires",
  job: "failure",
  title: "QuickBooks refuses an expired token mid-session",
  prompt: "List the open invoices in QuickBooks.",
  steps: [
    () => [quickbooks.listInvoices("qb_list", { status: "open" })],
    () => [text("QuickBooks refused the access token, so I could not list the invoices.")],
  ],
  approvals: {},
  expected: { status: "completed", replyIncludes: ["refused the access token"] },
};

const AFTER: Scenario = {
  id: "qbo-left-out",
  job: "failure",
  title: "The next run without QuickBooks",
  prompt: "Try the invoices again.",
  steps: [() => [text("QuickBooks is unavailable in this run.")]],
  approvals: {},
  expected: { status: "completed", replyIncludes: ["unavailable"] },
};

describe("full stack: a credential that expires during a run", () => {
  it("turns the connection expired at once, and the next run leaves QuickBooks out", {
    timeout: 120_000,
  }, async () => {
    requireNativeSdkBinary();
    const turns = [LIST_INVOICES, AFTER];
    const harness = await startHarness({ server: "in-process", model: turns });
    try {
      const api = harness.api;
      if (api === null) throw new Error("The harness has no server");
      await api.session();
      // The boot check passed; the token expires afterwards.
      await expect
        .poll(async () => {
          const { items } = await api.expect("GET /api/connections", {});
          return items.find((item) => item.integration === "quickbooks")?.state;
        })
        .toBe("connected");
      harness.fakes.quickbooks.faults.expiredToken(/\/query/, { times: Number.POSITIVE_INFINITY });

      const played = await runConversationOverHttp(harness, turns);
      expect(played.problems, harness.serverLog().slice(-4_000)).toEqual([]);
      const [first, second] = played.turns;
      if (first?.runId == null || second?.runId == null) throw new Error("missing run ids");

      // The run's failed call is what the connection now says.
      expect(readRunRows(harness.stateDir, first.runId).call("qb_list")).toMatchObject({
        status: "failed",
        http_status: 401,
      });
      const { items } = await api.expect("GET /api/connections", {});
      const row = items.find((item) => item.integration === "quickbooks");
      expect(row?.state).toBe("expired");
      expect(row?.detail.split("\n")[0]).toBe(
        "QuickBooks Online rejected the access token (it expires hourly). Put a new QBO_ACCESS_TOKEN in your configuration file and restart Revenue Desk.",
      );

      // The next run does not offer QuickBooks, and says why.
      const next = readRunRows(harness.stateDir, second.runId);
      expect(next.connection("quickbooks")).toMatchObject({
        availability: "unavailable",
        state: "expired",
      });
      const lastRequest = agentRequests(harness.model).at(-1);
      const tools = JSON.stringify(lastRequest?.tools ?? []);
      expect(tools).not.toContain("mcp__quickbooks__");
      expect(tools).toContain("mcp__stripe__");
    } finally {
      await harness.close();
    }
  });
});
