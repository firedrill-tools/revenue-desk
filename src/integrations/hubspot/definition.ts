// The HubSpot integration: MCP kind, profile hubspot-mcp-0.4.

import {
  type HubSpotConnection,
  INTEGRATIONS,
  type IntegrationDefinition,
} from "../../contracts/integration.js";
import type { UpstreamConfig } from "../../gateway/mcp-proxy.js";
import { classifyHubSpot } from "./classify.js";
import { type HubSpotProbeDeps, probeHubSpot } from "./probe.js";
import { HUBSPOT_PROFILE, HUBSPOT_TOOL_NAMES } from "./profile.js";
import { resolveHubSpot } from "./resolve.js";
import { hubspotUpstreamConfig } from "./upstream.js";

export interface HubSpotIntegration extends IntegrationDefinition<"hubspot"> {
  readonly kind: "mcp";
  /** The upstream tool names the gateway's filtering proxy may list and forward. */
  readonly allowlist: readonly string[];
  /** Where the gateway connects. Throws HubSpotLaunchError for an unusable stdio launch. */
  upstream(connection: HubSpotConnection): UpstreamConfig;
}

export function createHubSpotIntegration(deps: HubSpotProbeDeps = {}): HubSpotIntegration {
  return {
    id: "hubspot",
    label: INTEGRATIONS.hubspot.label,
    kind: "mcp",
    profile: HUBSPOT_PROFILE,
    allowlist: HUBSPOT_TOOL_NAMES,
    resolve: resolveHubSpot,
    classify: classifyHubSpot,
    probe: (connection, signal) => probeHubSpot(connection, signal, deps),
    upstream: (connection) => hubspotUpstreamConfig(connection, deps.launch),
  };
}
