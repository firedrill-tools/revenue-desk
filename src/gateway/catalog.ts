// What the gateway needs from the integrations (W2, src/integrations): one
// definition per integration (profile, classifier) plus how to reach it:
// - API: its in-process tools bound to one resolved connection;
// - HubSpot: the upstream MCP configuration of a connection;
// - Gmail, Calendar, QuickBooks and Slack: a connector that opens the
//   Composio session MCP for the run's toolkits at an access level.
// W2's integrations (ApiIntegration, HubSpotIntegration, ComposioIntegration)
// have these shapes, so its registry is a catalog as it stands.

import {
  type ApiIntegrationId,
  type Classification,
  type ClassifierSettings,
  type ComposioAccess,
  type ComposioIntegrationId,
  type ComposioToolkitSlug,
  type HubSpotConnection,
  INTEGRATIONS,
  type IntegrationDefinition,
  type IntegrationId,
  type ResolvedConnectionOf,
  sdkToolName,
  type ToolDescriptor,
  type ToolFailure,
} from "../contracts/integration.js";
import type { JsonObject, JsonValue } from "../contracts/json.js";
import type { ApiToolDefinition } from "./api-server.js";
import type { UpstreamConfig } from "./mcp-proxy.js";
import type { SchemaIssue } from "./validate.js";

/** Per-run facts API tools need besides the connection. */
export type ApiToolFactoryOptions = {
  /** WorkspaceSettings.currency, for amounts that carry none. */
  readonly currency: string;
  /** WorkspaceSettings.timezone: timestamps returned to the model are written in it. */
  readonly timezone?: string;
};

/** An API integration's tools for one connection. */
export type ApiToolSource<I extends ApiIntegrationId> = {
  tools(
    connection: ResolvedConnectionOf<I>,
    options: ApiToolFactoryOptions,
  ): readonly ApiToolDefinition[];
};

/** HubSpot's upstream MCP server for one connection. Throws when it cannot be launched. */
export type HubSpotUpstreamSource = {
  upstream(connection: HubSpotConnection): UpstreamConfig;
  /**
   * Profile tools that run in process against HubSpot's REST API (the owners
   * lookup the MCP server lacks), offered beside the forwarded MCP tools.
   */
  apiTools?(connection: HubSpotConnection): readonly ApiToolDefinition[];
};

/** Opens the Composio session MCP for a run (one session serves every toolkit). */
export type ComposioUpstreamSource<I extends ComposioIntegrationId> = {
  connector(connection: ResolvedConnectionOf<I>): {
    upstream(
      toolkits: readonly ComposioToolkitSlug[],
      access: ComposioAccess,
    ): Promise<{ readonly config: UpstreamConfig }>;
  };
};

/**
 * What a run learned from an integration's earlier calls that changes how a
 * later call is classified, e.g. who receives a Gmail draft created earlier
 * in the run, when sending it names only the draft. One per integration and
 * run; it never contacts a system.
 */
export interface RunMemory {
  /**
   * A call of this integration finished; `output` is what the model received
   * and `failure` the normalised error of a failed call (its code says
   * `outcome_unknown` for a write sent without an answer).
   */
  record(
    tool: string,
    input: JsonObject,
    output: JsonValue,
    isError: boolean,
    failure?: ToolFailure | null,
  ): void;
  /** The classification of `tool` for `input`, refined with what the run learned. */
  refine(tool: string, input: JsonObject, classification: Classification): Classification;
}

/** An integration whose classifications can depend on the run's earlier calls. */
export type RunMemorySource = {
  /** A fresh memory for one run; `settings` are the run's classifier settings. */
  runMemory?(settings: ClassifierSettings): RunMemory;
};

/**
 * An integration that knows rules its offered schema does not state (HubSpot
 * 0.4.0 forwards a schema that omits fields HubSpot requires). The gateway
 * checks them with the schema, before any policy: a call that breaks one is
 * rejected without reaching the system, and the model is told what to fix.
 */
export type InputCheckSource = {
  /** Issues of one schema-valid input; empty when it may run. */
  checkInput?(tool: string, input: JsonObject): readonly SchemaIssue[];
};

export type CatalogEntry<I extends IntegrationId> = IntegrationDefinition<I> &
  RunMemorySource &
  InputCheckSource &
  (I extends ApiIntegrationId
    ? ApiToolSource<I>
    : I extends ComposioIntegrationId
      ? ComposioUpstreamSource<I>
      : I extends "hubspot"
        ? HubSpotUpstreamSource
        : unknown);

/** Every integration's definition, keyed by id. */
export type IntegrationCatalog = { readonly [I in IntegrationId]: CatalogEntry<I> };

/** The parts of an IntegrationDefinition the gateway reads for its tools. */
export type ToolSource = Pick<IntegrationDefinition, "id" | "profile" | "classify"> &
  RunMemorySource &
  InputCheckSource;

/** Every tool of an integration's profile, as registered descriptors. */
export function profileDescriptors(definition: ToolSource): ToolDescriptor[] {
  const { kind } = INTEGRATIONS[definition.id];
  return Object.values(definition.profile.tools).map((spec) => ({
    ...spec,
    integration: definition.id,
    connectionKind: kind,
    sdkName: sdkToolName(definition.id, spec.name),
  }));
}
