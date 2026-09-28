// What a run remembers about the Calendar events it read or wrote (the
// gateway's RunMemory, src/gateway/catalog.ts). GOOGLECALENDAR_UPDATE_EVENT
// replaces an event's guest list, so whether an update reaches someone
// outside the company depends on who the event invites now, which its input
// does not say. The guests come from this run's events lists, event searches
// and the events it created or updated (classify.ts). Only Calendar's own
// results are remembered, never the model's inputs, and a failed call
// teaches nothing; an event the run has not seen stays unknown, and an
// update of it is outbound.

import type { Classification, ClassifierSettings } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import {
  type CalendarKnown,
  classifyGoogleCalendar,
  eventsFromResult,
  type KnownEvent,
} from "./classify.js";

const EVENT_RESULTS = new Set([
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_FIND_EVENT",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_UPDATE_EVENT",
]);

export class GoogleCalendarRunMemory implements RunMemory, CalendarKnown {
  readonly #settings: ClassifierSettings;
  readonly #events = new Map<string, KnownEvent>();

  constructor(settings: ClassifierSettings) {
    this.#settings = settings;
  }

  event(id: string): KnownEvent | undefined {
    return this.#events.get(id);
  }

  record(tool: string, _input: JsonObject, output: JsonValue, isError: boolean): void {
    if (isError || !EVENT_RESULTS.has(tool)) return;
    const { known, unreadable } = eventsFromResult(output);
    for (const event of known) this.#events.set(event.id, event);
    // A later result that no longer shows the guests in full makes them unknown again.
    for (const id of unreadable) this.#events.delete(id);
  }

  refine(tool: string, input: JsonObject, classification: Classification): Classification {
    if (tool !== "GOOGLECALENDAR_UPDATE_EVENT") return classification;
    return classifyGoogleCalendar(tool, input, this.#settings, this) ?? classification;
  }
}
