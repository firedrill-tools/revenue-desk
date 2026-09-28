// The Google Calendar tools of the composio profile (docs/ARCHITECTURE.md §2).
// Slugs equal COMPOSIO_ALLOWLISTS.googlecalendar in composio/session.ts.

import type { ActionClass, ToolSpec } from "../../contracts/integration.js";
import { defineProfile } from "../shared/profile.js";

const spec = (
  name: string,
  operation: ToolSpec["operation"],
  title: string,
  baseClass: ActionClass,
): ToolSpec => ({
  name,
  upstream: name,
  operation,
  title,
  baseClass,
  readOnly: baseClass === "read",
});

export const GOOGLE_CALENDAR_PROFILE = defineProfile("composio", "google_calendar", [
  spec("GOOGLECALENDAR_EVENTS_LIST", "google_calendar.events.list", "List calendar events", "read"),
  spec(
    "GOOGLECALENDAR_FIND_FREE_SLOTS",
    "google_calendar.freebusy.query",
    "Find free calendar slots",
    "read",
  ),
  spec("GOOGLECALENDAR_FIND_EVENT", "google_calendar.events.find", "Find calendar event", "read"),
  spec(
    "GOOGLECALENDAR_CREATE_EVENT",
    "google_calendar.events.create",
    "Create calendar event",
    "outbound",
  ),
  spec(
    "GOOGLECALENDAR_UPDATE_EVENT",
    "google_calendar.events.update",
    "Update calendar event",
    "outbound",
  ),
]);
