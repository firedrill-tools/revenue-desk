// The HubSpot integration: MCP kind, profile hubspot-mcp-0.4.

import {
  type HubSpotConnection,
  INTEGRATIONS,
  type IntegrationDefinition,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import type { UpstreamConfig } from "../../gateway/mcp-proxy.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import type { ApiTool } from "../shared/api-tool.js";
import { classifyHubSpot } from "./classify.js";
import { checkHubSpotInput } from "./input-rules.js";
import { createHubSpotApiTools } from "./owners.js";
import { type HubSpotProbeDeps, probeHubSpot } from "./probe.js";
import { HUBSPOT_PROFILE, HUBSPOT_TOOL_NAMES } from "./profile.js";
import { resolveHubSpot } from "./resolve.js";
import { hubspotUpstreamConfig } from "./upstream.js";

export interface HubSpotIntegration extends IntegrationDefinition<"hubspot"> {
  readonly kind: "mcp";
  /** The upstream tool names the gateway's filtering proxy may list and forward. */
  readonly allowlist: readonly string[];
  /** The pinned stdio server the gateway starts. Throws HubSpotLaunchError when it cannot launch. */
  upstream(connection: HubSpotConnection): UpstreamConfig;
  /** HubSpot's rules that the forwarded schema does not state (input-rules.ts). */
  checkInput(tool: string, input: JsonObject): readonly SchemaIssue[];
  /** Profile tools run in process against HubSpot's REST API (owners.ts). */
  apiTools(connection: HubSpotConnection): readonly ApiTool[];
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
    checkInput: checkHubSpotInput,
    apiTools: (connection) => createHubSpotApiTools(connection, deps.http),
  };
}
