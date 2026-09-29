// HubSpot owners: who a record is assigned to (hubspot_owner_id).
//
// HubSpot's MCP server 0.4.0 has no owners tool, and owners are not CRM
// objects, so hubspot-batch-read-objects refuses objectType "owners". In the
// live runs the agent could not name owner 71001 on a task it created or on
// a closed-won deal. This one read-only tool calls HubSpot's REST API
// (GET /crm/v3/owners) in process, beside the forwarded MCP tools.
//
// It uses the same credential as the MCP server (HUBSPOT_ACCESS_TOKEN), sent
// as a Bearer token to HubSpot's REST API at the pinned
// https://api.hubapi.com (src/integrations/shared/vendors.ts).

import { z } from "zod";
import type { SecretValue } from "../../contracts/env.js";
import type { HubSpotConnection } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { type ApiTool, apiTool } from "../shared/api-tool.js";
import { ApiToolError, transportFailure } from "../shared/errors.js";
import { type HttpDeps, sendHttp, TransportError } from "../shared/http.js";
import { arr, asObject, bool, compact, isObject, obj, objects, str } from "../shared/json.js";
import { identifier } from "../shared/schema.js";
import { scrub } from "../shared/text.js";
import { joinUrl } from "../shared/url.js";
import { HUBSPOT_API_ORIGIN } from "../shared/vendors.js";

export const HUBSPOT_PROVIDER = "hubspot";

export const OWNERS_TOOL = "hubspot-list-owners";

export const OWNERS_INPUT = {
  owner_id: identifier(
    /^\d+$/,
    "One owner by id, e.g. a record's hubspot_owner_id. Omit to list owners.",
  ).optional(),
  email: z.email().optional().describe("Only the owner with this email address, exactly."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("How many owners to return (1-500, default 100)."),
  after: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Cursor for the next page: pass next_after from the previous result."),
};

function ownerView(owner: JsonObject): JsonObject {
  const first = str(owner, "firstName");
  const last = str(owner, "lastName");
  const name = [first, last].filter((part) => part !== undefined).join(" ");
  const teams = objects(owner, "teams")
    .map((team) => str(team, "name"))
    .filter((team): team is string => team !== undefined);
  return compact({
    id: str(owner, "id"),
    name: name === "" ? undefined : name,
    email: str(owner, "email"),
    user_id: owner.userId ?? undefined,
    archived: bool(owner, "archived"),
    teams: teams.length === 0 ? undefined : teams,
  });
}

function hubspotError(status: number, body: JsonValue | undefined, secret: string): ApiToolError {
  const root = asObject(body);
  const code = str(root, "category") ?? `http_${status}`;
  const message =
    status === 404
      ? "HubSpot has no active owner with that id."
      : (str(root, "message") ?? `HubSpot returned HTTP ${status}.`);
  return new ApiToolError(HUBSPOT_PROVIDER, scrub(message, [secret]), { status, code });
}

async function getJson(
  token: SecretValue,
  path: string,
  query: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal | undefined,
  http: HttpDeps,
): Promise<JsonObject> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
  const search = params.toString();
  const url = `${joinUrl(HUBSPOT_API_ORIGIN, path)}${search === "" ? "" : `?${search}`}`;
  const secret = token.reveal();
  let response: Awaited<ReturnType<typeof sendHttp>>;
  try {
    response = await sendHttp(
      {
        method: "GET",
        url,
        headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
        retryable: true,
        signal,
      },
      http,
    );
  } catch (error) {
    if (error instanceof TransportError) throw transportFailure(HUBSPOT_PROVIDER, error);
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    throw hubspotError(response.status, response.json, secret);
  }
  const body = asObject(response.json);
  if (body === undefined) {
    throw new ApiToolError(HUBSPOT_PROVIDER, "HubSpot returned a response that is not JSON.", {
      status: response.status,
      code: "invalid_response",
    });
  }
  return body;
}

/** HubSpot's in-process API tools for a connection: the owners lookup. */
export function createHubSpotApiTools(
  connection: HubSpotConnection,
  http: HttpDeps = {},
): readonly ApiTool[] {
  const token = connection.mcp.accessToken;
  return [
    apiTool({
      name: OWNERS_TOOL,
      description:
        "List HubSpot owners (the people records are assigned to) with their names and email " +
        "addresses, or get one owner by id, such as a record's hubspot_owner_id. Use it to " +
        "name an owner instead of showing the id. Read-only.",
      input: OWNERS_INPUT,
      readOnly: true,
      async run(args, call) {
        if (args.owner_id !== undefined) {
          const owner = await getJson(
            token,
            `/crm/v3/owners/${encodeURIComponent(args.owner_id)}`,
            {},
            call.signal,
            http,
          );
          return { owners: [ownerView(owner)], next_after: null };
        }
        const body = await getJson(
          token,
          "/crm/v3/owners",
          { email: args.email, limit: String(args.limit ?? 100), after: args.after },
          call.signal,
          http,
        );
        const owners = (arr(body, "results") ?? []).filter(isObject).map(ownerView);
        return {
          owners,
          next_after: str(obj(obj(body, "paging"), "next"), "after") ?? null,
        };
      },
    }),
  ];
}
