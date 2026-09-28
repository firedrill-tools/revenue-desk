// Rules HubSpot enforces that the forwarded 0.4.0 schema does not state.
//
// HubSpot refuses an engagement record (note, task, call, meeting, email)
// without hs_timestamp ("Property \"hs_timestamp\" is required"), but
// hubspot-batch-create-objects' schema leaves properties open, so the model
// learns it only from a failed call. The gateway checks it before the call
// (InputCheckSource, src/gateway/catalog.ts): the call is rejected without
// reaching HubSpot, and the message says exactly what to add.

import type { JsonObject } from "../../contracts/json.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import { arr, isObject, obj, str } from "../shared/json.js";

/** Engagement object types whose records need hs_timestamp on create. */
export const TIMESTAMPED_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "notes",
  "tasks",
  "calls",
  "meetings",
  "emails",
]);

function timestampHint(objectType: string): string {
  return objectType === "tasks"
    ? "the task's due time as an ISO 8601 date-time, e.g. 2026-10-01T18:00:00Z"
    : "when it happened, as an ISO 8601 date-time, e.g. 2026-09-28T14:00:00Z";
}

/** Issues of a HubSpot call that satisfies its schema; empty when HubSpot would accept it. */
export function checkHubSpotInput(tool: string, input: JsonObject): readonly SchemaIssue[] {
  if (tool !== "hubspot-batch-create-objects") return [];
  const objectType = str(input, "objectType");
  if (objectType === undefined || !TIMESTAMPED_OBJECT_TYPES.has(objectType)) return [];
  const issues: SchemaIssue[] = [];
  (arr(input, "inputs") ?? []).forEach((record, index) => {
    if (!isObject(record)) return;
    const properties = obj(record, "properties");
    const timestamp = properties === undefined ? undefined : properties.hs_timestamp;
    const present =
      (typeof timestamp === "string" && timestamp.trim() !== "") || typeof timestamp === "number";
    if (!present) {
      issues.push({
        path: `/inputs/${index}/properties`,
        message: `is missing "hs_timestamp", which HubSpot requires for ${objectType}: ${timestampHint(objectType)}`,
      });
    }
  });
  return issues;
}
