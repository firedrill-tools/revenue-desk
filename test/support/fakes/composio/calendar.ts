/**
 * The calendar behind the Composio fake's GOOGLECALENDAR_* tools, loaded
 * from test/fixtures/business/google-calendar.json. Inputs follow the
 * captured Composio schemas; results are Google Calendar API resources
 * (events, free/busy), with create and update wrapped in `response_data` as
 * the Composio tool descriptions state.
 *
 * Every invitation or update e-mailed to an attendee is recorded in
 * `invitations` (per `send_updates`, default "all"), so tests can prove that
 * an external attendee was invited only after approval.
 */
import type { JsonObject, JsonValue } from "../../../../src/contracts/json.js";
import { type FakeClock, instantFromLocal, isoInZone } from "../core/clock.js";
import type { CalendarFixture } from "../fixtures.js";
import { ToolError } from "./gmail.js";

interface Attendee {
  readonly email: string;
  readonly optional: boolean;
  readonly displayName: string | null;
}

interface CalendarEvent {
  readonly id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date;
  timeZone: string;
  attendees: Attendee[];
  readonly created: string;
  updated: string;
  status: "confirmed" | "cancelled";
  hangoutLink: string | null;
  sequence: number;
}

/** An invitation or update e-mailed to an attendee. */
export interface CalendarInvitation {
  readonly eventId: string;
  readonly email: string;
  readonly kind: "invitation" | "update";
  readonly summary: string;
  readonly start: string;
  readonly at: string;
}

