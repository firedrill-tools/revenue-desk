// The Gmail integration: Composio kind, toolkit gmail.

import { INTEGRATIONS } from "../../contracts/integration.js";
import { ComposioConnectors, probeComposio } from "../composio/connector.js";
import type { ComposioIntegration } from "../composio/integration.js";
import { resolveComposioConfig } from "../composio/resolve.js";
import { allowedTools } from "../composio/session.js";
import { classifyGmail } from "./classify.js";
import { GMAIL_PROFILE } from "./profile.js";

export function createGmailIntegration(
  connectors: ComposioConnectors = new ComposioConnectors(),
): ComposioIntegration<"gmail"> {
  return {
    id: "gmail",
    label: INTEGRATIONS.gmail.label,
    kind: "composio",
    profile: GMAIL_PROFILE,
    toolkit: "gmail",
    resolve(env) {
      const config = resolveComposioConfig(env);
      if (config.status !== "configured") return config;
      return {
        status: "configured",
        connection: {
          integration: "gmail",
          kind: "composio",
          profile: "composio",
          endpointLabel: config.host,
          composio: {
            apiKey: config.apiKey,
            userId: config.userId,
            baseUrl: config.baseUrl,
            toolkit: "gmail",
          },
        },
      };
    },
    classify: classifyGmail,
    probe: (connection, signal) =>
      probeComposio(connectors.forConnection(connection), "gmail", signal),
    allowlist: (access) => allowedTools("gmail", access),
    connector: (connection) => connectors.forConnection(connection),
  };
}
