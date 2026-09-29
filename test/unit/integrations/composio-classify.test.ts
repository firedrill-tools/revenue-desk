import { describe, expect, it } from "vitest";
import type { ActionClass } from "../../../src/contracts/integration.js";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import {
  classifyGmail,
  classifySendDraft,
  draftFromCreate,
  UNCONFIRMED_RECIPIENTS,
} from "../../../src/integrations/gmail/classify.js";
import { GMAIL_PROFILE } from "../../../src/integrations/gmail/profile.js";
import { GmailDraftMemory } from "../../../src/integrations/gmail/run-memory.js";
import { classifyGoogleCalendar } from "../../../src/integrations/google-calendar/classify.js";
import { createGoogleCalendarIntegration } from "../../../src/integrations/google-calendar/definition.js";
import { GOOGLE_CALENDAR_PROFILE } from "../../../src/integrations/google-calendar/profile.js";
import { GoogleCalendarRunMemory } from "../../../src/integrations/google-calendar/run-memory.js";
import { multilinePreview } from "../../../src/integrations/shared/text.js";
import { SETTINGS } from "./helpers.js";

const DRAFT_INPUT: JsonObject = {
  recipient_email: "Jamie Lee <jamie@fabrikam.example>",
  cc: ["billing@fabrikam.example"],
  subject: "Your duplicate charge",
  thread_id: "19a1",
  body: "Hi Jamie,",
};

