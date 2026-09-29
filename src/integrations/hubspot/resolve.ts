// HubSpot configuration (docs/ARCHITECTURE.md §3): HUBSPOT_ACCESS_TOKEN only.
// HubSpot always runs as its official, pinned @hubspot/mcp-server 0.4.x over
// stdio with that token, calling HubSpot's own default host; no variable can
// replace the server or point it anywhere else.

import type { AgentEnv } from "../../contracts/env.js";
import type { ConnectionResolution } from "../../contracts/integration.js";
import { hasSecret, secretProblem } from "../shared/resolve.js";
import { HUBSPOT_MCP_SERVER_API_HOST } from "../shared/vendors.js";

export function resolveHubSpot(env: AgentEnv): ConnectionResolution<"hubspot"> {
  const { accessToken } = env.hubspot;
  if (!hasSecret(accessToken)) {
    return { status: "not_configured", missing: ["HUBSPOT_ACCESS_TOKEN"] };
  }
  const problem = secretProblem("HUBSPOT_ACCESS_TOKEN", accessToken);
  if (problem !== null) return { status: "invalid", problems: [problem] };
  return {
    status: "configured",
    connection: {
      integration: "hubspot",
      kind: "mcp",
      profile: "hubspot-mcp-0.4",
      endpointLabel: HUBSPOT_MCP_SERVER_API_HOST,
      mcp: { transport: "stdio", accessToken },
    },
  };
}
