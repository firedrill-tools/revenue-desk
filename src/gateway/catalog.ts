// What the gateway needs from the integrations (W2, src/integrations): each
// integration's definition (profile, classifier) and, for the API kind, the
// in-process tools for one resolved connection.

import {
  type ApiIntegrationId,
  INTEGRATIONS,
  type IntegrationDefinition,
  type IntegrationId,
  type ResolvedConnectionOf,
  sdkToolName,
  type ToolDescriptor,
} from "../contracts/integration.js";
import type { ApiToolDefinition } from "./api-server.js";

/** Per-run facts API tools need besides the connection. */
export type ApiToolFactoryOptions = {
  /** WorkspaceSettings.currency (QuickBooks omits it when multicurrency is off). */
  readonly currency: string;
};

export type ApiToolFactory<I extends ApiIntegrationId> = (
  connection: ResolvedConnectionOf<I>,
  options: ApiToolFactoryOptions,
) => readonly ApiToolDefinition[];

export type IntegrationCatalog = {
  readonly definitions: { readonly [I in IntegrationId]: IntegrationDefinition<I> };
  readonly apiTools: { readonly [I in ApiIntegrationId]: ApiToolFactory<I> };
};

/** The parts of an IntegrationDefinition the gateway reads for its tools. */
export type ToolSource = Pick<IntegrationDefinition, "id" | "profile" | "classify">;

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
