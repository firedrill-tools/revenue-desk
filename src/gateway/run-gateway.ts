// The gateway of one run: connects the run's available integrations, builds
// the tool registry and hands out fresh in-process servers for query().
//
// An integration whose upstream cannot be reached (HubSpot MCP down, a
// Composio session that cannot be created) or that offers none of its tools
// is unavailable for this run: its tools are not offered and the prompt says
// so. Nothing falls back to anything else.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ConnectionPlan, RunConnection } from "../contracts/events.js";
import {
  type ClassifierSettings,
  COMPOSIO_TOOLKIT_OF,
  composioAccessFor,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationId,
  type PolicyModes,
  type ResolvedConnection,
  type ToolDescriptor,
  type WorkspaceSettings,
} from "../contracts/integration.js";
import { apiGatewayTool } from "./api-server.js";
import {
  type IntegrationCatalog,
  profileDescriptors,
  type RunMemory,
  type ToolSource,
} from "./catalog.js";
import {
  connectUpstream as defaultConnectUpstream,
  type Upstream,
  type UpstreamConnector,
  upstreamGatewayTools,
} from "./mcp-proxy.js";
import { type RegisteredTool, registerTool, ToolRegistry } from "./registry.js";
import { createGatewayServer, type GatewayServer } from "./server.js";
import { type GatewayObserver, type GatewayTool, notify } from "./types.js";

export type RunGatewayOptions = {
  readonly runId: string;
  readonly plans: readonly ConnectionPlan[];
  readonly catalog: IntegrationCatalog;
  readonly settings: WorkspaceSettings;
  readonly policy: PolicyModes;
  readonly signal: AbortSignal;
  readonly observer?: GatewayObserver;
  readonly redact?: (text: string) => string;
  readonly connectUpstream?: UpstreamConnector;
  readonly connectTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly progressIntervalMs?: number;
  readonly maxOutputChars?: number;
};

export type RunGateway = {
  readonly registry: ToolRegistry;
  /** All six integrations, in INTEGRATION_IDS order. */
  readonly connections: readonly RunConnection[];
  /** Fresh in-process servers for one query(), keyed by integration id. */
  mcpServers(): Record<string, McpSdkServerConfigWithInstance>;
  close(): Promise<void>;
};

type Outcome =
  | { readonly status: "ready"; readonly tools: readonly GatewayTool[] }
  | { readonly status: "unavailable"; readonly connection: RunConnection };

type ComposioPlanConnection = Extract<
  ResolvedConnection,
  { readonly integration: "gmail" | "google_calendar" }
>;

function composioConnector(catalog: IntegrationCatalog, connection: ComposioPlanConnection) {
  return connection.integration === "gmail"
    ? catalog.gmail.connector(connection)
    : catalog.google_calendar.connector(connection);
}

function unavailable(
  integration: IntegrationId,
  state: RunConnection["state"],
  detail: string,
): RunConnection {
  const { kind, profile } = INTEGRATIONS[integration];
  return {
    integration,
    kind,
    profile,
    availability: "unavailable",
    state,
    detail,
    endpointLabel: null,
  };
}

