// Settings form rules (web/src/lib/settings-form.ts).

import { describe, expect, it } from "vitest";
import type { PolicyView } from "../../../src/contracts/api.js";
import type { WorkspaceSettings } from "../../../src/contracts/integration.js";
import {
  draftFromSettings,
  isEmptyPatch,
  normalizeCalendarId,
  normalizeChannel,
  normalizeDomain,
  policiesPatch,
  settingsPatch,
  validateDraft,
} from "../../../web/src/lib/settings-form.js";

const SETTINGS: WorkspaceSettings = {
  companyName: "Kestrel Analytics, Inc.",
  agentName: "Revenue Desk",
  senderName: "Maya Lindqvist",
  emailSignature: "Maya",
  internalEmailDomains: ["kestrel.test"],
  notifySlackChannel: "#billing",
  allowedSlackChannels: ["#billing"],
  internalCalendarIds: [],
  timezone: "America/New_York",
  currency: "USD",
  defaultModel: null,
  defaultEffort: null,
  updatedAt: "2026-09-28T10:00:00Z",
};

describe("list entries", () => {
  it("normalises domains", () => {
    expect(normalizeDomain("  @Kestrel.TEST. ")).toEqual({ value: "kestrel.test" });
    expect(normalizeDomain("mail.harbor-pine.test")).toEqual({ value: "mail.harbor-pine.test" });
    expect("error" in normalizeDomain("not a domain")).toBe(true);
    expect("error" in normalizeDomain("-bad.test")).toBe(true);
  });

  it("normalises Slack channels", () => {
    expect(normalizeChannel("Sales-Ops")).toEqual({ value: "#sales-ops" });
    expect(normalizeChannel("##billing")).toEqual({ value: "#billing" });
    expect("error" in normalizeChannel("#no spaces")).toBe(true);
    expect("error" in normalizeChannel("#")).toBe(true);
  });
});

describe("validateDraft", () => {
  it("accepts saved settings and flags bad fields", () => {
    expect(validateDraft(draftFromSettings(SETTINGS))).toEqual({});
    const errors = validateDraft({
      ...draftFromSettings(SETTINGS),
      companyName: " ",
      currency: "US",
      timezone: "Mars/Olympus",
      notifySlackChannel: "#bad channel",
      defaultEffort: "extreme",
    });
    expect(Object.keys(errors).sort()).toEqual(
      ["companyName", "currency", "defaultEffort", "notifySlackChannel", "timezone"].sort(),
    );
  });
});

describe("normalizeCalendarId", () => {
  it("accepts shared calendar ids and refuses primary and non-ids", () => {
    expect(normalizeCalendarId(" Team@Group.Calendar.Google.com ")).toEqual({
      value: "team@group.calendar.google.com",
    });
    expect(normalizeCalendarId("primary")).toEqual({
      error: "Your primary calendar is always internal.",
    });
    expect("error" in normalizeCalendarId("team calendar")).toBe(true);
  });
});

describe("settingsPatch", () => {
  it("is empty when nothing changed", () => {
    expect(isEmptyPatch(settingsPatch(SETTINGS, draftFromSettings(SETTINGS)))).toBe(true);
  });

  it("sends only changed fields, normalised", () => {
    const draft = {
      ...draftFromSettings(SETTINGS),
      companyName: "  Kestrel Analytics  ",
      currency: "eur",
      notifySlackChannel: "revenue",
      allowedSlackChannels: ["#billing", "#revenue"],
      internalCalendarIds: ["team@group.calendar.google.com"],
      defaultModel: "claude-opus-5",
      defaultEffort: "high",
    };
    expect(settingsPatch(SETTINGS, draft)).toEqual({
      companyName: "Kestrel Analytics",
      currency: "EUR",
      notifySlackChannel: "#revenue",
      allowedSlackChannels: ["#billing", "#revenue"],
      internalCalendarIds: ["team@group.calendar.google.com"],
      defaultModel: "claude-opus-5",
      defaultEffort: "high",
    });
  });

  it("clears optional fields with null", () => {
    const saved = { ...SETTINGS, defaultModel: "claude-opus-5", defaultEffort: "high" as const };
    const draft = {
      ...draftFromSettings(saved),
      defaultModel: " ",
      defaultEffort: "",
      notifySlackChannel: "",
    };
    expect(settingsPatch(saved, draft)).toEqual({
      defaultModel: null,
      defaultEffort: null,
      notifySlackChannel: null,
    });
  });
});

describe("policiesPatch", () => {
  const policies: PolicyView[] = [
    { actionClass: "read", mode: "auto", source: "default", locked: false },
    { actionClass: "financial", mode: "ask", source: "default", locked: false },
    { actionClass: "destructive", mode: "deny", source: "environment", locked: true },
  ];

  it("sends changed, unlocked classes only", () => {
    expect(
      policiesPatch(policies, { read: "auto", financial: "deny", destructive: "auto" }),
    ).toEqual({
      modes: { financial: "deny" },
    });
    expect(isEmptyPatch(policiesPatch(policies, { read: "auto" }).modes)).toBe(true);
  });
});
