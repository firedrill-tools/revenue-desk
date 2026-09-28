// The six integrations (docs/ARCHITECTURE.md §2, §5): their definitions,
// which are available for a run, their connection status for the Connections
// screen, and the connection snapshot a run starts with.
//
// Nothing here contacts a system except checkConnection()/checkConnections(),
// which run each integration's read-only probe.

import type { AgentEnv } from "../contracts/env.js";
import type { ConnectionPlan, RunConnection } from "../contracts/events.js";
import {
  type Classification,
  type ClassifierSettings,
  type ConnectionResolution,
  type ConnectionState,
  type ConnectionStatus,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationDefinition,
  type IntegrationId,
  type ProbeResult,
  type ProfileAllowlists,
  parseSdkToolName,
  type ResolvedConnection,
  sdkToolName,
  type ToolDescriptor,
  type ToolProfile,
} from "../contracts/integration.js";
import type { JsonObject } from "../contracts/json.js";
import type { ComposioConnectorDeps } from "./composio/connector.js";
import { ComposioConnectors } from "./composio/connector.js";
import type { ComposioIntegration } from "./composio/integration.js";
import { createGmailIntegration } from "./gmail/definition.js";
import { GMAIL_PROFILE } from "./gmail/profile.js";
import { createGoogleCalendarIntegration } from "./google-calendar/definition.js";
import { GOOGLE_CALENDAR_PROFILE } from "./google-calendar/profile.js";
import { createHubSpotIntegration, type HubSpotIntegration } from "./hubspot/definition.js";
import type { HubSpotProbeDeps } from "./hubspot/probe.js";
import { HUBSPOT_PROFILE } from "./hubspot/profile.js";
import { createQuickBooksIntegration } from "./quickbooks/definition.js";
import { QUICKBOOKS_PROFILE } from "./quickbooks/profile.js";
import type { ApiIntegration } from "./shared/definition.js";
import type { HttpDeps } from "./shared/http.js";
import { specOf } from "./shared/profile.js";
import { createSlackIntegration } from "./slack/definition.js";
import { SLACK_PROFILE } from "./slack/profile.js";
import { createStripeIntegration } from "./stripe/definition.js";
import { STRIPE_PROFILE } from "./stripe/profile.js";

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export type Integrations = {
  readonly gmail: ComposioIntegration<"gmail">;
  readonly google_calendar: ComposioIntegration<"google_calendar">;
  readonly hubspot: HubSpotIntegration;
  readonly stripe: ApiIntegration<"stripe">;
  readonly quickbooks: ApiIntegration<"quickbooks">;
  readonly slack: ApiIntegration<"slack">;
};

type DefinitionMap = { readonly [I in IntegrationId]: IntegrationDefinition<I> };

/** Test seams; production passes nothing. */
export type IntegrationDeps = {
  readonly http?: HttpDeps;
  readonly composio?: ComposioConnectorDeps;
  readonly hubspot?: HubSpotProbeDeps;
};

export function createIntegrations(deps: IntegrationDeps = {}): Integrations {
  const connectors = new ComposioConnectors(deps.composio);
  const http = deps.http === undefined ? {} : { http: deps.http };
  return {
    gmail: createGmailIntegration(connectors),
    google_calendar: createGoogleCalendarIntegration(connectors),
    hubspot: createHubSpotIntegration(deps.hubspot),
    stripe: createStripeIntegration(http),
    quickbooks: createQuickBooksIntegration(http),
    slack: createSlackIntegration(http),
  };
}

let shared: Integrations | undefined;

/** The process-wide integrations; one Composio session cache for the server or CLI. */
export function integrations(): Integrations {
  shared ??= createIntegrations();
  return shared;
}

function definitions(set: Integrations): DefinitionMap {
  return set;
}

// ---------------------------------------------------------------------------
// Profiles and tools (static)
// ---------------------------------------------------------------------------

export const PROFILES: { readonly [I in IntegrationId]: ToolProfile<I> } = {
  gmail: GMAIL_PROFILE,
  google_calendar: GOOGLE_CALENDAR_PROFILE,
  hubspot: HUBSPOT_PROFILE,
  stripe: STRIPE_PROFILE,
  quickbooks: QUICKBOOKS_PROFILE,
  slack: SLACK_PROFILE,
};

