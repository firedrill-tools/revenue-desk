// Client routes (web/src/lib/routes.ts) and conversation grouping (lib/conversations.ts).

import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../../../src/contracts/api.js";
import {
  awaitingConversations,
  conversationTitle,
  documentTitle,
  groupByRecency,
  waitingApprovalCount,
  waitingMarker,
} from "../../../web/src/lib/conversations.js";
import { hrefFor, NAV_ITEMS, parseRoute, type Route } from "../../../web/src/lib/routes.js";

describe("parseRoute", () => {
  it.each<[string, Route]>([
    ["/", { name: "chat", conversationId: null }],
    ["/c/conv_123", { name: "chat", conversationId: "conv_123" }],
    ["/c/conv_123/", { name: "chat", conversationId: "conv_123" }],
    ["/runs", { name: "runs", runId: null }],
    ["/runs/run_9", { name: "runs", runId: "run_9" }],
    ["/connections", { name: "connections" }],
    ["/settings", { name: "settings" }],
  ])("parses %s", (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it.each([
    "/c",
    "/c/a/b",
    "/c/%2E%2E",
    "/c/..",
    "/runs/x%2Fy",
    "/settings/extra",
    "/nope",
    "/c/%E0%A4%A",
  ])("rejects %s", (path) => {
    expect(parseRoute(path).name).toBe("not_found");
  });

  it("round-trips hrefs", () => {
    const routes: Route[] = [
      { name: "chat", conversationId: null },
      { name: "chat", conversationId: "conv_1" },
      { name: "runs", runId: null },
      { name: "runs", runId: "run_1" },
      { name: "connections" },
      { name: "settings" },
    ];
    for (const route of routes) expect(parseRoute(hrefFor(route))).toEqual(route);
  });

  it("lists every screen in the navigation", () => {
    expect(NAV_ITEMS.map((item) => parseRoute(item.href).name)).toEqual([
      "chat",
      "runs",
      "connections",
      "settings",
    ]);
  });
});

function conversation(id: string, updatedAt: Date, title = id): ConversationSummary {
  return {
    id,
    title,
    source: "ui",
    status: "idle",
    activeRunId: null,
    pendingApprovals: 0,
    pendingConsequence: null,
    totalCostUsd: 0,
    createdAt: updatedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    archivedAt: null,
  };
}

describe("groupByRecency", () => {
  it("groups by last activity, newest first, and skips empty groups", () => {
    const now = new Date(2026, 8, 28, 15, 0);
    const groups = groupByRecency(
      [
        conversation("old", new Date(2026, 5, 1)),
        conversation("today-early", new Date(2026, 8, 28, 8, 0)),
        conversation("yesterday", new Date(2026, 8, 27, 22, 0)),
        conversation("today-late", new Date(2026, 8, 28, 14, 0)),
        conversation("week", new Date(2026, 8, 23, 10, 0)),
      ],
      now,
    );
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ["Today", ["today-late", "today-early"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["Older", ["old"]],
    ]);
  });

  it("titles untitled conversations", () => {
    expect(conversationTitle({ title: "  " })).toBe("New conversation");
    expect(conversationTitle({ title: "Refund" })).toBe("Refund");
  });
});

describe("approvals waiting outside their conversation", () => {
  const item = (
    id: string,
    status: ConversationSummary["status"],
    pendingApprovals: number,
    pendingConsequence: string | null,
    updatedAt = "2026-09-29T10:00:00.000Z",
  ): ConversationSummary => ({
    id,
    title: "Refund a duplicate charge",
    source: "ui",
    status,
    activeRunId: status === "idle" ? null : `run_${id}`,
    pendingApprovals,
    pendingConsequence,
    totalCostUsd: 0,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
  });

  it("counts them for the tab title and the app bar", () => {
    const items = [
      item("a", "awaiting_approval", 1, "Refund $490.00 to Harbor & Pine Outfitters"),
      item(
        "b",
        "awaiting_approval",
        2,
        "Refund $49.00 to Kestrel Analytics",
        "2026-09-29T11:00:00.000Z",
      ),
      item("c", "running", 0, null),
      item("d", "idle", 0, null),
    ];
    expect(waitingApprovalCount(items)).toBe(3);
    expect(awaitingConversations(items).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(documentTitle("Revenue Desk", 3)).toBe("(3) Revenue Desk");
    expect(documentTitle("Runs · Revenue Desk", 0)).toBe("Runs · Revenue Desk");
  });

  it("says in the rail what each one waits for", () => {
    expect(
      waitingMarker(item("a", "awaiting_approval", 1, "Refund $490.00 to Harbor & Pine")),
    ).toBe("Needs approval · Refund $490.00 to Harbor & Pine");
    expect(waitingMarker(item("b", "awaiting_approval", 2, "Send the reply"))).toBe(
      "2 approvals waiting · Send the reply",
    );
    expect(waitingMarker(item("c", "awaiting_approval", 1, null))).toBe("Needs approval");
  });
});
