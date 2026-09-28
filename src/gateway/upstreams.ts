// Transports for the upstream MCP integrations, built from resolved
// connections. Secrets leave their SecretValue wrappers only here, into the
// upstream client (headers) or the HubSpot child's explicit environment.

import { createHash } from "node:crypto";
import {
  COMPOSIO_TOOLKIT_OF,
  type ComposioAccess,
  type ComposioConnection,
  type ComposioToolkitSlug,
  type HubSpotConnection,
} from "../contracts/integration.js";
import { ComposioSessionManager } from "../integrations/composio/session.js";
import { buildHubSpotStdioLaunch } from "../integrations/hubspot/launch.js";
import type { UpstreamConfig } from "./mcp-proxy.js";

/** HubSpot: any Streamable HTTP MCP server, or the pinned @hubspot/mcp-server over stdio. */
export function hubspotUpstreamConfig(connection: HubSpotConnection): UpstreamConfig {
  const { mcp } = connection;
  if (mcp.transport === "http") {
    return {
      transport: "http",
      url: mcp.url,
      headers: mcp.token === null ? {} : { Authorization: `Bearer ${mcp.token.reveal()}` },
    };
  }
  const launch = buildHubSpotStdioLaunch({
    accessToken: mcp.accessToken.reveal(),
    ...(mcp.apiBaseUrl === null ? {} : { apiBaseUrl: mcp.apiBaseUrl }),
    ...(mcp.command === null ? {} : { command: mcp.command.command, args: mcp.command.args }),
  });
  return {
    transport: "stdio",
    command: launch.command,
    args: launch.args,
    env: launch.env,
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
  };
}

export type ComposioSelection = {
  readonly toolkits: readonly ComposioToolkitSlug[];
  readonly access: ComposioAccess;
};

/** The session MCP endpoint of a Composio user, for the run's toolkits and exposure. */
export interface ComposioEndpointSource {
  endpoint(connection: ComposioConnection, selection: ComposioSelection): Promise<UpstreamConfig>;
}

/**
 * The production source: one ComposioSessionManager per (base URL, user,
 * key), so sessions are reused for their 30-minute lifetime across runs.
 */
export function createComposioEndpointSource(): ComposioEndpointSource {
  const managers = new Map<string, ComposioSessionManager>();
  const managerFor = (connection: ComposioConnection) => {
    const { apiKey, userId, baseUrl } = connection.composio;
    const keyHash = createHash("sha256").update(apiKey.reveal()).digest("hex");
    const cacheKey = `${baseUrl}|${userId}|${keyHash}`;
    let manager = managers.get(cacheKey);
    if (manager === undefined) {
      manager = new ComposioSessionManager({ apiKey: apiKey.reveal(), userId, baseURL: baseUrl });
      managers.set(cacheKey, manager);
    }
    return manager;
  };
  return {
    async endpoint(connection, selection) {
      const endpoint = await managerFor(connection).mcpEndpoint({
        toolkits: [...selection.toolkits],
        access: selection.access,
      });
      if (endpoint.type !== "http") {
        throw new Error("Composio reported an SSE session endpoint, which is not supported.");
      }
      return { transport: "http", url: endpoint.url, headers: endpoint.headers };
    },
  };
}

export function composioToolkitOf(connection: ComposioConnection): ComposioToolkitSlug {
  return COMPOSIO_TOOLKIT_OF[connection.integration];
}
