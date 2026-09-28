// Read-only check of the HubSpot MCP connection: start or reach the server,
// confirm it lists every tool of the hubspot-mcp-0.4 profile, then call
// hubspot-get-user-details (a read) to prove the token works.

import type { HubSpotConnection, ProbeResult } from "../../contracts/integration.js";
import { connectUpstream, type Upstream, type UpstreamConfig } from "../../gateway/mcp-proxy.js";
import { abortable } from "../shared/abort.js";
import { listOf, maskIdentifier, preview, scrub } from "../shared/text.js";
import { HubSpotLaunchError } from "./launch.js";
import { HUBSPOT_TOOL_NAMES } from "./profile.js";
import { type HubSpotLaunchOverrides, hubspotUpstreamConfig } from "./upstream.js";

export type ConnectUpstream = (
  config: UpstreamConfig,
  options: { readonly timeoutMs?: number },
) => Promise<Upstream>;

export type HubSpotProbeDeps = {
  readonly connect?: ConnectUpstream;
  readonly launch?: HubSpotLaunchOverrides;
  readonly timeoutMs?: number;
};

const USER_DETAILS = "hubspot-get-user-details";

function secretsOf(connection: HubSpotConnection): string[] {
  const mcp = connection.mcp;
  if (mcp.transport === "stdio") return [mcp.accessToken.reveal()];
  return mcp.token === null ? [] : [mcp.token.reveal()];
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

/** "HubSpot API Error: 401 Unauthorized - …" -> 401 */
function upstreamStatus(text: string): number | null {
  const match = /HubSpot API Error: (\d{3})\b|\(HTTP (\d{3})\)|\bHTTP (\d{3})\b/.exec(text);
  const status = match?.[1] ?? match?.[2] ?? match?.[3];
  return status === undefined ? null : Number(status);
}

function hubIdOf(text: string): string | null {
  return /"hubId"\s*:\s*"?(\d+)/.exec(text)?.[1] ?? null;
}

export async function probeHubSpot(
  connection: HubSpotConnection,
  signal: AbortSignal,
  deps: HubSpotProbeDeps = {},
): Promise<ProbeResult> {
  const secrets = secretsOf(connection);
  const clean = (text: string) => preview(scrub(text, secrets), 300);
  const connect = deps.connect ?? connectUpstream;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  let upstream: Upstream | undefined;
  try {
    const config = hubspotUpstreamConfig(connection, deps.launch);
    upstream = await abortable(connect(config, { timeoutMs }), signal, (late) => {
      void late.close().catch(() => {});
    });
    const listed = new Set(upstream.tools.map((tool) => tool.name));
    const missing = HUBSPOT_TOOL_NAMES.filter((name) => !listed.has(name));
    if (missing.length > 0) {
      return {
        state: "error",
        detail: `The HubSpot MCP server does not offer ${listOf(missing)}; it does not match the hubspot-mcp-0.4 profile.`,
        accountHint: null,
      };
    }
    const result = await upstream.client.callTool(
      { name: USER_DETAILS, arguments: {} },
      undefined,
      {
        signal,
        timeout: timeoutMs,
      },
    );
    const text = textOf(result.content);
    if (result.isError === true) {
      const status = upstreamStatus(text);
      if (status === 401 || status === 403) {
        return {
          state: "needs_auth",
          detail: `HubSpot rejected the configured token (HTTP ${status}).`,
          accountHint: null,
        };
      }
      return {
        state: "error",
        detail: `HubSpot account check failed: ${clean(text)}`,
        accountHint: null,
      };
    }
    const hubId = hubIdOf(text);
    return {
      state: "connected",
      detail: `HubSpot MCP server lists all ${HUBSPOT_TOOL_NAMES.length} profile tools; the token is accepted.`,
      accountHint: hubId === null ? null : maskIdentifier(hubId),
    };
  } catch (error) {
    if (error instanceof HubSpotLaunchError) {
      return { state: "error", detail: clean(error.message), accountHint: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = upstreamStatus(message);
    if (status === 401 || status === 403) {
      return {
        state: "needs_auth",
        detail: `The HubSpot MCP server rejected the configured token (HTTP ${status}).`,
        accountHint: null,
      };
    }
    return {
      state: "error",
      detail: `HubSpot MCP check failed: ${clean(message)}`,
      accountHint: null,
    };
  } finally {
    await upstream?.close().catch(() => {});
  }
}
