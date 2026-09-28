// The empty chat: the jobs, what they need, and what waits for approval
// (web/src/lib/suggestions.ts), built from the workspace's own state.

import { describe, expect, it } from "vitest";
import type { ConnectionView, PolicyView } from "../../../src/contracts/api.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import {
  approvalSentence,
  connectedCount,
  jobSuggestions,
  jobSystems,
} from "../../../web/src/lib/suggestions.js";

const connection = (
  integration: ConnectionView["integration"],
  state: ConnectionView["state"],
): Pick<ConnectionView, "integration" | "state"> => ({ integration, state });

describe("jobSuggestions", () => {
  it("sends the jobs' Slack posts to the workspace's notices channel", () => {
    const jobs = jobSuggestions("#revops");
    expect(jobs).toHaveLength(5);
    const prompts = jobs.map((job) => job.prompt).join("\n");
    expect(prompts).not.toMatch(/#billing|#sales-ops|\{notices\}/);
    expect(jobs.find((job) => job.id === "refund")?.prompt).toContain("tell #revops");
    expect(jobs.find((job) => job.id === "handoff")?.prompt).toContain("tell #revops");
    expect(jobs.find((job) => job.id === "digest")?.prompt).toContain("post the digest to #revops");
  });

  it("names no channel when the workspace has none", () => {
    const jobs = jobSuggestions(null);
    expect(jobs.find((job) => job.id === "refund")?.prompt).toContain("tell the team in Slack");
    expect(
      jobSuggestions("  ")
        .map((job) => job.prompt)
        .join("\n"),
    ).not.toContain("{notices}");
  });
});

describe("jobSystems and connectedCount", () => {
  it("marks each system a job needs that is not connected", () => {
    const [refund] = jobSuggestions("#billing").filter((job) => job.id === "refund");
    if (refund === undefined) throw new Error("no refund job");
    const connections = [
      connection("stripe", "connected"),
      connection("hubspot", "not_configured"),
      connection("slack", "expired"),
    ];
    expect(jobSystems(refund, connections)).toEqual([
      { label: "Stripe", connected: true },
      { label: "HubSpot", connected: false },
      { label: "Slack", connected: false },
    ]);
    // Until the connections load, nothing is marked.
    expect(jobSystems(refund, null).every((system) => system.connected)).toBe(true);
    expect(connectedCount(connections)).toEqual({ connected: 1, total: 6 });
  });
});

describe("approvalSentence", () => {
  const policies = (modes: Partial<Record<PolicyView["actionClass"], PolicyView["mode"]>>) =>
    (Object.keys(DEFAULT_POLICY) as PolicyView["actionClass"][]).map((actionClass) => ({
      actionClass,
      mode: modes[actionClass] ?? DEFAULT_POLICY[actionClass],
    }));

  it("names only the classes set to ask", () => {
    expect(approvalSentence(null)).toBe(
      "Refunds, invoices and payments and outbound email and invitations wait for your approval.",
    );
    expect(approvalSentence(policies({ financial: "auto" }))).toBe(
      "Outbound email and invitations wait for your approval.",
    );
    expect(approvalSentence(policies({ financial: "auto", outbound: "auto" }))).toBe(
      "Nothing waits for your approval under the current policy.",
    );
    expect(approvalSentence(policies({ internal_write: "ask", outbound: "deny" }))).toBe(
      "Refunds, invoices and payments and drafts, notes and internal posts wait for your approval.",
    );
  });
});
