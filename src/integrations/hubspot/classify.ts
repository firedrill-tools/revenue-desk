// Classifies HubSpot MCP tool calls by tool name and CRM object type
// (docs/ARCHITECTURE.md §2, §7). Reads are read. Creating and updating CRM
// records stays inside the company's CRM, so it is internal_write, with the
// operation named for the object type (hubspot.notes.create). Writes to object
// types outside WRITABLE_OBJECT_TYPES (custom objects, quotes, users, …) are
// denied: the classifier cannot judge what they reach.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { arr, isObject, obj, objects, str } from "../shared/json.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { countOf, listOf, preview } from "../shared/text.js";
import { HUBSPOT_PROFILE } from "./profile.js";

/** CRM object types Revenue Desk may create or update, with their singular nouns. */
export const WRITABLE_OBJECT_TYPES = {
  companies: "company",
  contacts: "contact",
  deals: "deal",
  tickets: "ticket",
  notes: "note",
  tasks: "task",
  calls: "call",
  meetings: "meeting",
  emails: "email",
  line_items: "line item",
  products: "product",
  leads: "lead",
} as const;

type WritableObjectType = keyof typeof WRITABLE_OBJECT_TYPES;

function isWritable(objectType: string): objectType is WritableObjectType {
  return Object.hasOwn(WRITABLE_OBJECT_TYPES, objectType);
}

/** Properties that best describe a record of each type, for the approval facts. */
const SUMMARY_PROPERTIES: Readonly<Record<WritableObjectType, readonly string[]>> = {
  companies: ["name", "domain"],
  contacts: ["email", "firstname", "lastname"],
  deals: ["dealname", "amount", "dealstage", "closedate"],
  tickets: ["subject", "hs_pipeline_stage"],
  notes: ["hs_note_body", "hs_timestamp"],
  tasks: ["hs_task_subject", "hs_timestamp", "hs_task_priority", "hs_task_body"],
  calls: ["hs_call_title", "hs_call_body", "hs_timestamp"],
  meetings: ["hs_meeting_title", "hs_meeting_start_time"],
  emails: ["hs_email_subject", "hs_timestamp"],
  line_items: ["name", "quantity", "price"],
  products: ["name", "price"],
  leads: ["hs_lead_name"],
};

const OBJECT_TYPE = /^[a-z][a-z0-9_]{0,63}$|^\d+-\d+$/;

/** A readable object type for titles, or null when the input has none we trust. */
function objectTypeOf(input: JsonObject): string | null {
  const value = str(input, "objectType");
  return value !== undefined && OBJECT_TYPE.test(value) ? value : null;
}

function readTitle(tool: string, objectType: string | null, fallback: string): string {
  if (objectType === null) return fallback;
  const noun = objectType.replace(/_/g, " ");
  switch (tool) {
    case "hubspot-list-objects":
      return `List HubSpot ${noun}`;
    case "hubspot-search-objects":
      return `Search HubSpot ${noun}`;
    case "hubspot-batch-read-objects":
      return `Read HubSpot ${noun}`;
    case "hubspot-list-properties":
      return `List HubSpot ${noun} properties`;
    default:
      return fallback;
  }
}

function recordSummary(
  objectType: WritableObjectType,
  properties: JsonObject | undefined,
): string | null {
  if (properties === undefined) return null;
  const parts: string[] = [];
  for (const key of SUMMARY_PROPERTIES[objectType]) {
    const value = str(properties, key);
    if (value !== undefined) parts.push(`${key}: ${preview(value, 120)}`);
  }
  return parts.length === 0 ? null : parts.join("; ");
}

type WriteKind = "create" | "update";

function unique(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value !== undefined && !out.includes(value)) out.push(value);
  return out;
}

function classifyWrite(kind: WriteKind, input: JsonObject): Classification | null {
  const objectType = objectTypeOf(input);
  if (objectType === null || !isWritable(objectType)) return null;
  const items = arr(input, "inputs");
  if (items === undefined || items.length === 0 || !items.every(isObject)) return null;
  const records = objects(input, "inputs");
  if (kind === "update" && records.some((record) => str(record, "id") === undefined)) return null;

  const noun = WRITABLE_OBJECT_TYPES[objectType];
  const counted = countOf(records.length, noun, objectType.replace(/_/g, " "));
  const recordIds =
    kind === "update"
      ? unique(records.map((record) => str(record, "id")))
      : unique(
          records.flatMap((record) =>
            objects(record, "associations").map((association) => str(obj(association, "to"), "id")),
          ),
        );
  const facts: ApprovalFact[] = [{ label: "Records", value: counted }];
  if (recordIds.length > 0) {
    facts.push({
      label: kind === "update" ? "Record ids" : "Linked to",
      value: listOf(recordIds, 6),
    });
  }
  records.slice(0, 5).forEach((record, index) => {
    const summary = recordSummary(objectType, obj(record, "properties"));
    if (summary !== null) facts.push({ label: `${noun} ${index + 1}`, value: summary });
  });

  const verb = kind === "create" ? "Create" : "Update";
  return {
    actionClass: "internal_write",
    operation: `hubspot.${objectType}.${kind}`,
    title: records.length === 1 ? `${verb} ${noun} in HubSpot` : `${verb} ${counted} in HubSpot`,
    details: {
      consequence: `${verb} ${counted} in HubSpot`,
      facts,
      ...(recordIds.length === 0 ? {} : { recordIds }),
    },
  };
}

export function classifyHubSpot(
  tool: string,
  input: JsonObject,
  _settings: ClassifierSettings,
): Classification | null {
  const spec = specOf(HUBSPOT_PROFILE, tool);
  if (spec === undefined) return null;
  switch (spec.name) {
    case "hubspot-batch-create-objects":
      return classifyWrite("create", input);
    case "hubspot-batch-update-objects":
      return classifyWrite("update", input);
    default: {
      const base = fromSpec(spec);
      if (base === null) return null;
      return { ...base, title: readTitle(spec.name, objectTypeOf(input), spec.title) };
    }
  }
}
