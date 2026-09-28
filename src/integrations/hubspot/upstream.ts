// Turns a resolved HubSpot connection into the gateway's upstream MCP
// configuration. Secrets are revealed here, at the point of use, and go only
// to the upstream: the Claude CLI child never sees them.
//
// stdio: the pinned @hubspot/mcp-server through launch.ts (process.execPath
// plus the resolved bin, an explicit child environment, dotenv pointed at the
// null device). http: any Streamable HTTP MCP server with an optional Bearer.

import type { HubSpotConnection } from "../../contracts/integration.js";
import type { UpstreamConfig } from "../../gateway/mcp-proxy.js";
import { buildHubSpotStdioLaunch } from "./launch.js";

export type HubSpotLaunchOverrides = {
  /** Node binary for the bundled server (tests). Defaults to process.execPath. */
  readonly execPath?: string;
  /** Where to resolve @hubspot/mcp-server from (tests). */
  readonly resolveFrom?: string;
};

/** Throws HubSpotLaunchError when the stdio server cannot be launched as configured. */
export function hubspotUpstreamConfig(
  connection: HubSpotConnection,
  overrides: HubSpotLaunchOverrides = {},
): UpstreamConfig {
  const mcp = connection.mcp;
  if (mcp.transport === "http") {
    return {
      transport: "http",
      url: mcp.url,
      headers: mcp.token === null ? {} : { authorization: `Bearer ${mcp.token.reveal()}` },
    };
  }
  const launch = buildHubSpotStdioLaunch({
    accessToken: mcp.accessToken.reveal(),
    ...(mcp.apiBaseUrl === null ? {} : { apiBaseUrl: mcp.apiBaseUrl }),
    ...(mcp.command === null ? {} : { command: mcp.command.command, args: mcp.command.args }),
    ...(overrides.execPath === undefined ? {} : { execPath: overrides.execPath }),
    ...(overrides.resolveFrom === undefined ? {} : { resolveFrom: overrides.resolveFrom }),
  });
  return {
    transport: "stdio",
    command: launch.command,
    args: launch.args,
    env: launch.env,
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
  };
}
