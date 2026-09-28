import { describe, expect, it } from "vitest";
import type { ActionClass } from "../../../src/contracts/integration.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import { classifyGmail } from "../../../src/integrations/gmail/classify.js";
import { GMAIL_PROFILE } from "../../../src/integrations/gmail/profile.js";
import { classifyGoogleCalendar } from "../../../src/integrations/google-calendar/classify.js";
import { GOOGLE_CALENDAR_PROFILE } from "../../../src/integrations/google-calendar/profile.js";
import { SETTINGS } from "./helpers.js";

describe("classifyGmail", () => {
  it("classifies reads as read", () => {
    for (const spec of Object.values(GMAIL_PROFILE.tools)) {
      if (spec.baseClass !== "read") continue;
      expect(classifyGmail(spec.name, { query: "from:ap@acme.test" }, SETTINGS)).toEqual({
        actionClass: "read",
        operation: spec.operation,
        title: spec.title,
      });
    }
  });

  it("creates drafts as internal_write with every recipient", () => {
    expect(
      classifyGmail(
        "GMAIL_CREATE_EMAIL_DRAFT",
        {
          recipient_email: "Ana Diaz <Ana@Acme.test>",
          extra_recipients: ["me", "bo@acme.test"],
          cc: ["finance@kestrel.test"],
          subject: "Your duplicate charge",
          body: "Hi Ana,\n\nWe refunded the duplicate charge.",
          thread_id: "18c2f",
        },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "internal_write",
      operation: "gmail.drafts.create",
      title: "Create Gmail draft",
      details: {
        consequence:
          "Create a Gmail draft to ana@acme.test, bo@acme.test and finance@kestrel.test (not sent)",
        facts: [
          { label: "To", value: "ana@acme.test, bo@acme.test" },
          { label: "Cc", value: "finance@kestrel.test" },
          { label: "Subject", value: "Your duplicate charge" },
          { label: "Thread", value: "18c2f" },
          { label: "Body", value: "Hi Ana, We refunded the duplicate charge." },
        ],
        recipients: ["ana@acme.test", "bo@acme.test", "finance@kestrel.test"],
      },
    });
    expect(
      classifyGmail("GMAIL_CREATE_EMAIL_DRAFT", { subject: "later" }, SETTINGS)?.details
        ?.consequence,
    ).toBe("Create a Gmail draft (not sent)");
  });

  it("sends and replies as outbound", () => {
    expect(classifyGmail("GMAIL_SEND_DRAFT", { draft_id: "r998" }, SETTINGS)).toEqual({
      actionClass: "outbound",
      operation: "gmail.drafts.send",
      title: "Send Gmail draft",
      details: {
        consequence: "Send Gmail draft r998 to the recipients saved in it",
        facts: [
          { label: "Draft", value: "r998" },
          { label: "Recipients", value: "As saved in the draft" },
        ],
        recordIds: ["r998"],
      },
    });
    expect(
      classifyGmail(
        "GMAIL_REPLY_TO_THREAD",
        {
          thread_id: "18c2f",
          recipient_email: "ana@acme.test",
          bcc: ["audit@kestrel.test"],
          message_body: "Done.",
        },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "outbound",
      operation: "gmail.threads.reply",
      title: "Reply in Gmail thread",
      details: {
        consequence: "Send a reply in Gmail to ana@acme.test and audit@kestrel.test",
        facts: [
          { label: "To", value: "ana@acme.test" },
          { label: "Bcc", value: "audit@kestrel.test" },
          { label: "Thread", value: "18c2f" },
          { label: "Message", value: "Done." },
        ],
        recipients: ["ana@acme.test", "audit@kestrel.test"],
        recordIds: ["18c2f"],
      },
    });
    // Replies are outbound even when every recipient is internal.
    expect(
      classifyGmail(
        "GMAIL_REPLY_TO_THREAD",
        { thread_id: "1", recipient_email: "ops@kestrel.test" },
        SETTINGS,
      )?.actionClass,
    ).toBe("outbound");
  });

  it("labels as internal_write, but moving to Trash or Spam is destructive", () => {
    expect(
      classifyGmail(
        "GMAIL_ADD_LABEL_TO_EMAIL",
        { message_id: "m1", add_label_ids: ["Label_7"], remove_label_ids: ["INBOX"] },
        SETTINGS,
      ),
    ).toMatchObject({
      actionClass: "internal_write",
      operation: "gmail.messages.label",
      details: { recordIds: ["m1"] },
    });
    for (const label of ["TRASH", "SPAM", "trash"]) {
      expect(
        classifyGmail(
          "GMAIL_ADD_LABEL_TO_EMAIL",
          { message_id: "m1", add_label_ids: [label] },
          SETTINGS,
        ),
      ).toMatchObject({
        actionClass: "destructive",
        details: { recordIds: ["m1"] },
      });
    }
  });

  it("denies other mailboxes, attachments, bad recipients and unknown tools", () => {
    const denied: Array<[string, JsonObject]> = [
      ["GMAIL_DELETE_MESSAGE", { message_id: "m1" }],
      ["GMAIL_SEND_EMAIL", { recipient_email: "a@b.test" }],
      ["GMAIL_FETCH_EMAILS", { user_id: "ceo@kestrel.test" }],
      [
        "GMAIL_CREATE_EMAIL_DRAFT",
        { recipient_email: "a@b.test", attachment: { name: "x.pdf", s3key: "k" } },
      ],
      [
        "GMAIL_REPLY_TO_THREAD",
        { thread_id: "1", recipient_email: "a@b.test", attachment: "file" },
      ],
      ["GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "Ana Diaz" }],
      ["GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "a@b.test", cc: ["ok@b.test", 7] }],
      ["GMAIL_REPLY_TO_THREAD", { thread_id: "1" }],
      ["GMAIL_REPLY_TO_THREAD", { recipient_email: "a@b.test" }],
      ["GMAIL_SEND_DRAFT", {}],
      ["GMAIL_ADD_LABEL_TO_EMAIL", { add_label_ids: ["X"] }],
    ];
    for (const [tool, input] of denied) {
      expect(classifyGmail(tool, input, SETTINGS), `${tool} ${JSON.stringify(input)}`).toBeNull();
    }
    expect(
      classifyGmail("GMAIL_FETCH_EMAILS", { user_id: "me", attachment: null }, SETTINGS)
        ?.actionClass,
    ).toBe("read");
  });
});

describe("classifyGoogleCalendar", () => {
  const event = (extra: JsonObject): JsonObject => ({
    summary: "Collections call",
    start_datetime: "2026-10-02T14:00:00",
    event_duration_minutes: 30,
    timezone: "America/New_York",
    ...extra,
  });
  const classOf = (tool: string, input: JsonObject): ActionClass | null =>
    classifyGoogleCalendar(tool, input, SETTINGS)?.actionClass ?? null;

  it("classifies reads as read", () => {
    for (const spec of Object.values(GOOGLE_CALENDAR_PROFILE.tools)) {
      if (spec.baseClass !== "read") continue;
      expect(classifyGoogleCalendar(spec.name, {}, SETTINGS)).toEqual({
        actionClass: "read",
        operation: spec.operation,
        title: spec.title,
      });
    }
  });

  it("invites outside attendees as outbound with the facts", () => {
    expect(
      classifyGoogleCalendar(
        "GOOGLECALENDAR_CREATE_EVENT",
        event({
          attendees: ["ana@acme.test", { email: "Rep@Kestrel.test", optional: true }],
          send_updates: "all",
        }),
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "outbound",
      operation: "google_calendar.events.create",
      title: "Invite 1 outside guest in Google Calendar",
      details: {
        consequence:
          'Create "Collections call" in Google Calendar with ana@acme.test and rep@kestrel.test',
        facts: [
          { label: "Title", value: "Collections call" },
          { label: "When", value: "2026-10-02T14:00:00 for 30 min (America/New_York)" },
          { label: "Attendees", value: "ana@acme.test, rep@kestrel.test" },
          { label: "Outside the company", value: "ana@acme.test" },
          { label: "Notifications", value: "all" },
        ],
        recipients: ["ana@acme.test", "rep@kestrel.test"],
      },
    });
  });

  it("keeps internal-only and attendee-free events internal", () => {
    expect(
      classOf(
        "GOOGLECALENDAR_CREATE_EVENT",
        event({ attendees: ["rep@kestrel.test", "Ops <ops@eu.kestrel.test>"] }),
      ),
    ).toBe("internal_write");
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({}))).toBe("internal_write");
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({ attendees: [] }))).toBe("internal_write");
    expect(
      classOf(
        "GOOGLECALENDAR_CREATE_EVENT",
        event({ calendar_id: "team@group.calendar.google.com" }),
      ),
    ).toBe("internal_write");
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({ calendar_id: "rep@kestrel.test" }))).toBe(
      "internal_write",
    );
    expect(
      classifyGoogleCalendar(
        "GOOGLECALENDAR_CREATE_EVENT",
        event({ attendees: ["rep@kestrel.test"] }),
        { ...SETTINGS, internalEmailDomains: [] },
      )?.actionClass,
    ).toBe("outbound");
  });

  it("treats someone else's calendar as outbound", () => {
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({ calendar_id: "ana@acme.test" }))).toBe(
      "outbound",
    );
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({ calendar_id: "c_opaque123" }))).toBe(
      "outbound",
    );
  });

  it("classifies updates like creates, but an update without attendees is outbound", () => {
    expect(
      classOf(
        "GOOGLECALENDAR_UPDATE_EVENT",
        event({ event_id: "ev1", attendees: ["rep@kestrel.test"] }),
      ),
    ).toBe("internal_write");
    expect(
      classOf(
        "GOOGLECALENDAR_UPDATE_EVENT",
        event({ event_id: "ev1", attendees: ["ana@acme.test"] }),
      ),
    ).toBe("outbound");
    const cleared = classifyGoogleCalendar(
      "GOOGLECALENDAR_UPDATE_EVENT",
      event({ event_id: "ev1" }),
      SETTINGS,
    );
    expect(cleared).toMatchObject({
      actionClass: "outbound",
      operation: "google_calendar.events.update",
      title: "Update calendar event",
      details: {
        consequence: 'Replace event ev1 with "Collections call", removing its attendees',
        recordIds: ["ev1"],
      },
    });
    expect(cleared?.details?.facts).toContainEqual({
      label: "Attendees",
      value: "None listed: existing attendees are removed",
    });
  });

  it("denies attendees that are not addresses, updates without an event id and unknown tools", () => {
    const denied: Array<[string, JsonObject]> = [
      ["GOOGLECALENDAR_CREATE_EVENT", event({ attendees: ["Ana Diaz"] })],
      ["GOOGLECALENDAR_CREATE_EVENT", event({ attendees: [{ displayName: "Ana" }] })],
      ["GOOGLECALENDAR_CREATE_EVENT", event({ attendees: "ana@acme.test" })],
      ["GOOGLECALENDAR_UPDATE_EVENT", event({ attendees: ["rep@kestrel.test"] })],
      ["GOOGLECALENDAR_DELETE_EVENT", { event_id: "ev1" }],
      ["GOOGLECALENDAR_QUICK_ADD", {}],
    ];
    for (const [tool, input] of denied) {
      expect(
        classifyGoogleCalendar(tool, input, SETTINGS),
        `${tool} ${JSON.stringify(input)}`,
      ).toBeNull();
    }
  });
});