/** Every profile's tool names, e.g. for fixtures and fakes. */
export const PROFILE_ALLOWLISTS: ProfileAllowlists = {
  gmail: Object.keys(GMAIL_PROFILE.tools),
  google_calendar: Object.keys(GOOGLE_CALENDAR_PROFILE.tools),
  hubspot: Object.keys(HUBSPOT_PROFILE.tools),
  stripe: Object.keys(STRIPE_PROFILE.tools),
  quickbooks: Object.keys(QUICKBOOKS_PROFILE.tools),
  slack: Object.keys(SLACK_PROFILE.tools),
};

/** The descriptors of one integration's tools, as registered for a run. */
export function toolDescriptors(integration: IntegrationId): readonly ToolDescriptor[] {
  return Object.values(PROFILES[integration].tools).map((spec) => ({
    ...spec,
    integration,
    connectionKind: INTEGRATIONS[integration].kind,
    sdkName: sdkToolName(integration, spec.name),
  }));
}

/** The descriptor of a model-visible tool name; null for anything not in a profile. */
export function describeTool(sdkName: string): ToolDescriptor | null {
  const parsed = parseSdkToolName(sdkName);
  if (parsed === null) return null;
  const spec = specOf(PROFILES[parsed.integration], parsed.tool);
  if (spec === undefined) return null;
  return {
    ...spec,
    integration: parsed.integration,
    connectionKind: INTEGRATIONS[parsed.integration].kind,
    sdkName: sdkToolName(parsed.integration, spec.name),
  };
}

/**
 * Classifies one call by its model-visible name. Null when the tool is not in
 * any profile; `classification` null when the integration's classifier
 * cannot judge the input. Both mean deny.
 */
export function classifyCall(
  set: Integrations,
  sdkName: string,
  input: JsonObject,
  settings: ClassifierSettings,
): { readonly descriptor: ToolDescriptor; readonly classification: Classification | null } | null {
  const descriptor = describeTool(sdkName);
  if (descriptor === null) return null;
  return {
    descriptor,
    classification: classifyWith(set, descriptor.integration, descriptor.name, input, settings),
  };
}

function classifyWith<I extends IntegrationId>(
  set: Integrations,
  id: I,
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
): Classification | null {
  const definition: IntegrationDefinition<I> = definitions(set)[id];
  return definition.classify(tool, input, settings);
}

// ---------------------------------------------------------------------------
// Resolution and availability
// ---------------------------------------------------------------------------

export type Resolutions = { readonly [I in IntegrationId]: ConnectionResolution<I> };

function resolveOne<I extends IntegrationId>(
  set: Integrations,
  id: I,
  env: AgentEnv,
): ConnectionResolution<I> {
  const definition: IntegrationDefinition<I> = definitions(set)[id];
  return definition.resolve(env);
}

/** Every integration's resolution from the snapshot. Never contacts a system. */
export function resolveAll(set: Integrations, env: AgentEnv): Resolutions {
  return {
    gmail: resolveOne(set, "gmail", env),
    google_calendar: resolveOne(set, "google_calendar", env),
    hubspot: resolveOne(set, "hubspot", env),
    stripe: resolveOne(set, "stripe", env),
    quickbooks: resolveOne(set, "quickbooks", env),
    slack: resolveOne(set, "slack", env),
  };
}

/** The configured connections, in the fixed integration order. */
export function available(set: Integrations, env: AgentEnv): readonly ResolvedConnection[] {
  const resolutions: readonly ConnectionResolution[] = Object.values(resolveAll(set, env));
  return resolutions.flatMap((resolution) =>
    resolution.status === "configured" ? [resolution.connection] : [],
  );
}

// ---------------------------------------------------------------------------
// Connection status (Connections screen, connections table)
// ---------------------------------------------------------------------------

function baseStatus(id: IntegrationId) {
  const info = INTEGRATIONS[id];
  return { integration: id, kind: info.kind, profile: info.profile } as const;
}

/** The status known without contacting the system. */
export function statusFromResolution(
  id: IntegrationId,
  resolution: ConnectionResolution,
): ConnectionStatus {
  switch (resolution.status) {
    case "configured":
      return {
        ...baseStatus(id),
        state: "unknown",
        detail: "Configured; not checked yet.",
        endpointLabel: resolution.connection.endpointLabel,
        accountHint: null,
        missing: [],
        checkedAt: null,
      };
    case "not_configured":
      return {
        ...baseStatus(id),
        state: "not_configured",
        detail: `Not configured: set ${resolution.missing.join(" and ")}.`,
        endpointLabel: null,
        accountHint: null,
        missing: [...resolution.missing],
        checkedAt: null,
      };
    case "invalid":
      return {
        ...baseStatus(id),
        state: "invalid",
        detail: resolution.problems.map((problem) => problem.message).join("; "),
        endpointLabel: null,
        accountHint: null,
        missing: [],
        checkedAt: null,
      };
  }
}