type Args = Readonly<Record<string, JsonValue>>;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class GoogleCalendar {
  readonly owner: string;
  readonly timezone: string;
  readonly invitations: CalendarInvitation[] = [];
  private readonly events: CalendarEvent[] = [];
  private sequence = 0;

  constructor(
    fixture: CalendarFixture,
    private readonly clock: FakeClock,
  ) {
    this.owner = fixture.calendarId;
    this.timezone = fixture.timezone;
    for (const event of fixture.events) {
      this.events.push({
        id: event.id,
        summary: event.summary,
        description: event.description ?? null,
        location: null,
        start: new Date(event.start),
        end: new Date(event.end),
        timeZone: fixture.timezone,
        attendees: [this.owner, ...event.attendees].map((email) => ({
          email,
          optional: false,
          displayName: null,
        })),
        created: "2026-09-01T12:00:00.000Z",
        updated: "2026-09-01T12:00:00.000Z",
        status: "confirmed",
        hangoutLink: null,
        sequence: 0,
      });
    }
  }

  /** Events created or changed by clients, for assertions. */
  event(id: string): JsonObject | undefined {
    const event = this.events.find((entry) => entry.id === id);
    return event === undefined ? undefined : this.render(event, this.timezone);
  }

  createdEvents(): JsonObject[] {
    return this.events
      .filter((event) => event.id.startsWith("rdevent"))
      .map((event) => this.render(event, this.timezone));
  }

  // --- Tools ------------------------------------------------------------------

  /** GOOGLECALENDAR_EVENTS_LIST: a Calendar API events list. */
  eventsList(args: Args): JsonObject {
    this.calendar(args.calendarId);
    if (args.orderBy === "startTime" && args.singleEvents !== true) {
      throw new ToolError(
        "The requested ordering is not available for the particular query: orderBy=startTime requires singleEvents=true.",
      );
    }
    const zone = typeof args.timeZone === "string" ? args.timeZone : this.timezone;
    const matching = this.window({
      timeMin: rfc3339(args.timeMin, "timeMin"),
      timeMax: rfc3339(args.timeMax, "timeMax"),
      query: typeof args.query === "string" ? args.query : "",
      showDeleted: args.showDeleted === true,
    });
    const limit = typeof args.maxResults === "number" ? args.maxResults : 250;
    const { page, next } = paginate(matching, args.pageToken, limit);
    return {
      kind: "calendar#events",
      summary: this.owner,
      timeZone: zone,
      items: page.map((event) => this.render(event, zone)),
      ...(next === null ? {} : { nextPageToken: next }),
    };
  }

  /** GOOGLECALENDAR_FIND_EVENT: `{items, nextPageToken?}`. */
  findEvent(args: Args): JsonObject {
    this.calendar(args.calendar_id);
    const matching = this.window({
      timeMin: flexible(args.time_min, this.timezone, "time_min"),
      timeMax: flexible(args.time_max, this.timezone, "time_max"),
      query: typeof args.query === "string" ? args.query : "",
      showDeleted: args.show_deleted === true,
    });
    const { page, next } = paginate(
      matching,
      args.page_token,
      typeof args.max_results === "number" ? args.max_results : 10,
    );
    return {
      items: page.map((event) => this.render(event, this.timezone)),
      ...(next === null ? {} : { nextPageToken: next }),
    };
  }

  /** GOOGLECALENDAR_FIND_FREE_SLOTS: free/busy per calendar with the free gaps computed. */
  findFreeSlots(args: Args): JsonObject {
    const zone = typeof args.timezone === "string" ? args.timezone : "UTC";
    const now = this.clock.now();
    const min = flexible(args.time_min, zone, "time_min") ?? now;
    const max = flexible(args.time_max, zone, "time_max") ?? endOfDay(min, zone);
    if (min.getTime() >= max.getTime()) throw new ToolError("time_min must precede time_max.");
    const calendars: Record<string, JsonValue> = {};
    for (const id of stringList(args.items ?? ["primary"])) {
      if (id !== "primary" && id !== this.owner) {
        calendars[id] = { errors: [{ domain: "global", reason: "notFound" }], busy: [], free: [] };
        continue;
      }
      const busy = this.events
        .filter((event) => event.status === "confirmed" && event.start < max && event.end > min)
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .map((event) => ({
          start: new Date(Math.max(event.start.getTime(), min.getTime())),
          end: new Date(Math.min(event.end.getTime(), max.getTime())),
        }));
      const free: { start: Date; end: Date }[] = [];
      let cursor = min;
      for (const interval of busy) {
        if (interval.start > cursor) free.push({ start: cursor, end: interval.start });
        if (interval.end > cursor) cursor = interval.end;
      }
      if (cursor < max) free.push({ start: cursor, end: max });
      const format = (entry: { start: Date; end: Date }) => ({
        start: stamp(entry.start, zone),
        end: stamp(entry.end, zone),
      });
      calendars[id] = { busy: busy.map(format), free: free.map(format) };
    }
    return {
      kind: "calendar#freeBusy",
      timeMin: stamp(min, zone),
      timeMax: stamp(max, zone),
      calendars,
    };
  }

  /** GOOGLECALENDAR_CREATE_EVENT: `{response_data: event}`. */
  createEvent(args: Args): JsonObject {
    this.calendar(args.calendar_id);
    const zone = typeof args.timezone === "string" ? args.timezone : "UTC";
    const start = required(
      instantFromLocal(String(args.start_datetime ?? ""), zone),
      "start_datetime",
    );
    const end = this.endOf(start, args, zone);
    const attendees = attendeesOf(args.attendees);
    const organizer =
      args.exclude_organizer === true
        ? []
        : [{ email: this.owner, optional: false, displayName: null }];
    this.sequence += 1;
    const at = this.clock.now().toISOString();
    const event: CalendarEvent = {
      id: `rdevent${String(this.sequence).padStart(4, "0")}`,
      summary: typeof args.summary === "string" ? args.summary : "(No title)",
      description: typeof args.description === "string" ? args.description : null,
      location: typeof args.location === "string" ? args.location : null,
      start,
      end,
      timeZone: zone,
      attendees: [...organizer, ...attendees.filter((attendee) => attendee.email !== this.owner)],
      created: at,
      updated: at,
      status: "confirmed",
      hangoutLink:
        args.create_meeting_room === false
          ? null
          : `https://meet.google.test/rdf-${String(this.sequence).padStart(4, "0")}-kst`,
      sequence: 0,
    };
    this.events.push(event);
    this.notify(event, event.attendees, "invitation", args.send_updates);
    return { response_data: this.render(event, zone) };
  }

  /** GOOGLECALENDAR_UPDATE_EVENT: `{response_data: event}`. */
  updateEvent(args: Args): JsonObject {
    this.calendar(args.calendar_id);
    const id = String(args.event_id ?? "");
    const event = this.events.find((entry) => entry.id === id && entry.status === "confirmed");
    if (event === undefined) throw new ToolError(`Not Found: event ${id} does not exist.`);
    const zone = typeof args.timezone === "string" ? args.timezone : event.timeZone;
    event.start = required(
      instantFromLocal(String(args.start_datetime ?? ""), zone),
      "start_datetime",
    );
    event.end = this.endOf(event.start, args, zone);
    event.timeZone = zone;
    if (typeof args.summary === "string") event.summary = args.summary;
    if (typeof args.description === "string") event.description = args.description;
    if (typeof args.location === "string") event.location = args.location;
    const before = new Set(event.attendees.map((attendee) => attendee.email));
    if (args.attendees !== undefined) {
      event.attendees = [
        { email: this.owner, optional: false, displayName: null },
        ...attendeesOf(args.attendees).filter((attendee) => attendee.email !== this.owner),
      ];
    }
    event.sequence += 1;
    event.updated = this.clock.now().toISOString();
    this.notify(
      event,
      event.attendees.filter((attendee) => !before.has(attendee.email)),
      "invitation",
      args.send_updates,
    );
    this.notify(
      event,
      event.attendees.filter((attendee) => before.has(attendee.email)),
      "update",
      args.send_updates,
    );
    return { response_data: this.render(event, zone) };
  }

  // --- Internals ---------------------------------------------------------------

  private calendar(id: JsonValue | undefined): void {
    if (id !== undefined && id !== "primary" && id !== this.owner) {
      throw new ToolError(`Not Found: calendar ${String(id)} is not in the user's calendar list.`);
    }
  }

  private window(filter: {
    readonly timeMin: Date | null;
    readonly timeMax: Date | null;
    readonly query: string;
    readonly showDeleted: boolean;
  }): CalendarEvent[] {
    const query = filter.query.toLowerCase();
    return this.events
      .filter(
        (event) =>
          (filter.showDeleted || event.status === "confirmed") &&
          (filter.timeMin === null || event.end > filter.timeMin) &&
          (filter.timeMax === null || event.start < filter.timeMax) &&
          (query === "" ||
            [
              event.summary,
              event.description ?? "",
              event.location ?? "",
              ...event.attendees.map((attendee) => attendee.email),
            ].some((text) => text.toLowerCase().includes(query))),
      )
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  private endOf(start: Date, args: Args, zone: string): Date {
    if (typeof args.end_datetime === "string" && args.end_datetime !== "") {
      const end = required(instantFromLocal(args.end_datetime, zone), "end_datetime");
      if (end <= start) throw new ToolError("end_datetime must be after start_datetime.");
      return end;
    }
    const hours = typeof args.event_duration_hour === "number" ? args.event_duration_hour : 0;
    const minutes =
      typeof args.event_duration_minutes === "number" ? args.event_duration_minutes : 30;
    if (hours * 60 + minutes <= 0)
      throw new ToolError("The combined duration (hours + minutes) must be greater than 0.");
    return new Date(start.getTime() + (hours * 60 + minutes) * 60_000);
  }

  private notify(
    event: CalendarEvent,
    attendees: readonly Attendee[],
    kind: CalendarInvitation["kind"],
    sendUpdates: JsonValue | undefined,
  ): void {
    const mode = typeof sendUpdates === "string" ? sendUpdates : "all";
    if (mode === "none") return;
    const ownerDomain = this.owner.split("@")[1] ?? "";
    for (const attendee of attendees) {
      if (attendee.email === this.owner) continue;
      if (mode === "externalOnly" && attendee.email.endsWith(`@${ownerDomain}`)) continue;
      this.invitations.push({
        eventId: event.id,
        email: attendee.email,
        kind,
        summary: event.summary,
        start: event.start.toISOString(),
        at: this.clock.now().toISOString(),
      });
    }
  }

  private render(event: CalendarEvent, zone: string): JsonObject {
    return {
      kind: "calendar#event",
      id: event.id,
      status: event.status,
      htmlLink: `https://calendar.google.test/event?eid=${event.id}`,
      created: event.created,
      updated: event.updated,
      summary: event.summary,
      ...(event.description === null ? {} : { description: event.description }),
      ...(event.location === null ? {} : { location: event.location }),
      creator: { email: this.owner, self: true },
      organizer: { email: this.owner, self: true },
      start: { dateTime: stamp(event.start, zone), timeZone: event.timeZone },
      end: { dateTime: stamp(event.end, zone), timeZone: event.timeZone },
      iCalUID: `${event.id}@google.test`,
      sequence: event.sequence,
      attendees: event.attendees.map((attendee) => ({
        email: attendee.email,
        ...(attendee.displayName === null ? {} : { displayName: attendee.displayName }),
        ...(attendee.email === this.owner
          ? { organizer: true, self: true, responseStatus: "accepted" }
          : { responseStatus: "needsAction" }),
        ...(attendee.optional ? { optional: true } : {}),
      })),
      ...(event.hangoutLink === null ? {} : { hangoutLink: event.hangoutLink }),
      reminders: { useDefault: true },
      eventType: "default",
    };
  }
}

function attendeesOf(value: JsonValue | undefined): Attendee[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolError("attendees must be a list.");
  return value.map((entry) => {
    if (typeof entry === "string") {
      if (!EMAIL.test(entry)) throw new ToolError(`Invalid attendee email: ${entry}`);
      return { email: entry.toLowerCase(), optional: false, displayName: null };
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new ToolError("Invalid attendee.");
    const record = entry as JsonObject;
    const email = typeof record.email === "string" ? record.email : "";
    if (!EMAIL.test(email)) throw new ToolError(`Invalid attendee email: ${email}`);
    return {
      email: email.toLowerCase(),
      optional: record.optional === true,
      displayName: typeof record.displayName === "string" ? record.displayName : null,
    };
  });
}

function rfc3339(value: JsonValue | undefined, name: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new ToolError(
      `Bad Request: ${name} must be an RFC3339 timestamp with a time zone offset.`,
    );
  }
  return new Date(Date.parse(text));
}

function flexible(value: JsonValue | undefined, zone: string, name: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const instant = instantFromLocal(String(value).replace(",", "T"), zone);
  if (instant === null) throw new ToolError(`Could not parse ${name}: ${String(value)}`);
  return instant;
}

function required(value: Date | null, name: string): Date {
  if (value === null) throw new ToolError(`${name} must be an ISO 8601 date-time.`);
  return value;
}

function endOfDay(instant: Date, zone: string): Date {
  const day = isoInZone(instant, zone).slice(0, 10);
  return instantFromLocal(`${day}T23:59:59`, zone) ?? instant;
}

/** RFC3339 in a zone without milliseconds, as Google renders it. */
function stamp(instant: Date, zone: string): string {
  return isoInZone(instant, zone).replace(/\.\d{3}/, "");
}

function stringList(value: JsonValue): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function paginate<T>(
  items: readonly T[],
  token: JsonValue | undefined,
  size: number,
): { readonly page: T[]; readonly next: string | null } {
  let offset = 0;
  if (typeof token === "string" && token !== "") {
    const match = /^offset:(\d+)$/.exec(Buffer.from(token, "base64url").toString("utf8"));
    if (match === null) throw new ToolError("Invalid page token.");
    offset = Number(match[1]);
  }
  const limit = Math.max(1, Math.trunc(size));
  const page = items.slice(offset, offset + limit);
  return {
    page,
    next:
      offset + limit < items.length
        ? Buffer.from(`offset:${offset + limit}`).toString("base64url")
        : null,
  };
}