describe("sending a draft this run created", () => {
  it("reads the draft id from Composio's result, bare or wrapped", () => {
    const expected = {
      draftId: "r-7400",
      recipients: { to: ["jamie@fabrikam.example"], cc: ["billing@fabrikam.example"], bcc: [] },
      subject: "Your duplicate charge",
      threadId: "19a1",
      body: "Hi Jamie,",
    };
    const outputs: JsonValue[] = [
      {
        successful: true,
        data: { id: "r-7400", message: { id: "m1", threadId: "19a1" } },
        error: null,
      },
      { successful: true, data: { response_data: { id: "r-7400" } } },
      { data: { draft_id: "r-7400" } },
      { id: "r-7400", message: { id: "m1" } },
      { draft_id: "r-7400" },
    ];
    for (const output of outputs) {
      expect(draftFromCreate(DRAFT_INPUT, output), JSON.stringify(output)).toEqual(expected);
    }
  });

  it("knows no draft without an id, after a failed create, or without addresses", () => {
    expect(draftFromCreate(DRAFT_INPUT, { successful: false, data: { id: "r-1" } })).toBeNull();
    expect(draftFromCreate(DRAFT_INPUT, { successful: true, data: {} })).toBeNull();
    expect(draftFromCreate(DRAFT_INPUT, "Draft created")).toBeNull();
    expect(draftFromCreate({ subject: "No one" }, { id: "r-1" })).toBeNull();
    expect(draftFromCreate({ recipient_email: "not an address" }, { id: "r-1" })).toBeNull();
  });

  it("names the recipients, subject and thread of the known draft, and shows its body", () => {
    const known = draftFromCreate(DRAFT_INPUT, { data: { id: "r-7400" } });
    expect(classifySendDraft({ draft_id: "r-7400" }, known)).toEqual({
      actionClass: "outbound",
      operation: "gmail.drafts.send",
      title: "Send Gmail draft",
      details: {
        consequence: "Send the Gmail draft to jamie@fabrikam.example and billing@fabrikam.example",
        facts: [
          { label: "To", value: "jamie@fabrikam.example" },
          { label: "Cc", value: "billing@fabrikam.example" },
          { label: "Subject", value: "Your duplicate charge" },
          { label: "Thread", value: "19a1" },
          { label: "Body", value: "Hi Jamie," },
          { label: "Draft", value: "r-7400" },
        ],
        recipients: ["jamie@fabrikam.example", "billing@fabrikam.example"],
        recordIds: ["r-7400"],
      },
    });
    // Another draft id is not vouched for by this one.
    expect(classifySendDraft({ draft_id: "r-9999" }, known)?.details?.facts).toContainEqual({
      label: "Recipients",
      value: UNCONFIRMED_RECIPIENTS,
    });
  });

  it("the run's memory learns from successful creates only and refines only sends", () => {
    const memory = new GmailDraftMemory();
    const base = classifyGmail("GMAIL_SEND_DRAFT", { draft_id: "r-7400" }, SETTINGS);
    if (base === null) throw new Error("expected a classification");
    memory.record("GMAIL_CREATE_EMAIL_DRAFT", DRAFT_INPUT, { error: "quota" }, true);
    memory.record("GMAIL_FETCH_EMAILS", { query: "x" }, { data: { id: "r-7400" } }, false);
    expect(memory.refine("GMAIL_SEND_DRAFT", { draft_id: "r-7400" }, base)).toEqual(base);

    memory.record("GMAIL_CREATE_EMAIL_DRAFT", DRAFT_INPUT, { data: { id: "r-7400" } }, false);
    expect(memory.drafts.size).toBe(1);
    const refined = memory.refine("GMAIL_SEND_DRAFT", { draft_id: "r-7400" }, base);
    expect(refined.actionClass).toBe("outbound");
    expect(refined.details?.recipients).toEqual([
      "jamie@fabrikam.example",
      "billing@fabrikam.example",
    ]);
    const label = classifyGmail("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "m1" }, SETTINGS);
    if (label === null) throw new Error("expected a classification");
    expect(memory.refine("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "m1" }, label)).toBe(label);
  });
});

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
          cc: ["finance@contoso.example"],
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
          "Create a Gmail draft to ana@acme.test, bo@acme.test and finance@contoso.example (not sent)",
        facts: [
          { label: "To", value: "ana@acme.test, bo@acme.test" },
          { label: "Cc", value: "finance@contoso.example" },
          { label: "Subject", value: "Your duplicate charge" },
          { label: "Thread", value: "18c2f" },
          // Line breaks kept: the card shows the email as it will read.
          { label: "Body", value: "Hi Ana,\n\nWe refunded the duplicate charge." },
        ],
        recipients: ["ana@acme.test", "bo@acme.test", "finance@contoso.example"],
      },
    });
    expect(
      classifyGmail("GMAIL_CREATE_EMAIL_DRAFT", { subject: "later" }, SETTINGS)?.details
        ?.consequence,
    ).toBe("Create a Gmail draft (not sent)");
  });

  it("sends and replies as outbound; a draft nobody vouches for says its recipients are unconfirmed", () => {
    expect(classifyGmail("GMAIL_SEND_DRAFT", { draft_id: "r998" }, SETTINGS)).toEqual({
      actionClass: "outbound",
      operation: "gmail.drafts.send",
      title: "Send Gmail draft",
      details: {
        consequence: "Send Gmail draft r998. Its recipients could not be confirmed.",
        facts: [
          { label: "Draft", value: "r998" },
          { label: "Recipients", value: UNCONFIRMED_RECIPIENTS },
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
          bcc: ["audit@contoso.example"],
          message_body: "Done.",
        },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "outbound",
      operation: "gmail.threads.reply",
      title: "Reply in Gmail thread",
      details: {
        consequence: "Send a reply in Gmail to ana@acme.test and audit@contoso.example",
        facts: [
          { label: "To", value: "ana@acme.test" },
          { label: "Bcc", value: "audit@contoso.example" },
          { label: "Thread", value: "18c2f" },
          { label: "Message", value: "Done." },
        ],
        recipients: ["ana@acme.test", "audit@contoso.example"],
        recordIds: ["18c2f"],
      },
    });
    // Replies are outbound even when every recipient is internal.
    expect(
      classifyGmail(
        "GMAIL_REPLY_TO_THREAD",
        { thread_id: "1", recipient_email: "ops@contoso.example" },
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
      ["GMAIL_FETCH_EMAILS", { user_id: "ceo@contoso.example" }],
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

describe("email bodies on cards", () => {
  const LONG_REPLY = [
    "Hi Jamie,  ",
    "",
    "",
    "",
    "Thanks for flagging this.   We found two $490.00 charges on September 22.",
    "\t",
    ...Array.from(
      { length: 60 },
      (_, index) => `Line ${index + 1} of the detail the customer reads.`,
    ),
    "",
    "Best,",
    "Maya Chen",
    "Revenue Operations, Contoso Ltd",
  ].join("\r\n");

  it("keeps paragraphs and the signature, and shows the whole of a long email", () => {
    const known = draftFromCreate({ ...DRAFT_INPUT, body: LONG_REPLY }, { data: { id: "r-7400" } });
    const body = classifySendDraft({ draft_id: "r-7400" }, known)?.details?.facts.find(
      (fact) => fact.label === "Body",
    )?.value;
    expect(body?.startsWith("Hi Jamie,\n\nThanks for flagging this. We found")).toBe(true);
    // Blank-line runs collapse to one; nothing is cut before the sign-off.
    expect(body).not.toContain("\n\n\n");
    expect(body?.endsWith("Best,\nMaya Chen\nRevenue Operations, Contoso Ltd")).toBe(true);
    expect(body).not.toContain("…");
  });

  it("caps a body at about 4,000 characters, at a line end", () => {
    const huge = Array.from({ length: 400 }, (_, index) => `Paragraph line ${index}.`).join("\n");
    const value = multilinePreview(huge);
    expect(value.length).toBeLessThanOrEqual(4_000);
    expect(value.endsWith(".…")).toBe(true);
    expect(multilinePreview("  one  \n\n\n  two  ")).toBe("one\n\ntwo");
  });

  it("keeps the shape of a reply's message", () => {
    const reply = classifyGmail(
      "GMAIL_REPLY_TO_THREAD",
      {
        thread_id: "19a1",
        recipient_email: "jamie@fabrikam.example",
        message_body: "Hi Jamie,\n\nThe refund is under review.\n\nMaya",
      },
      SETTINGS,
    );
    expect(reply?.details?.facts).toContainEqual({
      label: "Message",
      value: "Hi Jamie,\n\nThe refund is under review.\n\nMaya",
    });
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
          attendees: ["ana@acme.test", { email: "Rep@Contoso.example", optional: true }],
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
          'Create "Collections call" in Google Calendar with ana@acme.test and rep@contoso.example',
        facts: [
          { label: "Title", value: "Collections call" },
          { label: "When", value: "Fri, Oct 2, 2026, 2:00–2:30 pm (America/New_York)" },
          { label: "Attendees", value: "ana@acme.test, rep@contoso.example" },
          { label: "Outside the company", value: "ana@acme.test" },
          { label: "Notifications", value: "Google emails the invitation to every attendee" },
        ],
        recipients: ["ana@acme.test", "rep@contoso.example"],
      },
    });
  });

  it("writes when the event is with its weekday, in its time zone", () => {
    const when = (extra: JsonObject) =>
      classifyGoogleCalendar(
        "GOOGLECALENDAR_CREATE_EVENT",
        event(extra),
        SETTINGS,
      )?.details?.facts.find((fact) => fact.label === "When")?.value;
    expect(when({ start_datetime: "2026-09-30T13:00:00" })).toBe(
      "Wed, Sep 30, 2026, 1:00–1:30 pm (America/New_York)",
    );
    expect(when({ start_datetime: "2026-09-30 11:30", end_datetime: "2026-09-30T12:15:00" })).toBe(
      "Wed, Sep 30, 2026, 11:30 am–12:15 pm (America/New_York)",
    );
    // An instant with an offset is shown in the event's zone.
    expect(when({ start_datetime: "2026-09-30T17:00:00Z", event_duration_minutes: 60 })).toBe(
      "Wed, Sep 30, 2026, 1:00–2:00 pm (America/New_York)",
    );
    expect(
      when({
        start_datetime: "2026-09-30T23:30:00",
        event_duration_hour: 1,
        event_duration_minutes: 0,
      }),
    ).toBe("Wed, Sep 30, 2026, 11:30 pm – Thu, Oct 1, 2026, 12:30 am (America/New_York)");
    expect(
      classifyGoogleCalendar(
        "GOOGLECALENDAR_CREATE_EVENT",
        { start_datetime: "2026-09-30T09:00:00", event_duration_minutes: 30 },
        SETTINGS,
      )?.details?.facts.find((fact) => fact.label === "When")?.value,
    ).toBe("Wed, Sep 30, 2026, 9:00–9:30 am (UTC)");
    expect(when({ start_datetime: "next Tuesday" })).toBe("next Tuesday (America/New_York)");
  });

  it("says who Google emails, in words", () => {
    const notice = (tool: string, extra: JsonObject) =>
      classifyGoogleCalendar(
        tool,
        event({ event_id: "ev1", ...extra }),
        SETTINGS,
      )?.details?.facts.find((fact) => fact.label === "Notifications")?.value;
    expect(notice("GOOGLECALENDAR_CREATE_EVENT", {})).toBe(
      "Google emails the invitation to every attendee",
    );
    expect(notice("GOOGLECALENDAR_CREATE_EVENT", { send_updates: "externalOnly" })).toBe(
      "Google emails the invitation to attendees outside the company",
    );
    expect(notice("GOOGLECALENDAR_CREATE_EVENT", { send_updates: "none" })).toBe(
      "No invitation email",
    );
    expect(notice("GOOGLECALENDAR_UPDATE_EVENT", { send_updates: "all" })).toBe(
      "Google emails the change to every attendee",
    );
    expect(notice("GOOGLECALENDAR_UPDATE_EVENT", { send_updates: "none" })).toBe(
      "No email about the change",
    );
  });

  it("keeps internal-only and attendee-free events internal", () => {
    expect(
      classOf(
        "GOOGLECALENDAR_CREATE_EVENT",
        event({ attendees: ["rep@contoso.example", "Ops <ops@eu.contoso.example>"] }),
      ),
    ).toBe("internal_write");
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({}))).toBe("internal_write");
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({ attendees: [] }))).toBe("internal_write");
    expect(classOf("GOOGLECALENDAR_CREATE_EVENT", event({ calendar_id: "primary" }))).toBe(
      "internal_write",
    );
    expect(
      classOf("GOOGLECALENDAR_CREATE_EVENT", event({ calendar_id: "rep@contoso.example" })),
    ).toBe("internal_write");
    expect(
      classifyGoogleCalendar(
        "GOOGLECALENDAR_CREATE_EVENT",
        event({ attendees: ["rep@contoso.example"] }),
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

  it("treats a group calendar as outbound unless the workspace lists it", () => {
    // Anyone can create a group calendar, share it with the user and publish it.
    const shared = event({ calendar_id: "customer-shared@group.calendar.google.com" });
    const unlisted = classifyGoogleCalendar("GOOGLECALENDAR_CREATE_EVENT", shared, SETTINGS);
    expect(unlisted?.actionClass).toBe("outbound");
    expect(unlisted?.details?.facts).toContainEqual({
      label: "Calendar",
      value: "customer-shared@group.calendar.google.com (not listed as internal)",
    });
    const listed = classifyGoogleCalendar("GOOGLECALENDAR_CREATE_EVENT", shared, {
      ...SETTINGS,
      internalCalendarIds: ["Customer-Shared@group.calendar.google.com"],
    });
    expect(listed?.actionClass).toBe("internal_write");
    expect(listed?.details?.facts).toContainEqual({
      label: "Calendar",
      value: "customer-shared@group.calendar.google.com",
    });
    // Listing one calendar does not vouch for another, and outside guests still ask.
    expect(
      classifyGoogleCalendar(
        "GOOGLECALENDAR_CREATE_EVENT",
        event({ calendar_id: "team@group.calendar.google.com" }),
        { ...SETTINGS, internalCalendarIds: ["customer-shared@group.calendar.google.com"] },
      )?.actionClass,
    ).toBe("outbound");
    expect(
      classifyGoogleCalendar(
        "GOOGLECALENDAR_CREATE_EVENT",
        { ...shared, attendees: ["ana@acme.test"] },
        { ...SETTINGS, internalCalendarIds: ["customer-shared@group.calendar.google.com"] },
      )?.actionClass,
    ).toBe("outbound");
  });

  it("asks before any update of an event whose guests the run has not read", () => {
    // UPDATE_EVENT is a full replacement: whoever the list leaves out is removed and notified.
    for (const attendees of [[], ["rep@contoso.example"], undefined]) {
      const input = event({
        event_id: "ev-with-customer",
        send_updates: "all",
        ...(attendees === undefined ? {} : { attendees }),
      });
      expect(classOf("GOOGLECALENDAR_UPDATE_EVENT", input), JSON.stringify(attendees)).toBe(
        "outbound",
      );
    }
    expect(
      classOf(
        "GOOGLECALENDAR_UPDATE_EVENT",
        event({
          event_id: "ev1",
          attendees: ["rep@contoso.example"],
          send_updates: "externalOnly",
        }),
      ),
    ).toBe("outbound");
    const unread = classifyGoogleCalendar(
      "GOOGLECALENDAR_UPDATE_EVENT",
      event({ event_id: "ev1", attendees: ["rep@contoso.example"] }),
      SETTINGS,
    );
    expect(unread?.details?.facts).toContainEqual({
      label: "Current attendees",
      value: "Not read in this run",
    });
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
      ["GOOGLECALENDAR_UPDATE_EVENT", event({ attendees: ["rep@contoso.example"] })],
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

describe("updating an event this run read", () => {
  const listed = (items: JsonValue[]): JsonValue => ({
    successful: true,
    data: { kind: "calendar#events", items },
    error: null,
  });
  const resource = (id: string, attendees?: JsonValue[]): JsonObject => ({
    kind: "calendar#event",
    id,
    summary: "Acme collections call",
    start: { dateTime: "2026-10-01T10:00:00-04:00" },
    ...(attendees === undefined ? {} : { attendees }),
  });
  const owner = { email: "maya@contoso.example", self: true, organizer: true };
  const update = (extra: JsonObject): JsonObject => ({
    event_id: "ev-with-customer",
    summary: "Acme collections call",
    start_datetime: "2026-10-01T15:00:00",
    timezone: "America/New_York",
    ...extra,
  });
  const memoryWith = (items: JsonValue[], tool = "GOOGLECALENDAR_EVENTS_LIST") => {
    const memory = new GoogleCalendarRunMemory(SETTINGS);
    memory.record(tool, {}, listed(items), false);
    return memory;
  };
  const refined = (memory: GoogleCalendarRunMemory, input: JsonObject) => {
    const base = classifyGoogleCalendar("GOOGLECALENDAR_UPDATE_EVENT", input, SETTINGS);
    if (base === null) throw new Error("unclassifiable");
    return memory.refine("GOOGLECALENDAR_UPDATE_EVENT", input, base);
  };

  it("asks when the update drops an outside guest, even with an internal-only list", () => {
    const memory = memoryWith([
      resource("ev-with-customer", [
        owner,
        { email: "ana@acme.test" },
        { email: "rep@contoso.example" },
      ]),
    ]);
    for (const attendees of [[], ["rep@contoso.example"]]) {
      const classification = refined(memory, update({ attendees, send_updates: "all" }));
      expect(classification.actionClass, JSON.stringify(attendees)).toBe("outbound");
      expect(classification.details?.facts).toContainEqual({
        label: "Current attendees",
        value: "ana@acme.test, rep@contoso.example",
      });
      expect(classification.details?.facts).toContainEqual({
        label: "Outside the company",
        value: "ana@acme.test",
      });
    }
    const dropped = refined(memory, update({ attendees: ["rep@contoso.example"] }));
    expect(dropped.details?.facts).toContainEqual({ label: "Removed", value: "ana@acme.test" });
    expect(dropped.details?.consequence).toBe(
      'Replace event ev-with-customer with "Acme collections call" with rep@contoso.example, removing ana@acme.test',
    );
    expect(dropped.details?.recipients).toEqual(["rep@contoso.example", "ana@acme.test"]);
    // Keeping the outside guest still e-mails them the change.
    expect(
      refined(memory, update({ attendees: ["ana@acme.test", "rep@contoso.example"] })).actionClass,
    ).toBe("outbound");
  });

  it("keeps an update internal when the event's known guests are all internal and stay", () => {
    const memory = memoryWith([
      resource("ev-with-customer", [owner, { email: "rep@contoso.example" }]),
    ]);
    const kept = refined(
      memory,
      update({ attendees: ["rep@contoso.example"], send_updates: "all" }),
    );
    expect(kept.actionClass).toBe("internal_write");
    expect(kept.details?.facts).toContainEqual({
      label: "Current attendees",
      value: "rep@contoso.example",
    });
    // Dropping an internal guest with a notification asks; without one it does not.
    expect(refined(memory, update({ attendees: [], send_updates: "all" })).actionClass).toBe(
      "outbound",
    );
    expect(refined(memory, update({ attendees: [], send_updates: "none" })).actionClass).toBe(
      "internal_write",
    );
    // An event without guests has nobody to drop.
    const solo = memoryWith([resource("ev-with-customer")]);
    expect(refined(solo, update({})).actionClass).toBe("internal_write");
    expect(refined(solo, update({})).details?.facts).toContainEqual({
      label: "Current attendees",
      value: "None",
    });
  });

  it("learns from searches, creates and updates, never from inputs or failures", () => {
    const memory = new GoogleCalendarRunMemory(SETTINGS);
    memory.record(
      "GOOGLECALENDAR_FIND_EVENT",
      {},
      {
        successful: true,
        data: { items: [resource("ev-a", [owner, { email: "ana@acme.test" }])] },
      },
      false,
    );
    memory.record(
      "GOOGLECALENDAR_CREATE_EVENT",
      { attendees: ["rep@contoso.example"] },
      {
        successful: true,
        data: { response_data: resource("ev-b", [owner, { email: "rep@contoso.example" }]) },
      },
      false,
    );
    expect(memory.event("ev-a")?.guests).toEqual(["ana@acme.test"]);
    expect(memory.event("ev-b")?.guests).toEqual(["rep@contoso.example"]);
    // An update's result is the event's new guest list.
    memory.record(
      "GOOGLECALENDAR_UPDATE_EVENT",
      {},
      { successful: true, data: { response_data: resource("ev-a", [owner]) } },
      false,
    );
    expect(memory.event("ev-a")?.guests).toEqual([]);
    // Failures and other tools teach nothing.
    memory.record("GOOGLECALENDAR_EVENTS_LIST", {}, listed([resource("ev-c", [])]), true);
    memory.record(
      "GOOGLECALENDAR_EVENTS_LIST",
      {},
      { successful: false, data: { items: [resource("ev-c", [])] }, error: "boom" },
      false,
    );
    memory.record("GOOGLECALENDAR_FIND_FREE_SLOTS", {}, listed([resource("ev-c", [])]), false);
    expect(memory.event("ev-c")).toBeUndefined();
  });

  it("forgets guests it can no longer read in full", () => {
    const memory = memoryWith([resource("ev-a", [{ email: "rep@contoso.example" }])]);
    expect(memory.event("ev-a")).toBeDefined();
    // Compacted output can cut an attendee list short.
    memory.record(
      "GOOGLECALENDAR_EVENTS_LIST",
      {},
      listed([resource("ev-a", [{ email: "rep@contoso.example" }, "… 3 more items"])]),
      false,
    );
    expect(memory.event("ev-a")).toBeUndefined();
    expect(
      refined(memory, update({ event_id: "ev-a", attendees: ["rep@contoso.example"] })).actionClass,
    ).toBe("outbound");
  });

  it("is the Calendar integration's run memory", () => {
    const memory = createGoogleCalendarIntegration().runMemory?.(SETTINGS);
    expect(memory).toBeInstanceOf(GoogleCalendarRunMemory);
    // Other tools pass through unchanged.
    const create = classifyGoogleCalendar("GOOGLECALENDAR_CREATE_EVENT", update({}), SETTINGS);
    if (create === null || memory === undefined) throw new Error("unexpected");
    expect(memory.refine("GOOGLECALENDAR_CREATE_EVENT", update({}), create)).toBe(create);
  });
});
