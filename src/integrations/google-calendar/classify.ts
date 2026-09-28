// Classifies Google Calendar (Composio) calls (docs/ARCHITECTURE.md §2, §7).
// Reads are read. Creating or updating an event is outbound when it reaches
// anyone outside internalEmailDomains, and internal_write otherwise:
//   - any attendee outside the internal domains makes it outbound;
//   - an event on a calendar that is not the user's own is outbound: only
//     "primary", a calendar id that is an internal address, and the ids in
//     internalCalendarIds count as internal. A shared or group calendar
//     (…@group.calendar.google.com) can belong to anyone, so it is outbound
//     until the workspace lists it;
//   - GOOGLECALENDAR_UPDATE_EVENT is a full PUT replacement: the attendees it
//     does not list are removed and, unless send_updates is "none", e-mailed
//     a cancellation. Its guests before the update are known only when this
//     run read or wrote the event (GoogleCalendarRunMemory in run-memory.ts,
//     `known` here), so an update is outbound unless the run knows that the
//     event's current guests are all internal and none of them is dropped
//     with a notification.
// Attendees that are not email addresses make the call unclassifiable (deny).

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { isInternalAddress, parseAddress } from "../shared/email.js";
import { arr, asObject, bool, field, isObject, num, obj, str } from "../shared/json.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { countOf, listOf, preview } from "../shared/text.js";
import { GOOGLE_CALENDAR_PROFILE } from "./profile.js";

type EventWrite = "create" | "update";

/** An event as a Calendar result in this run described it. */
export type KnownEvent = {
  readonly id: string;
  /** Its guests' addresses, without the calendar's owner (the attendee marked `self`). */
  readonly guests: readonly string[];
};

/** Lookups into what the run's earlier Calendar calls returned. */
export interface CalendarKnown {
  event(id: string): KnownEvent | undefined;
}

const NOTHING_KNOWN: CalendarKnown = { event: () => undefined };

/** Attendee emails from strings or {email} objects; undefined when absent, null when invalid. */
function attendeesOf(input: JsonObject): string[] | null | undefined {
  const value = field(input, "attendees");
  if (value === undefined || value === null) return undefined;
  const items = arr(input, "attendees");
  if (items === undefined) return null;
  const out: string[] = [];
  for (const item of items) {
    const raw = typeof item === "string" ? item : isObject(item) ? str(item, "email") : undefined;
    if (raw === undefined) return null;
    const address = parseAddress(raw);
    if (address === null) return null;
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

/** The calendar an event is written to, and whether it may belong to someone outside. */
function calendarOf(
  input: JsonObject,
  settings: ClassifierSettings,
): { readonly label: string; readonly external: boolean } {
  const id = str(input, "calendar_id");
  if (id === undefined || id === "primary") return { label: "Primary", external: false };
  const listed = settings.internalCalendarIds.some(
    (internal) => internal.trim().toLowerCase() === id.trim().toLowerCase(),
  );
  if (listed) return { label: id, external: false };
  const address = parseAddress(id);
  const internal =
    address !== null &&
    !address.endsWith(".calendar.google.com") &&
    isInternalAddress(address, settings.internalEmailDomains);
  return { label: id, external: !internal };
}

// --- When -----------------------------------------------------------------------

type WallClock = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
};

const LOCAL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{1,2}(?::?\d{2})?)?$/i;

const zoneParts = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  if (zoneParts.has(zone)) return zoneParts.get(zone) ?? null;
  let format: Intl.DateTimeFormat | null;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    format = null;
  }
  zoneParts.set(zone, format);
  return format;
}

/** The wall-clock time of an instant in `zone`; null when the zone is unknown. */
function wallClockIn(ms: number, zone: string): WallClock | null {
  const format = zoneFormatter(zone);
  if (format === null) return null;
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute } = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null;
  }
  return { year, month, day, hour, minute };
}

/**
 * The wall-clock time of a Composio start/end value: a naive local time is
 * taken as it is (it is in the event's time zone); a time with an offset is
 * shown in the event's zone when one is given, otherwise as written.
 */
function wallClock(value: string, zone: string | undefined): WallClock | null {
  const match = LOCAL_TIME.exec(value.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, offset] = match;
  const written: WallClock = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
  };
  if (offset === undefined || zone === undefined) return written;
  const ms = Date.parse(value.trim().replace(" ", "T"));
  return Number.isNaN(ms) ? written : (wallClockIn(ms, zone) ?? written);
}

function asUtc(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
}

