// The Google Calendar integration: Composio kind, toolkit googlecalendar.

import { INTEGRATIONS } from "../../contracts/integration.js";
import { ComposioConnectors, probeComposio } from "../composio/connector.js";
import type { ComposioIntegration } from "../composio/integration.js";
import { resolveComposioConfig } from "../composio/resolve.js";
import { allowedTools } from "../composio/session.js";
import { classifyGoogleCalendar } from "./classify.js";
import { GOOGLE_CALENDAR_PROFILE } from "./profile.js";
import { GoogleCalendarRunMemory } from "./run-memory.js";

export function createGoogleCalendarIntegration(
  connectors: ComposioConnectors = new ComposioConnectors(),
): ComposioIntegration<"google_calendar"> {
  return {
    id: "google_calendar",
    label: INTEGRATIONS.google_calendar.label,
    kind: "composio",
    profile: GOOGLE_CALENDAR_PROFILE,
    toolkit: "googlecalendar",
    resolve(env) {
      const config = resolveComposioConfig(env);
      if (config.status !== "configured") return config;
      return {
        status: "configured",
        connection: {
          integration: "google_calendar",
          kind: "composio",
          profile: "composio",
          endpointLabel: config.host,
          composio: {
            apiKey: config.apiKey,
            userId: config.userId,
            baseUrl: config.baseUrl,
            toolkit: "googlecalendar",
          },
        },
      };
    },
    classify: classifyGoogleCalendar,
    probe: (connection, signal) =>
      probeComposio(connectors.forConnection(connection), "googlecalendar", signal),
    allowlist: (access) => allowedTools("googlecalendar", access),
    connector: (connection) => connectors.forConnection(connection),
    // An update's reach depends on the event's guests, which only the run's earlier results show.
    runMemory: (settings) => new GoogleCalendarRunMemory(settings),
  };
}
