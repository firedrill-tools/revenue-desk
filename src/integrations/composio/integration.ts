// What the Composio integrations (Gmail, Google Calendar) offer the gateway
// beyond the frozen IntegrationDefinition.

import type {
  ComposioAccess,
  ComposioIntegrationId,
  ComposioToolkitSlug,
  IntegrationDefinition,
  ResolvedConnectionOf,
} from "../../contracts/integration.js";
import type { RunMemory } from "../../gateway/catalog.js";
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
  runMemory?(): RunMemory;
}