function fromUtc(ms: number): WallClock {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Wed, Sep 30, 2026" */
function dayText(clock: WallClock): string {
  return DAY_FORMAT.format(new Date(asUtc(clock)));
}

/** "1:00 pm", or "1:00" when the meridiem is written once for a range. */
function timeText(clock: WallClock, meridiem = true): string {
  const hour = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  const text = `${hour}:${String(clock.minute).padStart(2, "0")}`;
  return meridiem ? `${text} ${clock.hour < 12 ? "am" : "pm"}` : text;
}

function sameDay(a: WallClock, b: WallClock): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * When the event is, as a reviewer checks it: "Wed, Sep 30, 2026, 1:00–1:30 pm
 * (America/New_York)". A value that does not parse is shown as written.
 */
export function eventWhen(input: JsonObject): string | null {
  const startText = str(input, "start_datetime");
  if (startText === undefined) return null;
  const zone = str(input, "timezone");
  const suffix = ` (${zone ?? "UTC"})`;
  const start = wallClock(startText, zone);
  if (start === null) return `${startText}${suffix}`;
  const endText = str(input, "end_datetime");
  const minutes =
    (num(input, "event_duration_hour") ?? 0) * 60 + (num(input, "event_duration_minutes") ?? 0);
  const end =
    endText !== undefined
      ? wallClock(endText, zone)
      : minutes > 0
        ? fromUtc(asUtc(start) + minutes * 60_000)
        : null;
  if (end === null) return `${dayText(start)}, ${timeText(start)}${suffix}`;
  if (!sameDay(start, end)) {
    return `${dayText(start)}, ${timeText(start)} – ${dayText(end)}, ${timeText(end)}${suffix}`;
  }
  const oneMeridiem = start.hour < 12 === end.hour < 12;
  return `${dayText(start)}, ${timeText(start, !oneMeridiem)}–${timeText(end)}${suffix}`;
}

/** Google's send_updates value as what happens (the tools default to "all"). */
function notificationText(kind: EventWrite, value: string | undefined): string {
  const what = kind === "create" ? "the invitation" : "the change";
  switch (value) {
    case "none":
      return kind === "create" ? "No invitation email" : "No email about the change";
    case "externalOnly":
      return `Google emails ${what} to attendees outside the company`;
    default:
      return `Google emails ${what} to every attendee`;
  }
}

// --- Events the run read --------------------------------------------------------

/** The guests of one event resource; null when its attendee list cannot be read in full. */
function guestsOf(event: JsonObject): string[] | null {
  const value = field(event, "attendees");
  // Google leaves `attendees` out of an event without guests.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return null;
    const raw = str(entry, "email");
    const address = raw === undefined ? null : parseAddress(raw);
    if (address === null) return null;
    if (bool(entry, "self") === true) continue;
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

function isEventResource(value: JsonObject): boolean {
  return (
    str(value, "id") !== undefined &&
    (field(value, "attendees") !== undefined ||
      field(value, "start") !== undefined ||
      field(value, "summary") !== undefined ||
      str(value, "kind") === "calendar#event")
  );
}

/**
 * The events a Calendar result describes, with their guests: an events list
 * (`items`), or a created or updated event (bare or under `response_data`),
 * inside Composio's `{successful, data, error}` envelope or without it. An
 * event whose attendee list is cut short (compacted output) is left out, so
 * it stays unknown. A failed result describes nothing.
 */
export function eventsFromResult(output: JsonValue): {
  readonly known: readonly KnownEvent[];
  /** Events named in the result whose guests could not be read in full. */
  readonly unreadable: readonly string[];
} {
  const known: KnownEvent[] = [];
  const unreadable: string[] = [];
  const root = asObject(output);
  if (root === undefined || field(root, "successful") === false) return { known, unreadable };
  const body = obj(root, "data") ?? root;
  const candidates: JsonObject[] = [];
  for (const container of [body, obj(body, "response_data"), obj(body, "event_data")]) {
    if (container === undefined) continue;
    if (isEventResource(container)) candidates.push(container);
    for (const item of arr(container, "items") ?? []) if (isObject(item)) candidates.push(item);
  }
  for (const event of candidates) {
    const id = str(event, "id");
    if (id === undefined) continue;
    const guests = guestsOf(event);
    if (guests === null) unreadable.push(id);
    else known.push({ id, guests });
  }
  return { known, unreadable };
}

// --- Classification ---------------------------------------------------------------

function classifyEventWrite(
  kind: EventWrite,
  input: JsonObject,
  settings: ClassifierSettings,
  known: CalendarKnown,
): Classification | null {
  const attendees = attendeesOf(input);
  if (attendees === null) return null;
  const eventId = str(input, "event_id");
  if (kind === "update" && eventId === undefined) return null;
  const isExternal = (address: string) =>
    !isInternalAddress(address, settings.internalEmailDomains);
  const listed = attendees ?? [];
  const external = listed.filter(isExternal);
  const calendar = calendarOf(input, settings);
  const notify = str(input, "send_updates");
  const notifies = notify !== "none";

  // An update replaces the guest list; what it drops depends on the event's guests before it.
  const prior = kind === "update" && eventId !== undefined ? known.event(eventId) : undefined;
  const removed = prior === undefined ? [] : prior.guests.filter((a) => !listed.includes(a));
  const priorExternal = prior === undefined ? [] : prior.guests.filter(isExternal);
  const clearsUnknownGuests = kind === "update" && prior === undefined && attendees === undefined;

  const summary = str(input, "summary");
  const facts: ApprovalFact[] = [];
  if (summary !== undefined) facts.push({ label: "Title", value: preview(summary, 120) });
  const time = eventWhen(input);
  if (time !== null) facts.push({ label: "When", value: time });
  facts.push({
    label: "Attendees",
    value: clearsUnknownGuests
      ? "None listed: existing attendees are removed"
      : listed.length === 0
        ? "None"
        : listed.join(", "),
  });
  if (kind === "update") {
    facts.push({
      label: "Current attendees",
      value:
        prior === undefined
          ? "Not read in this run"
          : prior.guests.length === 0
            ? "None"
            : prior.guests.join(", "),
    });
    if (removed.length > 0) facts.push({ label: "Removed", value: removed.join(", ") });
  }
  const outside = [...new Set([...external, ...priorExternal])];
  if (outside.length > 0) facts.push({ label: "Outside the company", value: outside.join(", ") });
  if (calendar.label !== "Primary") {
    facts.push({
      label: "Calendar",
      value: calendar.external ? `${calendar.label} (not listed as internal)` : calendar.label,
    });
  }
  facts.push({ label: "Notifications", value: notificationText(kind, notify) });
  if (kind === "update") facts.push({ label: "Event", value: eventId ?? "" });

  const named = summary === undefined ? "an event" : `"${preview(summary, 60)}"`;
  const guests = listed.length === 0 ? "" : ` with ${listOf(listed)}`;
  const dropping =
    removed.length > 0
      ? `, removing ${listOf(removed)}`
      : clearsUnknownGuests
        ? ", removing its attendees"
        : "";
  const consequence =
    kind === "create"
      ? `Create ${named} in Google Calendar${guests}`
      : `Replace event ${eventId} with ${named}${guests}${dropping}`;
  const reached = [...new Set([...listed, ...removed])];
  const details = {
    consequence,
    facts,
    ...(reached.length === 0 ? {} : { recipients: reached }),
    ...(eventId === undefined ? {} : { recordIds: [eventId] }),
  };
  const operation =
    kind === "create" ? "google_calendar.events.create" : "google_calendar.events.update";
  const title =
    outside.length > 0
      ? `${kind === "create" ? "Invite" : "Update invite for"} ${countOf(outside.length, "outside guest")} in Google Calendar`
      : kind === "create"
        ? "Create calendar event"
        : "Update calendar event";
  const outbound =
    external.length > 0 ||
    calendar.external ||
    (kind === "update" &&
      (prior === undefined || priorExternal.length > 0 || (removed.length > 0 && notifies)));
  return outbound
    ? { actionClass: "outbound", operation, title, details }
    : { actionClass: "internal_write", operation, title, details };
}

/**
 * The classification of a Calendar call. `known` holds what the run's earlier
 * Calendar calls returned (GoogleCalendarRunMemory); without it an update is
 * always outbound, because the guests it may drop are unknown.
 */
export function classifyGoogleCalendar(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
  known: CalendarKnown = NOTHING_KNOWN,
): Classification | null {
  const spec = specOf(GOOGLE_CALENDAR_PROFILE, tool);
  if (spec === undefined) return null;
  switch (spec.name) {
    case "GOOGLECALENDAR_CREATE_EVENT":
      return classifyEventWrite("create", input, settings, known);
    case "GOOGLECALENDAR_UPDATE_EVENT":
      return classifyEventWrite("update", input, settings, known);
    default:
      return fromSpec(spec);
  }
}
