// The Slack integration: Composio kind, toolkit slack. Composio holds the
// Slack sign-in (Connect in Connections); Revenue Desk holds no Slack token.

import { INTEGRATIONS } from "../../contracts/integration.js";
import { ComposioConnectors, probeComposio } from "../composio/connector.js";
import type { ComposioIntegration } from "../composio/integration.js";
import { resolveComposioConfig } from "../composio/resolve.js";
import { allowedTools } from "../composio/session.js";
import { classifySlack } from "./classify.js";
import { checkSlackInput } from "./input-rules.js";
import { SLACK_PROFILE } from "./profile.js";
import { SlackRunMemory } from "./run-memory.js";

export function createSlackIntegration(
  connectors: ComposioConnectors = new ComposioConnectors(),
): ComposioIntegration<"slack"> {
  return {
    id: "slack",
    label: INTEGRATIONS.slack.label,
    kind: "composio",
    profile: SLACK_PROFILE,
    toolkit: "slack",
    resolve(env) {
      const config = resolveComposioConfig(env);
      if (config.status !== "configured") return config;
      return {
        status: "configured",
        connection: {
          integration: "slack",
          kind: "composio",
          profile: "composio",
          endpointLabel: config.host,
          composio: {
            apiKey: config.apiKey,
            userId: config.userId,
            baseUrl: config.baseUrl,
            toolkit: "slack",
          },
        },
      };
    },
    classify: (tool, input, settings) => classifySlack(tool, input, settings),
    probe: (connection, signal) =>
      probeComposio(connectors.forConnection(connection), "slack", signal),
    allowlist: (access) => allowedTools("slack", access),
    connector: (connection) => connectors.forConnection(connection),
    // Whether a channel id is an allowlisted channel only Slack's own results say.
    runMemory: (settings) => new SlackRunMemory(settings),
    // Markdown text only, and mentions that notify the person meant.
    checkInput: checkSlackInput,
  };
}
