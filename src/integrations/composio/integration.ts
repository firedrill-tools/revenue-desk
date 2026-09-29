// What the Composio integrations (Gmail, Google Calendar, QuickBooks, Slack)
// offer the gateway beyond the frozen IntegrationDefinition.

import type {
  ClassifierSettings,
  ComposioAccess,
  ComposioIntegrationId,
  ComposioToolkitSlug,
  IntegrationDefinition,
  ResolvedConnectionOf,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import type { ComposioConnector } from "./connector.js";

export interface ComposioIntegration<I extends ComposioIntegrationId>
  extends IntegrationDefinition<I> {
  readonly kind: "composio";
  readonly toolkit: ComposioToolkitSlug;
  /** The slugs offered at an access level (composioAccessFor(policy)). */
  allowlist(access: ComposioAccess): readonly string[];
  /** The shared connector for this connection's Composio configuration. */
  connector(connection: ResolvedConnectionOf<I>): ComposioConnector;
  /** What a run learns from this integration's calls (e.g. the drafts it created). */
  runMemory?(settings: ClassifierSettings): RunMemory;
  /** Rules the upstream schema cannot state, checked before any policy (InputCheckSource). */
  checkInput?(tool: string, input: JsonObject): readonly SchemaIssue[];
}
