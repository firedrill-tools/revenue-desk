// The hubspot-mcp-0.4 profile: 10 of the 21 tools of @hubspot/mcp-server
// 0.4.0 (docs/ARCHITECTURE.md §2 and the decisions log), plus one read-only
// REST tool of Revenue Desk's own, the owners lookup (owners.ts), which the
// MCP server lacks. Notes and tasks are created with
// hubspot-batch-create-objects, their associations inline, so the
// association batch tool is not offered.

import type { ToolSpec } from "../../contracts/integration.js";
import { defineProfile } from "../shared/profile.js";

const read = (name: string, operation: ToolSpec["operation"], title: string): ToolSpec => ({
  name,
  upstream: name,
  operation,
  title,
  baseClass: "read",
  readOnly: true,
});

export const HUBSPOT_PROFILE = defineProfile("hubspot-mcp-0.4", "hubspot", [
  read("hubspot-get-user-details", "hubspot.account.get", "Get HubSpot account details"),
  read("hubspot-list-objects", "hubspot.objects.list", "List HubSpot records"),
  read("hubspot-search-objects", "hubspot.objects.search", "Search HubSpot records"),
  read("hubspot-batch-read-objects", "hubspot.objects.batch_read", "Read HubSpot records"),
  read("hubspot-list-associations", "hubspot.associations.list", "List HubSpot associations"),
  read(
    "hubspot-get-association-definitions",
    "hubspot.associations.definitions",
    "Get HubSpot association types",
  ),
  read("hubspot-list-properties", "hubspot.properties.list", "List HubSpot properties"),
  read("hubspot-get-property", "hubspot.properties.get", "Get HubSpot property"),
  {
    name: "hubspot-list-owners",
    upstream: "GET /crm/v3/owners",
    operation: "hubspot.owners.list",
    title: "List HubSpot owners",
    baseClass: "read",
    readOnly: true,
  },
  {
    name: "hubspot-batch-create-objects",
    upstream: "hubspot-batch-create-objects",
    operation: "hubspot.objects.create",
    title: "Create records in HubSpot",
    baseClass: "internal_write",
    readOnly: false,
  },
  {
    name: "hubspot-batch-update-objects",
    upstream: "hubspot-batch-update-objects",
    operation: "hubspot.objects.update",
    title: "Update records in HubSpot",
    baseClass: "internal_write",
    readOnly: false,
  },
]);

/** Profile tools Revenue Desk runs in process against HubSpot's REST API (owners.ts). */
export const HUBSPOT_API_TOOL_NAMES: readonly string[] = ["hubspot-list-owners"];

/** The allowlist: the upstream MCP tool names the gateway may list and forward. */
export const HUBSPOT_TOOL_NAMES: readonly string[] = Object.keys(HUBSPOT_PROFILE.tools).filter(
  (name) => !HUBSPOT_API_TOOL_NAMES.includes(name),
);
