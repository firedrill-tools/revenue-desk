// Turns a resolved HubSpot connection into the gateway's upstream MCP
// configuration. The token is revealed here, at the point of use, and goes
// only to the upstream: the Claude CLI child never sees it.
//
// Always the pinned @hubspot/mcp-server over stdio through launch.ts
// (process.execPath plus the resolved bin, an explicit child environment
// without BASE_URL_OVERRIDE, dotenv pointed at the null device).

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
  const launch = buildHubSpotStdioLaunch({
    accessToken: connection.mcp.accessToken.reveal(),
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
