// Client routes (web/src/lib/routes.ts) and conversation grouping (lib/conversations.ts).

import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../../../src/contracts/api.js";
import { conversationTitle, groupByRecency } from "../../../web/src/lib/conversations.js";
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
