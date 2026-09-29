// Wires the Composio session manager (session.ts) into the Gmail, Google
// Calendar, QuickBooks and Slack integrations.
//
// - One connector per Composio configuration (base URL, user, key), shared by
//   the four integrations, so their probes reuse one session.
// - upstream(): the session MCP endpoint for a run, per (toolkits, access),
//   where access comes from the run's policy (composioAccessFor). Sessions are
//   cached for 30 minutes by the manager.
// - status(): read-only connection state per toolkit.
// - authorize(): starts Composio's hosted sign-in. Call it only when the user
//   clicks Connect; every call starts a new link flow.

import { createHash } from "node:crypto";
import type { ComposioLogger } from "@composio/core";
import type { SecretValue } from "../../contracts/env.js";
import type {
  ComposioAccess,
  ComposioConnection,
  ComposioToolkitSlug,
  ProbeResult,
} from "../../contracts/integration.js";
import type { UpstreamConfig } from "../../gateway/mcp-proxy.js";
import { abortable } from "../shared/abort.js";
import {
  allowedTools,
  COMPOSIO_TOOLKITS,
  type ComposioClientLike,
  ComposioSessionError,
  ComposioSessionManager,
  composioErrorParts,
  describeEndpoint,
  type ToolkitConnectionStatus,
} from "./session.js";

export type ComposioSettings = {
  readonly apiKey: SecretValue;
  readonly userId: string;
  readonly baseUrl: string;
};

export type ComposioConnectorDeps = {
  /** Injected Composio client. Defaults to the real SDK client. */
  readonly client?: ComposioClientLike;
  readonly logger?: ComposioLogger;
  readonly ttlMs?: number;
  readonly now?: () => number;
};

/** A run's view of the Composio session MCP server. */
export type ComposioUpstream = {
  /** Streamable HTTP; the headers carry the Composio credential. Never log or persist them. */
  readonly config: Extract<UpstreamConfig, { readonly transport: "http" }>;
  /** The slugs the gateway may offer, per toolkit, for this access level. */
  readonly allowlists: { readonly [T in ComposioToolkitSlug]?: readonly string[] };
  /** Host only; safe to show, log and store. */
  readonly endpointLabel: string;
};

export class ComposioConnector {
  readonly #manager: ComposioSessionManager;

  constructor(settings: ComposioSettings, deps: ComposioConnectorDeps = {}) {
    this.#manager = new ComposioSessionManager({
      apiKey: settings.apiKey.reveal(),
      userId: settings.userId,
      baseURL: settings.baseUrl,
      // Status checks and Connect links use the narrowest session.
      selection: { toolkits: COMPOSIO_TOOLKITS, access: "read" },
      ...(deps.client === undefined ? {} : { client: deps.client }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.ttlMs === undefined ? {} : { ttlMs: deps.ttlMs }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  /** The session MCP endpoint for a run's toolkits at the policy's access level. */
  async upstream(
    toolkits: readonly ComposioToolkitSlug[],
    access: ComposioAccess,
  ): Promise<ComposioUpstream> {
    const endpoint = await this.#manager.mcpEndpoint({ toolkits, access });
    if (endpoint.type !== "http") {
      throw new ComposioSessionError(
        "upstream",
        "Composio returned an SSE MCP endpoint; Revenue Desk connects over Streamable HTTP only",
      );
    }
    const allowlists: { [T in ComposioToolkitSlug]?: readonly string[] } = {};
    for (const toolkit of COMPOSIO_TOOLKITS) {
      if (toolkits.includes(toolkit)) allowlists[toolkit] = allowedTools(toolkit, access);
    }
    return {
      config: { transport: "http", url: endpoint.url, headers: endpoint.headers },
      allowlists,
      endpointLabel: describeEndpoint(endpoint).host,
    };
  }

  /** Read-only connection state of one toolkit. */
  async status(
    toolkit: ComposioToolkitSlug,
    signal: AbortSignal,
  ): Promise<ToolkitConnectionStatus> {
    const statuses = await abortable(this.#manager.connectionStatus(), signal);
    return statuses[toolkit];
  }

  /**
   * Composio's hosted sign-in link for a toolkit. Only on the user's click on
   * Connect: every call starts a new link flow. The callback URL comes from
   * the server's own origin, never from a request.
   */
  authorize(
    toolkit: ComposioToolkitSlug,
    callbackUrl: string,
  ): Promise<{ redirectUrl: string; connectionRequestId: string }> {
    return this.#manager.authorize(toolkit, callbackUrl);
  }

  /** Forget cached sessions, e.g. after the user connected an account. */
  reset(): void {
    this.#manager.reset();
  }
}

/** Connectors keyed by configuration, so the Composio integrations share one per Composio user. */
export class ComposioConnectors {
  readonly #deps: ComposioConnectorDeps;
  readonly #connectors = new Map<string, ComposioConnector>();

  constructor(deps: ComposioConnectorDeps = {}) {
    this.#deps = deps;
  }

  forConnection(connection: ComposioConnection): ComposioConnector {
    const { apiKey, userId, baseUrl } = connection.composio;
    const keyHash = createHash("sha256").update(apiKey.reveal()).digest("hex");
    const cacheKey = `${baseUrl}\n${userId}\n${keyHash}`;
    let connector = this.#connectors.get(cacheKey);
    if (connector === undefined) {
      connector = new ComposioConnector({ apiKey, userId, baseUrl }, this.#deps);
      this.#connectors.set(cacheKey, connector);
    }
    return connector;
  }
}

/**
 * A failed Composio check as a ProbeResult. Composio refusing the API key
 * (HTTP 401 or 403) is needs_auth, so runs leave the integration out, with
 * the variable to replace; anything else is a transient error. The first
 * line is the plain sentence; Composio's own words follow on a second line.
 */
export function composioCheckFailure(error: unknown): ProbeResult {
  const status = error instanceof ComposioSessionError ? error.status : null;
  const said =
    error instanceof ComposioSessionError ? error.said : composioErrorParts(error).message;
  if (status === 401 || status === 403) {
    return {
      state: "needs_auth",
      detail: `Composio rejected the API key. Put a new COMPOSIO_API_KEY in your configuration file and restart Revenue Desk.\nComposio said: ${said}`,
      accountHint: null,
    };
  }
  const http = status === null ? "" : ` (HTTP ${status})`;
  return {
    state: "error",
    detail: `Composio did not answer the check${http}. Try Check again later.\nComposio said: ${said}`,
    accountHint: null,
  };
}

/** A toolkit's Composio state as a ProbeResult; failures are errors, never secrets. */
export async function probeComposio(
  connector: ComposioConnector,
  toolkit: ComposioToolkitSlug,
  signal: AbortSignal,
): Promise<ProbeResult> {
  try {
    const status = await connector.status(toolkit, signal);
    return { state: status.state, detail: status.detail, accountHint: status.accountHint };
  } catch (error) {
    return composioCheckFailure(error);
  }
}
