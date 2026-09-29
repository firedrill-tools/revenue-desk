// HubSpot configuration (docs/ARCHITECTURE.md §3). HUBSPOT_MCP_URL (with an
// optional HUBSPOT_MCP_TOKEN) selects any Streamable HTTP MCP server;
// otherwise the pinned @hubspot/mcp-server runs over stdio with
// HUBSPOT_ACCESS_TOKEN and HUBSPOT_API_BASE_URL.

import type { AgentEnv, ConfigProblem } from "../../contracts/env.js";
import type { ConnectionResolution } from "../../contracts/integration.js";
import { checkUrlVariable, hasSecret, hasValue, secretProblem } from "../shared/resolve.js";

/** The host the bundled server calls when HUBSPOT_API_BASE_URL is unset. */
export const HUBSPOT_DEFAULT_API_HOST = "api.hubspot.com";

function resolveHttp(env: AgentEnv, mcpUrl: string): ConnectionResolution<"hubspot"> {
  const { mcpToken } = env.hubspot;
  const problems: ConfigProblem[] = [];
  const url = checkUrlVariable("HUBSPOT_MCP_URL", mcpUrl, { allowLoopbackHttp: true });
  if (!url.ok) problems.push(url.problem);
  const token = hasSecret(mcpToken) ? mcpToken : null;
  if (token !== null) {
    const problem = secretProblem("HUBSPOT_MCP_TOKEN", token);
    if (problem !== null) problems.push(problem);
  }
  if (problems.length > 0 || !url.ok) return { status: "invalid", problems };
  return {
    status: "configured",
    connection: {
      integration: "hubspot",
      kind: "mcp",
      profile: "hubspot-mcp-0.4",
      endpointLabel: url.value.host,
      mcp: { transport: "http", url: url.value.url, token },
    },
  };
}

export function resolveHubSpot(env: AgentEnv): ConnectionResolution<"hubspot"> {
  const { accessToken, apiBaseUrl, mcpUrl } = env.hubspot;
  if (hasValue(mcpUrl)) return resolveHttp(env, mcpUrl);
  if (!hasSecret(accessToken)) {
    return { status: "not_configured", missing: ["HUBSPOT_ACCESS_TOKEN"] };
  }

  const problems: ConfigProblem[] = [];
  const tokenProblem = secretProblem("HUBSPOT_ACCESS_TOKEN", accessToken);
  if (tokenProblem !== null) problems.push(tokenProblem);
  let apiUrl: string | null = null;
  let host = HUBSPOT_DEFAULT_API_HOST;
  if (hasValue(apiBaseUrl)) {
    const url = checkUrlVariable("HUBSPOT_API_BASE_URL", apiBaseUrl);
    if (url.ok) {
      apiUrl = url.value.url;
      host = url.value.host;
    } else {
      problems.push(url.problem);
    }
  }

  if (problems.length > 0) return { status: "invalid", problems };
  return {
    status: "configured",
    connection: {
      integration: "hubspot",
      kind: "mcp",
      profile: "hubspot-mcp-0.4",
      endpointLabel: host,
      mcp: {
        transport: "stdio",
        accessToken,
        apiBaseUrl: apiUrl,
      },
    },
  };
}
