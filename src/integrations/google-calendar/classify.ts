// Classifies Google Calendar (Composio) calls (docs/ARCHITECTURE.md §2, §7).
// Reads are read. Creating or updating an event is outbound when it reaches
// anyone outside internalEmailDomains, and internal_write otherwise:
//   - any attendee outside the internal domains makes it outbound;
//   - an event on another person's calendar (calendar_id outside the internal
//     domains) is outbound;
//   - GOOGLECALENDAR_UPDATE_EVENT is a full replacement, so an update without
//     an attendee list removes (and may notify) the existing attendees, who
//     cannot be seen from the input: outbound.
// Attendees that are not email addresses make the call unclassifiable (deny).

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { isInternalAddress, parseAddress } from "../shared/email.js";
import { arr, field, isObject, num, str } from "../shared/json.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { countOf, listOf, preview } from "../shared/text.js";
import { GOOGLE_CALENDAR_PROFILE } from "./profile.js";

type EventWrite = "create" | "update";

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

/** The calendar an event is written to, and whether it belongs to someone outside. */
function calendarOf(
  input: JsonObject,
  settings: ClassifierSettings,
): { readonly label: string; readonly external: boolean } {
  const id = str(input, "calendar_id");
  if (id === undefined || id === "primary") return { label: "Primary", external: false };
  if (id.toLowerCase().endsWith("@group.calendar.google.com"))
    return { label: id, external: false };
  const address = parseAddress(id);
  return {
    label: id,
    external: address === null || !isInternalAddress(address, settings.internalEmailDomains),
  };
}

function when(input: JsonObject): string | null {
  const start = str(input, "start_datetime");
  if (start === undefined) return null;
  const zone = str(input, "timezone");
  const end = str(input, "end_datetime");
  const minutes =
    (num(input, "event_duration_hour") ?? 0) * 60 + (num(input, "event_duration_minutes") ?? 0);
  const until = end !== undefined ? ` to ${end}` : minutes > 0 ? ` for ${minutes} min` : "";
  return `${start}${until}${zone === undefined ? "" : ` (${zone})`}`;
}

function classifyEventWrite(
  kind: EventWrite,
  input: JsonObject,
  settings: ClassifierSettings,
): Classification | null {
  const attendees = attendeesOf(input);
  if (attendees === null) return null;
  const eventId = str(input, "event_id");
  if (kind === "update" && eventId === undefined) return null;
  const listed = attendees ?? [];
  const external = listed.filter((a) => !isInternalAddress(a, settings.internalEmailDomains));
  const calendar = calendarOf(input, settings);
  const replacesAttendees = kind === "update" && attendees === undefined;

  const summary = str(input, "summary");
  const facts: ApprovalFact[] = [];
  if (summary !== undefined) facts.push({ label: "Title", value: preview(summary, 120) });
  const time = when(input);
  if (time !== null) facts.push({ label: "When", value: time });
  facts.push({
    label: "Attendees",
    value: replacesAttendees
      ? "None listed: existing attendees are removed"
      : listed.length === 0
        ? "None"
        : listed.join(", "),
  });
  if (external.length > 0) facts.push({ label: "Outside the company", value: external.join(", ") });
  if (calendar.label !== "Primary") facts.push({ label: "Calendar", value: calendar.label });
  const notify = str(input, "send_updates");
  if (notify !== undefined) facts.push({ label: "Notifications", value: notify });
  if (kind === "update") facts.push({ label: "Event", value: eventId ?? "" });

  const named = summary === undefined ? "an event" : `"${preview(summary, 60)}"`;
  const guests = listed.length === 0 ? "" : ` with ${listOf(listed)}`;
  const consequence =
    kind === "create"
      ? `Create ${named} in Google Calendar${guests}`
      : `Replace event ${eventId} with ${named}${guests}${replacesAttendees ? ", removing its attendees" : ""}`;
  const details = {
    consequence,
    facts,
    ...(listed.length === 0 ? {} : { recipients: listed }),
    ...(eventId === undefined ? {} : { recordIds: [eventId] }),
  };
  const operation =
    kind === "create" ? "google_calendar.events.create" : "google_calendar.events.update";
  const title =
    external.length > 0
      ? `${kind === "create" ? "Invite" : "Update invite for"} ${countOf(external.length, "outside guest")} in Google Calendar`
      : kind === "create"
        ? "Create calendar event"
        : "Update calendar event";
  const outbound = external.length > 0 || calendar.external || replacesAttendees;
  return outbound
    ? { actionClass: "outbound", operation, title, details }
    : { actionClass: "internal_write", operation, title, details };
}

export function classifyGoogleCalendar(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
): Classification | null {
  const spec = specOf(GOOGLE_CALENDAR_PROFILE, tool);
  if (spec === undefined) return null;
  switch (spec.name) {
    case "GOOGLECALENDAR_CREATE_EVENT":
      return classifyEventWrite("create", input, settings);
    case "GOOGLECALENDAR_UPDATE_EVENT":
      return classifyEventWrite("update", input, settings);
    default:
      return fromSpec(spec);
  }
}
