// Connection rows as the Connections screen and the app bar show them.
//
// Alias-free and DOM-free so the Node test suite can import it.

import type { ConnectionView } from "../../../src/contracts/api.js";
import type { ConnectionKind, IntegrationId } from "../../../src/contracts/integration.js";

/** A check older than this is run again when the Connections page or popover opens. */
export const STALE_CHECK_MS = 30 * 60_000;

/** Configured integrations whose last check is missing or older than `maxAgeMs`. */
export function staleConnections(
  connections: readonly Pick<ConnectionView, "integration" | "state" | "checkedAt">[],
  now: number,
  maxAgeMs: number = STALE_CHECK_MS,
): IntegrationId[] {
  return connections
    .filter((connection) => connection.state !== "not_configured" && connection.state !== "invalid")
    .filter((connection) => {
      if (connection.checkedAt === null) return true;
      const at = Date.parse(connection.checkedAt);
      return Number.isNaN(at) || now - at > maxAgeMs;
    })
    .map((connection) => connection.integration);
}

/**
 * A row's status detail: the plain sentence first, and the provider's own
 * words (a check's second line) apart, to show muted. A not-configured row
 * says what to do; its Missing column names the variables.
 */
export function connectionDetail(connection: Pick<ConnectionView, "state" | "detail">): {
  readonly summary: string;
  readonly provider: string | null;
} {
  if (connection.state === "not_configured") {
    return {
      summary: "Add these to the file DOTENV_PATH names, then restart Revenue Desk.",
      provider: null,
    };
  }
  const [summary = "", ...rest] = connection.detail.split("\n");
  const provider = rest.join("\n").trim();
  return { summary: summary.trim(), provider: provider === "" ? null : provider };
}

/** What each connection kind is, for the page's legend. */
export const KIND_EXPLANATIONS: readonly (readonly [ConnectionKind, string])[] = [
  ["composio", "Google sign-in held by Composio; use Connect to sign in."],
  ["mcp", "HubSpot's own MCP server, run with your private-app token."],
  ["api", "Direct calls with a key from your configuration file."],
];