function ready(connection: ResolvedConnection): RunConnection {
  const { kind, profile } = INTEGRATIONS[connection.integration];
  return {
    integration: connection.integration,
    kind,
    profile,
    availability: "ready",
    state: "connected",
    detail: null,
    endpointLabel: connection.endpointLabel,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function apiTools(
  catalog: IntegrationCatalog,
  connection: ResolvedConnection,
  currency: string,
  descriptors: readonly ToolDescriptor[],
): GatewayTool[] {
  const options = { currency };
  const definitions =
    connection.integration === "stripe"
      ? catalog.stripe.tools(connection, options)
      : connection.integration === "quickbooks"
        ? catalog.quickbooks.tools(connection, options)
        : connection.integration === "slack"
          ? catalog.slack.tools(connection, options)
          : [];
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return descriptors.flatMap((descriptor) => {
    const definition = byName.get(descriptor.name);
    return definition === undefined ? [] : [apiGatewayTool(definition, descriptor)];
  });
}

/** The run's observer, preceded by the integration's memory of finished calls. */
function remembering(
  memory: RunMemory | undefined,
  observer: GatewayObserver | undefined,
): GatewayObserver | undefined {
  if (memory === undefined) return observer;
  return {
    callStarted: (call) => observer?.callStarted?.(call),
    callProgress: (call, elapsedMs) => observer?.callProgress?.(call, elapsedMs),
    callFinished(result) {
      // The memory learns before the model sees the result, so its next call is classified with it.
      notify(() =>
        memory.record(result.call.tool, result.call.arguments, result.output, result.isError),
      );
      observer?.callFinished(result);
    },
  };
}

/** Connects the run's integrations and builds its registry. Never throws for an integration failure. */
export async function openRunGateway(options: RunGatewayOptions): Promise<RunGateway> {
  const connect = options.connectUpstream ?? defaultConnectUpstream;
  const redact = options.redact ?? ((text: string) => text);
  const classifierSettings: ClassifierSettings = {
    internalEmailDomains: options.settings.internalEmailDomains,
    allowedSlackChannels: options.settings.allowedSlackChannels,
    currency: options.settings.currency,
  };
  const connectOptions = {
    signal: options.signal,
    ...(options.connectTimeoutMs === undefined ? {} : { timeoutMs: options.connectTimeoutMs }),
  };
  const upstreams: Upstream[] = [];
  const available = new Map<IntegrationId, ResolvedConnection>();
  for (const plan of options.plans) {
    if (plan.status === "available") available.set(plan.integration, plan.connection);
  }

  // HubSpot: its own upstream.
  const hubspotConnection = available.get("hubspot");
  const hubspotUpstream: Promise<Upstream | Error> =
    hubspotConnection?.integration === "hubspot"
      ? Promise.resolve()
          .then(() => connect(options.catalog.hubspot.upstream(hubspotConnection), connectOptions))
          .catch((error: unknown) => new Error(messageOf(error)))
      : Promise.resolve(new Error("not available"));

  // Gmail and Calendar: one Composio session for both toolkits.
  const composioConnections: ComposioPlanConnection[] = [];
  for (const connection of [available.get("gmail"), available.get("google_calendar")]) {
    if (connection?.integration === "gmail" || connection?.integration === "google_calendar") {
      composioConnections.push(connection);
    }
  }
  const firstComposio = composioConnections[0];
  const composioUpstream: Promise<Upstream | Error> =
    firstComposio === undefined
      ? Promise.resolve(new Error("not available"))
      : Promise.resolve()
          .then(() =>
            composioConnector(options.catalog, firstComposio).upstream(
              composioConnections.map((connection) => COMPOSIO_TOOLKIT_OF[connection.integration]),
              composioAccessFor(options.policy),
            ),
          )
          .then((session) => connect(session.config, connectOptions))
          .catch((error: unknown) => new Error(messageOf(error)));

  const [hubspot, composio] = await Promise.all([hubspotUpstream, composioUpstream]);
  for (const upstream of [hubspot, composio]) {
    if (!(upstream instanceof Error)) upstreams.push(upstream);
  }

  const outcomes = new Map<IntegrationId, Outcome>();
  const registered: RegisteredTool[] = [];
  const servers: GatewayServer[] = [];

  for (const integration of INTEGRATION_IDS) {
    const plan = options.plans.find((candidate) => candidate.integration === integration);
    const label = INTEGRATIONS[integration].label;
    if (plan === undefined) {
      outcomes.set(integration, {
        status: "unavailable",
        connection: unavailable(integration, "unknown", `${label} was not planned for this run.`),
      });
      continue;
    }
    if (plan.status === "unavailable") {
      outcomes.set(integration, {
        status: "unavailable",
        connection: unavailable(integration, plan.state, redact(plan.detail)),
      });
      continue;
    }
    const definition: ToolSource = options.catalog[integration];
    const descriptors = profileDescriptors(definition);
    // What this run learns from the integration's calls refines later classifications.
    const memory = definition.runMemory?.();
    let tools: readonly GatewayTool[];
    try {
      if (INTEGRATIONS[integration].kind === "api") {
        tools = apiTools(options.catalog, plan.connection, options.settings.currency, descriptors);
      } else {
        const upstream = integration === "hubspot" ? hubspot : composio;
        if (upstream instanceof Error) throw upstream;
        tools = upstreamGatewayTools(upstream, descriptors, {
          ...(options.toolTimeoutMs === undefined ? {} : { timeoutMs: options.toolTimeoutMs }),
        }).tools;
      }
    } catch (error) {
      outcomes.set(integration, {
        status: "unavailable",
        connection: unavailable(
          integration,
          "error",
          redact(`${label} could not be reached for this run: ${messageOf(error)}`),
        ),
      });
      continue;
    }
    const offered: GatewayTool[] = [];
    for (const tool of tools) {
      try {
        registered.push(
          registerTool(
            tool.descriptor,
            tool.definition.inputSchema,
            definition,
            classifierSettings,
            memory,
          ),
        );
        offered.push(tool);
      } catch {
        // A tool whose schema cannot be checked is not offered.
      }
    }
    if (offered.length === 0) {
      outcomes.set(integration, {
        status: "unavailable",
        connection: unavailable(integration, "error", `${label} offered none of its tools.`),
      });
      continue;
    }
    const observer = remembering(memory, options.observer);
    servers.push(
      createGatewayServer({
        integration,
        runId: options.runId,
        tools: offered,
        redact,
        ...(observer === undefined ? {} : { observer }),
        ...(options.toolTimeoutMs === undefined ? {} : { timeoutMs: options.toolTimeoutMs }),
        ...(options.progressIntervalMs === undefined
          ? {}
          : { progressIntervalMs: options.progressIntervalMs }),
        ...(options.maxOutputChars === undefined ? {} : { maxOutputChars: options.maxOutputChars }),
      }),
    );
    outcomes.set(integration, { status: "ready", tools: offered });
  }

  const connections = INTEGRATION_IDS.map((integration): RunConnection => {
    const outcome = outcomes.get(integration);
    if (outcome === undefined || outcome.status === "unavailable") {
      return outcome?.connection ?? unavailable(integration, "unknown", "Not planned.");
    }
    const connection = available.get(integration);
    return connection === undefined
      ? unavailable(integration, "unknown", "Not planned.")
      : ready(connection);
  });

  let closed = false;
  return {
    registry: new ToolRegistry(registered),
    connections,
    mcpServers() {
      const configs: Record<string, McpSdkServerConfigWithInstance> = {};
      for (const server of servers) configs[server.integration] = server.serverConfig();
      return configs;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(upstreams.map((upstream) => upstream.close().catch(() => {})));
    },
  };
}
