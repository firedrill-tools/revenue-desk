// Formatting helpers of the web client (web/src/lib/format.ts, lib/cn.ts, lib/urls.ts).

import { describe, expect, it } from "vitest";
import { cn, splitVariants } from "../../../web/src/lib/cn.js";
import {
  approvalsSummary,
  formatCost,
  formatCountdown,
  formatDuration,
  formatElapsed,
  formatRelativeTime,
  formatTokens,
  joinList,
  looksLikeRecordIds,
  msUntil,
  pluralize,
  shortId,
} from "../../../web/src/lib/format.js";
import { safeRedirectUrl } from "../../../web/src/lib/urls.js";

describe("durations", () => {
  it("formats finished durations", () => {
    expect(formatDuration(842)).toBe("842 ms");
    expect(formatDuration(4_260)).toBe("4.2 s");
    expect(formatDuration(42_900)).toBe("42 s");
    expect(formatDuration(64_000)).toBe("1 min 04 s");
    expect(formatDuration(3_720_000)).toBe("1 h 02 min");
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(-1)).toBe("");
  });

  it("formats live elapsed time and countdowns", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(9_999)).toBe("9s");
    expect(formatElapsed(75_000)).toBe("1:15");
    expect(formatCountdown(892_000)).toBe("14:52");
    expect(formatCountdown(0)).toBe("0:00");
  });

  it("counts down to a time, never below zero", () => {
    const now = Date.parse("2026-09-28T10:00:00Z");
    expect(msUntil("2026-09-28T10:00:30Z", now)).toBe(30_000);
    expect(msUntil("2026-09-28T09:00:00Z", now)).toBe(0);
    expect(msUntil("not a date", now)).toBeNull();
    expect(msUntil(null, now)).toBeNull();
  });
});

describe("money and counts", () => {
  it("formats model cost", () => {
    expect(formatCost(0.0412)).toBe("$0.04");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(undefined)).toBe("");
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

describe("relative time", () => {
  const now = new Date(2026, 8, 28, 15, 0, 0);
  it("describes recent and older times", () => {
    expect(formatRelativeTime(new Date(2026, 8, 28, 14, 59, 40).toISOString(), now)).toBe(
      "just now",
    );
    expect(formatRelativeTime(new Date(2026, 8, 28, 14, 50).toISOString(), now)).toBe("10 min ago");
    expect(formatRelativeTime(new Date(2026, 8, 28, 9, 0).toISOString(), now)).toBe("6 h ago");
    expect(formatRelativeTime(new Date(2026, 8, 27, 23, 0).toISOString(), now)).toBe("Yesterday");
    expect(formatRelativeTime(new Date(2026, 8, 12, 9, 0).toISOString(), now)).toBe("Sep 12");
    expect(formatRelativeTime(new Date(2025, 11, 3, 9, 0).toISOString(), now)).toBe("Dec 3, 2025");
    expect(formatRelativeTime("garbage", now)).toBe("");
  });
});

describe("text helpers", () => {
  it("shortens ids, joins lists and pluralizes", () => {
    expect(shortId("run_0123456789", 8)).toBe("run_0123…");
    expect(shortId("run_1", 8)).toBe("run_1");
    expect(joinList(["Gmail"])).toBe("Gmail");
    expect(joinList(["Gmail", "Stripe", "HubSpot"])).toBe("Gmail, Stripe and HubSpot");
    expect(pluralize(1, "source")).toBe("1 source");
    expect(pluralize(3, "source")).toBe("3 sources");
  });

  it("recognises record ids for monospace display", () => {
    expect(looksLikeRecordIds("ch_3Q8hPine0002")).toBe(true);
    expect(looksLikeRecordIds("in_1Q8hPine2041, re_3Q8hPine0007")).toBe(true);
    expect(looksLikeRecordIds("$49.00 USD")).toBe(false);
    expect(looksLikeRecordIds("Fabrikam Inc (cus_Fabrikam001)")).toBe(false);
  });
});

describe("cn", () => {
  it("keeps the app's type scale apart from text colours", () => {
    expect(cn("text-meta text-muted-foreground")).toBe("text-meta text-muted-foreground");
    expect(cn("text-body-sm text-foreground font-medium")).toBe(
      "text-body-sm text-foreground font-medium",
    );
  });

  it("resolves conflicts between default and custom sizes, per variant", () => {
    expect(cn("text-sm", "text-body-sm")).toBe("text-body-sm");
    expect(cn("text-body-sm", "text-sm")).toBe("text-sm");
    expect(cn("md:text-sm md:text-meta text-base")).toBe("md:text-meta text-base");
    expect(cn("rounded-full px-4", "rounded-lg px-3", false && "hidden")).toBe("rounded-lg px-3");
  });

  it("splits variants outside brackets only", () => {
    expect(splitVariants("md:hover:text-meta")).toEqual({
      prefix: "md:hover:",
      utility: "text-meta",
    });
    expect(splitVariants("[&_svg]:size-4")).toEqual({ prefix: "[&_svg]:", utility: "size-4" });
    expect(splitVariants("text-[length:--x]")).toEqual({
      prefix: "",
      utility: "text-[length:--x]",
    });
  });
});

describe("safeRedirectUrl", () => {
  it("allows https only", () => {
    expect(safeRedirectUrl("https://connect.composio.dev/link/abc")).toBe(
      "https://connect.composio.dev/link/abc",
    );
    expect(safeRedirectUrl("http://127.0.0.1:4390/link")).toBeNull();
    expect(safeRedirectUrl("http://evil.example/link")).toBeNull();
    expect(safeRedirectUrl("javascript:alert(1)")).toBeNull();
    expect(safeRedirectUrl("https://user:pass@example.com/")).toBeNull();
    expect(safeRedirectUrl("not a url")).toBeNull();
  });
});

describe("approvalsSummary", () => {
  it("says a run's approvals in words, waiting first", () => {
    expect(approvalsSummary({ pending: 1, approved: 2, denied: 0 })).toBe("1 waiting, 2 approved");
    expect(approvalsSummary({ pending: 0, approved: 0, denied: 3 })).toBe("3 denied");
    expect(approvalsSummary({ pending: 0, approved: 0, denied: 0 })).toBeNull();
  });
});
