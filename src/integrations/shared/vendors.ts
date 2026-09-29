// The vendor endpoints Revenue Desk talks to (docs/ARCHITECTURE.md §3,
// decisions log "vendor hosts pinned").
//
// They are constants on purpose: no environment variable, setting or request
// can change them, so the product can only ever reach the real services.
// Configuration supplies credentials, never a host.
//
// - Composio: its API. The Composio SDK would otherwise take a base URL from
//   its own environment variable or its user config file, so it is always
//   given this one explicitly (src/integrations/composio/session.ts).
// - Stripe: its REST API (src/integrations/stripe/client.ts).
// - HubSpot: the official @hubspot/mcp-server 0.4.x keeps its own default
//   host (api.hubspot.com); its child environment never carries the server's
//   base-URL override variable, and its .env lookup is pointed at the null
//   device (src/integrations/hubspot/launch.ts).
//   Revenue Desk's owners lookup calls HubSpot's REST API at api.hubapi.com.

/** Composio's API; also the Composio SDK's own default. */
export const COMPOSIO_API_ORIGIN = "https://backend.composio.dev";

/** Stripe's REST API. */
export const STRIPE_API_ORIGIN = "https://api.stripe.com";

/** HubSpot's REST API, for the owners lookup (src/integrations/hubspot/owners.ts). */
export const HUBSPOT_API_ORIGIN = "https://api.hubapi.com";

/** Where @hubspot/mcp-server 0.4.x sends its requests: its own default, never overridden. */
export const HUBSPOT_MCP_SERVER_API_HOST = "api.hubspot.com";
