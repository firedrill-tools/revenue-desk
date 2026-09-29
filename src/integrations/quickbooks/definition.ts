// The QuickBooks Online integration: Composio kind, toolkit quickbooks.
// Composio holds the Intuit sign-in (Connect in Connections); Revenue Desk
// holds no QuickBooks token.

import { INTEGRATIONS } from "../../contracts/integration.js";
import { ComposioConnectors, probeComposio } from "../composio/connector.js";
import type { ComposioIntegration } from "../composio/integration.js";
import { resolveComposioConfig } from "../composio/resolve.js";
import { allowedTools } from "../composio/session.js";
import { classifyQuickBooks } from "./classify.js";
import { checkQuickBooksInput } from "./input-rules.js";
import { QUICKBOOKS_PROFILE } from "./profile.js";
import { QuickBooksRunMemory } from "./run-memory.js";

export function createQuickBooksIntegration(
  connectors: ComposioConnectors = new ComposioConnectors(),
): ComposioIntegration<"quickbooks"> {
  return {
    id: "quickbooks",
    label: INTEGRATIONS.quickbooks.label,
    kind: "composio",
    profile: QUICKBOOKS_PROFILE,
    toolkit: "quickbooks",
    resolve(env) {
      const config = resolveComposioConfig(env);
      if (config.status !== "configured") return config;
      return {
        status: "configured",
        connection: {
          integration: "quickbooks",
          kind: "composio",
          profile: "composio",
          endpointLabel: config.host,
          composio: {
            apiKey: config.apiKey,
            userId: config.userId,
            toolkit: "quickbooks",
          },
        },
      };
    },
    classify: (tool, input, settings) => classifyQuickBooks(tool, input, settings),
    probe: (connection, signal) =>
      probeComposio(connectors.forConnection(connection), "quickbooks", signal),
    allowlist: (access) => allowedTools("quickbooks", access),
    connector: (connection) => connectors.forConnection(connection),
    // Approval cards name the customers and invoices this run read, not only their ids.
    runMemory: (settings) => new QuickBooksRunMemory(settings),
    // Invoice lines need amounts; a payment never charges a card.
    checkInput: checkQuickBooksInput,
  };
}