async function probeOne<I extends IntegrationId>(
  set: Integrations,
  id: I,
  env: AgentEnv,
  signal: AbortSignal,
): Promise<{ readonly resolution: ConnectionResolution<I>; readonly probe: ProbeResult | null }> {
  const definition: IntegrationDefinition<I> = definitions(set)[id];
  const resolution = definition.resolve(env);
  if (resolution.status !== "configured") return { resolution, probe: null };
  try {
    return { resolution, probe: await definition.probe(resolution.connection, signal) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      resolution,
      probe: { state: "error", detail: `Check failed: ${message}`, accountHint: null },
    };
  }
}

/**
 * Resolves one integration and, when it is configured, runs its read-only
 * probe. Never throws for a failed check: the status says what happened.
 */
export async function checkConnection(
  set: Integrations,
  id: IntegrationId,
  env: AgentEnv,
  signal: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<ConnectionStatus> {
  const { resolution, probe } = await probeOne(set, id, env, signal);
  const status = statusFromResolution(id, resolution);
  if (probe === null) return status;
  return {
    ...status,
    state: probe.state,
    detail: probe.detail,
    accountHint: probe.accountHint,
    checkedAt: now().toISOString(),
  };
}

/** checkConnection for all six integrations, concurrently, in the fixed order. */
export function checkConnections(
  set: Integrations,
  env: AgentEnv,
  signal: AbortSignal,
  now?: () => Date,
): Promise<readonly ConnectionStatus[]> {
  return Promise.all(INTEGRATION_IDS.map((id) => checkConnection(set, id, env, signal, now)));
}

// ---------------------------------------------------------------------------
// The connection snapshot a run starts with
// ---------------------------------------------------------------------------

/** What is known about a connection from its last check (the connections table). */
export type KnownConnection = Pick<ConnectionStatus, "state" | "detail">;

/** Probe states that make a configured integration unavailable for a run. */
const UNAVAILABLE_AFTER_CHECK: ReadonlySet<ConnectionState> = new Set(["needs_auth", "expired"]);

export type ConnectionSnapshot = {
  /** One plan per integration, for RunTurnInput.connections. */
  readonly plans: readonly ConnectionPlan[];
  /** One entry per integration, for run.started and runs.connections_snapshot. */
  readonly connections: readonly RunConnection[];
};

/**
 * Decides which integrations take part in a run. An integration is available
 * when it is configured and its last check did not say needs_auth or expired
 * (Composio lists a toolkit's tools even without a connected account, so only
 * the check can tell). A transient error or no check yet keeps it available;
 * the gateway reports a failure to connect at run time.
 */
export function connectionSnapshot(
  set: Integrations,
  env: AgentEnv,
  known: { readonly [I in IntegrationId]?: KnownConnection } = {},
): ConnectionSnapshot {
  const resolutions = resolveAll(set, env);
  const plans: ConnectionPlan[] = [];
  const connections: RunConnection[] = [];
  for (const id of INTEGRATION_IDS) {
    const resolution: ConnectionResolution = resolutions[id];
    const info = INTEGRATIONS[id];
    const last = known[id];
    if (resolution.status !== "configured") {
      const status = statusFromResolution(id, resolution);
      const state = resolution.status;
      plans.push({ integration: id, status: "unavailable", state, detail: status.detail });
      connections.push({
        integration: id,
        kind: info.kind,
        profile: info.profile,
        availability: "unavailable",
        state,
        detail: status.detail,
        endpointLabel: null,
      });
      continue;
    }
    const endpointLabel = resolution.connection.endpointLabel;
    if (
      last !== undefined &&
      last.state !== "connected" &&
      UNAVAILABLE_AFTER_CHECK.has(last.state)
    ) {
      plans.push({
        integration: id,
        status: "unavailable",
        state: last.state,
        detail: last.detail,
      });
      connections.push({
        integration: id,
        kind: info.kind,
        profile: info.profile,
        availability: "unavailable",
        state: last.state,
        detail: last.detail,
        endpointLabel,
      });
      continue;
    }
    plans.push({ integration: id, status: "available", connection: resolution.connection });
    connections.push({
      integration: id,
      kind: info.kind,
      profile: info.profile,
      availability: "ready",
      state: last?.state ?? "unknown",
      detail: null,
      endpointLabel,
    });
  }
  return { plans, connections };
}
