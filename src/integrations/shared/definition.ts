// What each kind of integration offers beyond the frozen IntegrationDefinition:
// the in-process tools of an API integration, the upstream MCP server of
// HubSpot, and the Composio connector of Gmail and Calendar.

import type {
  ApiIntegrationId,
  ClassifierSettings,
  IntegrationDefinition,
  ResolvedConnectionOf,
} from "../../contracts/integration.js";
import type { RunMemory } from "../../gateway/catalog.js";
import type { ApiTool, ApiToolOptions } from "./api-tool.js";
import type { HttpDeps } from "./http.js";

export interface ApiIntegration<I extends ApiIntegrationId> extends IntegrationDefinition<I> {
  readonly kind: "api";
  /** The profile's tools bound to one connection. Build them per query. */
  tools(connection: ResolvedConnectionOf<I>, options: ApiToolOptions): readonly ApiTool[];
  /** What a run learns from this integration's calls, for later approval cards. */
  runMemory?(settings: ClassifierSettings): RunMemory;
}

/** Test seams for API integrations: the HTTP layer (fetch, sleep, retry timing). */
export type ApiIntegrationDeps = { readonly http?: HttpDeps };
