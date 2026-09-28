/**
 * The CRM behind the HubSpot fake: objects, properties, associations and
 * owners, with the semantics of HubSpot's CRM v3/v4 APIs that the pinned
 * `@hubspot/mcp-server` 0.4.0 calls (list, search, batch read, batch create
 * with inline associations, batch update, association lists and labels,
 * properties). HTTP framing lives in index.ts.
 */
import type { JsonObject, JsonValue } from "../../../../src/contracts/json.js";
import type { FakeClock } from "../core/clock.js";
import {
  HUBSPOT_OBJECT_TYPES,
  type HubSpotFixture,
  type HubSpotObjectType,
  type HubSpotPropertyFixture,
} from "../fixtures.js";

export type { HubSpotObjectType };

/** A HubSpot API error: HTTP status, category and message (index.ts adds the envelope). */
export class HubSpotApiError extends Error {
  constructor(
    readonly status: number,
    readonly category: string,
    message: string,
    readonly extra: JsonObject = {},
  ) {
    super(message);
  }
}

interface CrmObject {
  readonly id: string;
  readonly type: HubSpotObjectType;
  readonly createdAt: string;
  updatedAt: string;
  properties: Record<string, string>;
  history: Record<string, { value: string; timestamp: string }[]>;
}

interface Edge {
  readonly from: HubSpotObjectType;
  readonly fromId: string;
  readonly to: HubSpotObjectType;
  readonly toId: string;
  readonly typeId: number;
}

interface AssociationDefinition {
  readonly from: HubSpotObjectType;
  readonly to: HubSpotObjectType;
  readonly typeId: number;
  readonly label: string | null;
  readonly inverse: number;
}

/** HUBSPOT_DEFINED association types between the fake's object types, with their inverse. */
const DEFINITIONS: readonly AssociationDefinition[] = [
  { from: "contacts", to: "companies", typeId: 279, label: null, inverse: 280 },
  { from: "contacts", to: "companies", typeId: 1, label: "Primary", inverse: 2 },
  { from: "companies", to: "contacts", typeId: 280, label: null, inverse: 279 },
  { from: "companies", to: "contacts", typeId: 2, label: "Primary", inverse: 1 },
  { from: "deals", to: "companies", typeId: 341, label: null, inverse: 342 },
  { from: "deals", to: "companies", typeId: 5, label: "Primary", inverse: 6 },
  { from: "companies", to: "deals", typeId: 342, label: null, inverse: 341 },
  { from: "companies", to: "deals", typeId: 6, label: "Primary", inverse: 5 },
  { from: "deals", to: "contacts", typeId: 3, label: null, inverse: 4 },
  { from: "contacts", to: "deals", typeId: 4, label: null, inverse: 3 },
  { from: "notes", to: "contacts", typeId: 202, label: null, inverse: 201 },
  { from: "contacts", to: "notes", typeId: 201, label: null, inverse: 202 },
  { from: "notes", to: "companies", typeId: 190, label: null, inverse: 189 },
  { from: "companies", to: "notes", typeId: 189, label: null, inverse: 190 },
  { from: "notes", to: "deals", typeId: 214, label: null, inverse: 213 },
  { from: "deals", to: "notes", typeId: 213, label: null, inverse: 214 },
  { from: "tasks", to: "contacts", typeId: 204, label: null, inverse: 203 },
  { from: "contacts", to: "tasks", typeId: 203, label: null, inverse: 204 },
  { from: "tasks", to: "companies", typeId: 192, label: null, inverse: 191 },
  { from: "companies", to: "tasks", typeId: 191, label: null, inverse: 192 },
  { from: "tasks", to: "deals", typeId: 216, label: null, inverse: 215 },
  { from: "deals", to: "tasks", typeId: 215, label: null, inverse: 216 },
];

const TYPE_IDS: Readonly<Record<string, HubSpotObjectType>> = {
  "0-1": "contacts",
  "0-2": "companies",
  "0-3": "deals",
  "0-46": "notes",
  "0-27": "tasks",
};

const SINGULAR: Readonly<Record<HubSpotObjectType, string>> = {
  contacts: "contact",
  companies: "company",
  deals: "deal",
  notes: "note",
  tasks: "task",
};

/** Properties returned when a request names none (HubSpot's defaults per type). */
const DEFAULT_PROPERTIES: Readonly<Record<HubSpotObjectType, readonly string[]>> = {
  contacts: ["createdate", "email", "firstname", "hs_object_id", "lastmodifieddate", "lastname"],
  companies: ["createdate", "domain", "hs_lastmodifieddate", "hs_object_id", "name"],
  deals: [
    "amount",
    "closedate",
    "createdate",
    "dealname",
    "dealstage",
    "hs_lastmodifieddate",
    "hs_object_id",
    "pipeline",
  ],
  notes: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  tasks: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
};

/** Properties the free-text `query` of a search matches, per type. */
const SEARCHABLE: Readonly<Record<HubSpotObjectType, readonly string[]>> = {
  contacts: ["firstname", "lastname", "email", "phone", "company"],
  companies: ["name", "domain", "phone"],
  deals: ["dealname", "pipeline", "dealstage", "description", "dealtype"],
  notes: ["hs_note_body"],
  tasks: ["hs_task_subject", "hs_task_body"],
};

const CREATED: Readonly<Record<HubSpotObjectType, string>> = {
  contacts: "createdate",
  companies: "createdate",
  deals: "createdate",
  notes: "hs_createdate",
  tasks: "hs_createdate",
};

const MODIFIED: Readonly<Record<HubSpotObjectType, string>> = {
  contacts: "lastmodifieddate",
  companies: "hs_lastmodifieddate",
  deals: "hs_lastmodifieddate",
  notes: "hs_lastmodifieddate",
  tasks: "hs_lastmodifieddate",
};

export interface SearchRequest {
  readonly query?: string;
  readonly limit?: number;
  readonly after?: string;
  readonly properties?: readonly string[];
  readonly sorts?: readonly { readonly propertyName: string; readonly direction: string }[];
  readonly filterGroups?: readonly {
    readonly filters: readonly {
      readonly propertyName: string;
      readonly operator: string;
      readonly value?: JsonValue;
      readonly values?: readonly JsonValue[];
      readonly highValue?: JsonValue;
    }[];
  }[];
}

export class HubSpotCrm {
  readonly portal: HubSpotFixture["portal"];
  readonly token: HubSpotFixture["token"];
  readonly owners: HubSpotFixture["owners"];
  private readonly properties: Record<HubSpotObjectType, HubSpotPropertyFixture[]>;
  private readonly objects: Record<HubSpotObjectType, Map<string, CrmObject>>;
  private readonly edges: Edge[] = [];
  private nextId: number;
  /** The first id new objects get: everything at or above it was created by a client. */
  readonly firstCreatedId: number;

  constructor(
    fixture: HubSpotFixture,
    private readonly clock: FakeClock,
  ) {
    const data = structuredClone(fixture);
    this.portal = data.portal;
    this.token = data.token;
    this.owners = data.owners;
    this.properties = data.properties;
    this.objects = {
      contacts: new Map(),
      companies: new Map(),
      deals: new Map(),
      notes: new Map(),
      tasks: new Map(),
    };
    let maxId = 0;
    for (const type of HUBSPOT_OBJECT_TYPES) {
      for (const record of data.objects[type]) {
        const properties: Record<string, string> = { ...record.properties };
        this.objects[type].set(record.id, {
          id: record.id,
          type,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          properties,
          history: Object.fromEntries(
            Object.entries(properties).map(([name, value]) => [
              name,
              [{ value, timestamp: record.createdAt }],
            ]),
          ),
        });
        maxId = Math.max(maxId, Number(record.id));
      }
    }
    this.nextId = maxId + 1;
    this.firstCreatedId = this.nextId;
    for (const edge of data.associations)
      this.associate(edge.from, edge.fromId, edge.to, edge.toId, edge.typeId);
  }

  /** An object type from a path segment: plural names and 0-x type ids. */
  objectType(segment: string): HubSpotObjectType {
    const lower = segment.toLowerCase();
    const type =
      TYPE_IDS[lower] ??
      HUBSPOT_OBJECT_TYPES.find((name) => name === lower || SINGULAR[name] === lower);
    if (type === undefined) {
      throw new HubSpotApiError(
        400,
        "VALIDATION_ERROR",
        `Unable to infer object type from: ${segment}`,
      );
    }
    return type;
  }

  // --- Reads -------------------------------------------------------------------

  list(
    type: HubSpotObjectType,
    options: {
      readonly limit?: number;
      readonly after?: string;
      readonly properties?: readonly string[];
      readonly associations?: readonly string[];
    },
  ): JsonObject {
    const limit = clampLimit(options.limit, 10, 100);
    const offset = offsetOf(options.after);
    const all = this.sorted(type);
    const page = all.slice(offset, offset + limit);
    const associationTypes = (options.associations ?? []).map((name) => this.objectType(name));
    return {
      results: page.map((object) => ({
        ...this.render(object, options.properties),
        ...(associationTypes.length === 0
          ? {}
          : { associations: this.associationsBlock(object, associationTypes) }),
      })),
      ...(offset + limit < all.length
        ? { paging: { next: { after: String(offset + limit), link: `?after=${offset + limit}` } } }
        : {}),
    };
  }

  get(type: HubSpotObjectType, id: string, properties?: readonly string[]): JsonObject {
    const object = this.objects[type].get(id);
    if (object === undefined)
      throw new HubSpotApiError(404, "OBJECT_NOT_FOUND", "resource not found");
    return this.render(object, properties);
  }

  search(type: HubSpotObjectType, request: SearchRequest): JsonObject {
    const groups = request.filterGroups ?? [];
    const filterCount = groups.reduce((sum, group) => sum + group.filters.length, 0);
    if (groups.length > 5 || groups.some((group) => group.filters.length > 6) || filterCount > 18) {
      throw new HubSpotApiError(
        400,
        "VALIDATION_ERROR",
        "Too many filters: use at most 5 filterGroups with up to 6 filters each and 18 in total.",
      );
    }
    if ((request.sorts ?? []).length > 1) {
      throw new HubSpotApiError(400, "VALIDATION_ERROR", "Only one sort is allowed.");
    }
    for (const group of groups) {
      for (const filter of group.filters) {
        if (
          !this.definition(type, filter.propertyName) &&
          !this.isSystem(type, filter.propertyName)
        ) {
          throw new HubSpotApiError(
            400,
            "VALIDATION_ERROR",
            `There was a problem with the request: property ${filter.propertyName} does not exist on ${type}.`,
          );
        }
      }
    }
    const tokens = (request.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    let matching = [...this.objects[type].values()].filter((object) => {
      const values = this.values(object);
      const textOk = tokens.every((token) =>
        SEARCHABLE[type].some((name) => (values[name] ?? "").toLowerCase().includes(token)),
      );
      const filtersOk =
        groups.length === 0 ||
        groups.some((group) =>
          group.filters.every((filter) => this.filterMatches(type, values, filter)),
        );
      return textOk && filtersOk;
    });
    const sort = request.sorts?.[0];
    matching =
      sort === undefined
        ? matching.sort((a, b) => Number(a.id) - Number(b.id))
        : matching.sort((a, b) => {
            const result = this.comparePropertyValues(
              type,
              sort.propertyName,
              this.values(a)[sort.propertyName],
              this.values(b)[sort.propertyName],
            );
            return (
              (sort.direction === "DESCENDING" ? -result : result) || Number(a.id) - Number(b.id)
            );
          });
    const limit = clampLimit(request.limit, 10, 200);
    const offset = offsetOf(request.after);
    const page = matching.slice(offset, offset + limit);
    return {
      total: matching.length,
      results: page.map((object) => this.render(object, request.properties)),
      ...(offset + limit < matching.length
        ? { paging: { next: { after: String(offset + limit) } } }
        : {}),
    };
  }

  batchRead(
    type: HubSpotObjectType,
    body: {
      readonly inputs: readonly { readonly id: string }[];
      readonly properties?: readonly string[];
      readonly propertiesWithHistory?: readonly string[];
    },
  ): { readonly status: number; readonly body: JsonObject } {
    const startedAt = this.now();
    const missing: string[] = [];
    const results: JsonObject[] = [];
    for (const input of body.inputs) {
      const object = this.objects[type].get(String(input.id));
      if (object === undefined) {
        missing.push(String(input.id));
        continue;
      }
      const rendered = this.render(object, body.properties);
      const withHistory = body.propertiesWithHistory ?? [];
      results.push(
        withHistory.length === 0
          ? rendered
          : {
              ...rendered,
              propertiesWithHistory: Object.fromEntries(
                withHistory.map((name) => [
                  name,
                  (object.history[name] ?? []).map((entry) => ({
                    value: entry.value,
                    timestamp: entry.timestamp,
                    sourceType: "CRM_UI",
                  })),
                ]),
              ),
            },
      );
    }
    const completedAt = this.now();
    if (missing.length === 0)
      return { status: 200, body: { status: "COMPLETE", results, startedAt, completedAt } };
    return {
      status: 207,
      body: {
        status: "COMPLETE",
        results,
        numErrors: 1,
        errors: [
          {
            status: "error",
            category: "OBJECT_NOT_FOUND",
            message: `Could not get some ${type} objects, they may be deleted or not exist. Check that ids are valid.`,
            context: { ids: missing },
          },
        ],
        startedAt,
        completedAt,
      },
    };
  }

  // --- Writes ------------------------------------------------------------------

  batchCreate(
    type: HubSpotObjectType,
    inputs: readonly {
      readonly properties: Readonly<Record<string, JsonValue>>;
      readonly associations?: readonly {
        readonly to: { readonly id: string };
        readonly types: readonly {
          readonly associationCategory: string;
          readonly associationTypeId: number;
        }[];
      }[];
    }[],
  ): JsonObject {
    if (inputs.length === 0 || inputs.length > 100) {
      throw new HubSpotApiError(
        400,
        "VALIDATION_ERROR",
        "Batch input must contain between 1 and 100 inputs.",
      );
    }
    const startedAt = this.now();
    // Validate everything first: a batch that fails creates nothing.
    const prepared = inputs.map((input) => {
      const properties = this.validatedProperties(type, input.properties, {
        requireRequired: true,
      });
      const associations = (input.associations ?? []).flatMap((association) =>
        association.types.map((entry) =>
          this.validatedAssociation(type, String(association.to.id), entry),
        ),
      );
      return { properties, associations };
    });
    const results = prepared.map(({ properties, associations }) => {
      const id = String(this.nextId++);
      const at = this.now();
      const object: CrmObject = {
        id,
        type,
        createdAt: at,
        updatedAt: at,
        properties,
        history: Object.fromEntries(
          Object.entries(properties).map(([name, value]) => [name, [{ value, timestamp: at }]]),
        ),
      };
      this.objects[type].set(id, object);
      for (const association of associations)
        this.associate(type, id, association.to, association.toId, association.typeId);
      return this.render(object, Object.keys(properties));
    });
    return { status: "COMPLETE", results, startedAt, completedAt: this.now() };
  }

  batchUpdate(
    type: HubSpotObjectType,
    inputs: readonly {
      readonly id: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }[],
  ): { readonly status: number; readonly body: JsonObject } {
    if (inputs.length === 0 || inputs.length > 100) {
      throw new HubSpotApiError(
        400,
        "VALIDATION_ERROR",
        "Batch input must contain between 1 and 100 inputs.",
      );
    }
    const startedAt = this.now();
    const missing = inputs
      .filter((input) => !this.objects[type].has(String(input.id)))
      .map((input) => String(input.id));
    const prepared = inputs
      .filter((input) => this.objects[type].has(String(input.id)))
      .map((input) => ({
        id: String(input.id),
        properties: this.validatedProperties(type, input.properties, { requireRequired: false }),
      }));
    const results = prepared.map(({ id, properties }) => {
      const object = this.objects[type].get(id) as CrmObject;
      const at = this.now();
      for (const [name, value] of Object.entries(properties)) {
        object.properties[name] = value;
        object.history[name] = [{ value, timestamp: at }, ...(object.history[name] ?? [])];
      }
      object.updatedAt = at;
      return this.render(object, Object.keys(properties));
    });
    const body: JsonObject = { status: "COMPLETE", results, startedAt, completedAt: this.now() };
    if (missing.length === 0) return { status: 200, body };
    return {
      status: 207,
      body: {
        ...body,
        numErrors: 1,
        errors: [
          {
            status: "error",
            category: "OBJECT_NOT_FOUND",
            message: `Could not find ${type} to update`,
            context: { ids: missing },
          },
        ],
      },
    };
  }

  // --- Associations and properties ---------------------------------------------

  associationsOf(
    type: HubSpotObjectType,
    id: string,
    toType: HubSpotObjectType,
    after?: string,
  ): JsonObject {
    if (!this.objects[type].has(id))
      throw new HubSpotApiError(404, "OBJECT_NOT_FOUND", "resource not found");
    const grouped = new Map<string, number[]>();
    for (const edge of this.edges) {
      if (edge.from !== type || edge.fromId !== id || edge.to !== toType) continue;
      grouped.set(edge.toId, [...(grouped.get(edge.toId) ?? []), edge.typeId]);
    }
    const all = [...grouped.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    const offset = offsetOf(after);
    const page = all.slice(offset, offset + 500);
    return {
      results: page.map(([toId, typeIds]) => ({
        toObjectId: Number(toId),
        associationTypes: typeIds.map((typeId) => ({
          category: "HUBSPOT_DEFINED",
          typeId,
          label: DEFINITIONS.find((definition) => definition.typeId === typeId)?.label ?? null,
        })),
      })),
      ...(offset + 500 < all.length ? { paging: { next: { after: String(offset + 500) } } } : {}),
    };
  }

  associationLabels(from: HubSpotObjectType, to: HubSpotObjectType): JsonObject {
    return {
      results: DEFINITIONS.filter(
        (definition) => definition.from === from && definition.to === to,
      ).map((definition) => ({
        category: "HUBSPOT_DEFINED",
        typeId: definition.typeId,
        label: definition.label,
      })),
    };
  }

  listProperties(type: HubSpotObjectType): JsonObject {
    return { results: this.properties[type].map((property) => this.propertyJson(type, property)) };
  }

  property(type: HubSpotObjectType, name: string): JsonObject {
    const property = this.definition(type, name);
    if (property === undefined) {
      throw new HubSpotApiError(
        404,
        "OBJECT_NOT_FOUND",
        `Unable to find property ${name} for object type ${type}`,
      );
    }
    return this.propertyJson(type, property);
  }

  owner(id: string, idProperty: string | null): JsonObject {
    const owner = this.owners.find((entry) =>
      idProperty === "userId" ? String(entry.userId) === id : entry.id === id,
    );
    if (owner === undefined) throw new HubSpotApiError(404, "OBJECT_NOT_FOUND", "Owner not found");
    return {
      id: owner.id,
      email: owner.email,
      type: "PERSON",
      firstName: owner.firstName,
      lastName: owner.lastName,
      userId: owner.userId,
      userIdIncludingInactive: owner.userId,
      createdAt: "2025-10-01T14:00:00.000Z",
      updatedAt: "2026-06-01T14:00:00.000Z",
      archived: false,
      teams: [],
    };
  }

  /** Every association edge (both directions), for assertions. */
  associations(): readonly Edge[] {
    return this.edges;
  }

  /** Objects of a type created after the fixture was loaded (id order). */
  created(type: HubSpotObjectType, afterId: number): JsonObject[] {
    return [...this.objects[type].values()]
      .filter((object) => Number(object.id) >= afterId)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((object) => ({
        ...this.render(object, Object.keys(object.properties)),
        associations: this.edges
          .filter((edge) => edge.from === type && edge.fromId === object.id)
          .map((edge) => ({ to: edge.to, toId: edge.toId, typeId: edge.typeId })),
      }));
  }

  // --- Internals ---------------------------------------------------------------

  private render(object: CrmObject, requested?: readonly string[]): JsonObject {
    const values = this.values(object);
    const names =
      requested === undefined || requested.length === 0
        ? DEFAULT_PROPERTIES[object.type]
        : [
            ...new Set([...requested, "hs_object_id", CREATED[object.type], MODIFIED[object.type]]),
          ].filter(
            (name) =>
              this.definition(object.type, name) !== undefined || this.isSystem(object.type, name),
          );
    const properties: Record<string, JsonValue> = {};
    for (const name of [...names].sort()) properties[name] = values[name] ?? null;
    return {
      id: object.id,
      properties,
      createdAt: object.createdAt,
      updatedAt: object.updatedAt,
      archived: false,
    };
  }

  private values(object: CrmObject): Record<string, string> {
    return {
      ...object.properties,
      hs_object_id: object.id,
      [CREATED[object.type]]: object.createdAt,
      [MODIFIED[object.type]]: object.updatedAt,
    };
  }

  private sorted(type: HubSpotObjectType): CrmObject[] {
    return [...this.objects[type].values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  private associationsBlock(object: CrmObject, types: readonly HubSpotObjectType[]): JsonObject {
    const block: Record<string, JsonValue> = {};
    for (const toType of types) {
      const results = this.edges
        .filter(
          (edge) => edge.from === object.type && edge.fromId === object.id && edge.to === toType,
        )
        .map((edge) => ({
          id: edge.toId,
          type: `${SINGULAR[object.type]}_to_${SINGULAR[toType]}`,
        }));
      if (results.length > 0) block[toType] = { results };
    }
    return block;
  }

  private associate(
    from: HubSpotObjectType,
    fromId: string,
    to: HubSpotObjectType,
    toId: string,
    typeId: number,
  ): void {
    const definition = DEFINITIONS.find(
      (entry) => entry.from === from && entry.to === to && entry.typeId === typeId,
    );
    if (definition === undefined)
      throw new Error(`No association type ${typeId} from ${from} to ${to}`);
    const add = (edge: Edge) => {
      if (
        !this.edges.some(
          (existing) =>
            existing.from === edge.from &&
            existing.fromId === edge.fromId &&
            existing.to === edge.to &&
            existing.toId === edge.toId &&
            existing.typeId === edge.typeId,
        )
      ) {
        this.edges.push(edge);
      }
    };
    add({ from, fromId, to, toId, typeId });
    add({ from: to, fromId: toId, to: from, toId: fromId, typeId: definition.inverse });
  }

  private validatedAssociation(
    from: HubSpotObjectType,
    toId: string,
    entry: { readonly associationCategory: string; readonly associationTypeId: number },
  ): { readonly to: HubSpotObjectType; readonly toId: string; readonly typeId: number } {
    const definition = DEFINITIONS.find(
      (candidate) => candidate.from === from && candidate.typeId === entry.associationTypeId,
    );
    if (entry.associationCategory !== "HUBSPOT_DEFINED" || definition === undefined) {
      throw new HubSpotApiError(
        400,
        "VALIDATION_ERROR",
        `${entry.associationCategory} association type id ${entry.associationTypeId} is not valid for ${from}.`,
      );
    }
    if (!this.objects[definition.to].has(toId)) {
      throw new HubSpotApiError(
        400,
        "VALIDATION_ERROR",
        `Could not find ${SINGULAR[definition.to]} ${toId} to associate with (association type ${definition.typeId}).`,
      );
    }
    return { to: definition.to, toId, typeId: definition.typeId };
  }

  private validatedProperties(
    type: HubSpotObjectType,
    input: Readonly<Record<string, JsonValue>>,
    options: { readonly requireRequired: boolean },
  ): Record<string, string> {
    const errors: JsonObject[] = [];
    const out: Record<string, string> = {};
    const invalid = (name: string, error: string, message: string) =>
      errors.push({
        isValid: false,
        message,
        error,
        name,
        localizedErrorMessage: message,
        portalId: this.portal.hubId,
      });
    for (const [name, raw] of Object.entries(input)) {
      const definition = this.definition(type, name);
      if (definition === undefined) {
        invalid(name, "PROPERTY_DOESNT_EXIST", `Property "${name}" does not exist`);
        continue;
      }
      if (definition.readOnly === true) {
        invalid(name, "READ_ONLY_VALUE", `Property "${name}" is read-only`);
        continue;
      }
      const value = raw === null ? "" : String(raw);
      if (definition.type === "number" && value !== "" && Number.isNaN(Number(value))) {
        invalid(name, "INVALID_FLOAT", `${JSON.stringify(value)} is not a valid number`);
        continue;
      }
      if (
        (definition.type === "datetime" || definition.type === "date") &&
        value !== "" &&
        parseHubSpotDate(value) === null
      ) {
        invalid(name, "INVALID_DATE", `${JSON.stringify(value)} is not a valid date or datetime`);
        continue;
      }
      if (definition.type === "enumeration" && value !== "") {
        const options =
          definition.options === "owners"
            ? this.owners.map((owner) => owner.id)
            : (definition.options ?? []);
        if (!options.includes(value)) {
          invalid(
            name,
            "INVALID_OPTION",
            `${value} was not one of the allowed options: [${options.join(", ")}]`,
          );
          continue;
        }
      }
      out[name] =
        definition.type === "datetime" && value !== ""
          ? (parseHubSpotDate(value) as string)
          : value;
    }
    if (options.requireRequired) {
      for (const property of this.properties[type]) {
        if (property.required === true && (out[property.name] ?? "") === "") {
          invalid(property.name, "REQUIRED_PROPERTY", `Property "${property.name}" is required`);
        }
      }
    }
    if (errors.length > 0) {
      throw new HubSpotApiError(
        400,
        "VALIDATION_ERROR",
        `Property values were not valid: ${JSON.stringify(errors)}`,
        {
          errors: errors.map((error) => ({
            message: String(error.message),
            code: String(error.error),
            context: { propertyName: [String(error.name)] },
          })),
        },
      );
    }
    return out;
  }

  private filterMatches(
    type: HubSpotObjectType,
    values: Readonly<Record<string, string>>,
    filter: NonNullable<SearchRequest["filterGroups"]>[number]["filters"][number],
  ): boolean {
    const actual = values[filter.propertyName];
    const has = actual !== undefined && actual !== "";
    const compare = (target: JsonValue | undefined) =>
      this.comparePropertyValues(
        type,
        filter.propertyName,
        actual,
        target === undefined || target === null ? undefined : String(target),
      );
    switch (filter.operator) {
      case "HAS_PROPERTY":
        return has;
      case "NOT_HAS_PROPERTY":
        return !has;
      case "EQ":
        return has && compare(filter.value) === 0;
      case "NEQ":
        return !has || compare(filter.value) !== 0;
      case "LT":
        return has && compare(filter.value) < 0;
      case "LTE":
        return has && compare(filter.value) <= 0;
      case "GT":
        return has && compare(filter.value) > 0;
      case "GTE":
        return has && compare(filter.value) >= 0;
      case "BETWEEN":
        return has && compare(filter.value) >= 0 && compare(filter.highValue) <= 0;
      case "IN":
        return has && (filter.values ?? []).some((candidate) => compare(candidate) === 0);
      case "NOT_IN":
        return !has || !(filter.values ?? []).some((candidate) => compare(candidate) === 0);
      case "CONTAINS_TOKEN":
      case "NOT_CONTAINS_TOKEN": {
        const pattern = String(filter.value ?? "")
          .toLowerCase()
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*");
        const found =
          has &&
          (actual ?? "")
            .toLowerCase()
            .split(/[\s@.,;:]+/)
            .some((token) => new RegExp(`^${pattern}$`).test(token));
        return filter.operator === "CONTAINS_TOKEN" ? found : !found;
      }
      default:
        throw new HubSpotApiError(400, "VALIDATION_ERROR", `Unknown operator ${filter.operator}`);
    }
  }

  private comparePropertyValues(
    type: HubSpotObjectType,
    name: string,
    left: string | undefined,
    right: string | undefined,
  ): number {
    if (left === undefined) return right === undefined ? 0 : -1;
    if (right === undefined) return 1;
    const kind =
      this.definition(type, name)?.type ??
      (name === "hs_object_id" ? "number" : this.isSystem(type, name) ? "datetime" : "string");
    if (kind === "number") return Number(left) - Number(right);
    if (kind === "datetime" || kind === "date") {
      const a = parseHubSpotDate(left);
      const b = parseHubSpotDate(right);
      if (a !== null && b !== null) return Date.parse(a) - Date.parse(b);
    }
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private definition(type: HubSpotObjectType, name: string): HubSpotPropertyFixture | undefined {
    return this.properties[type].find((property) => property.name === name);
  }

  private isSystem(type: HubSpotObjectType, name: string): boolean {
    return name === "hs_object_id" || name === CREATED[type] || name === MODIFIED[type];
  }

  private propertyJson(type: HubSpotObjectType, property: HubSpotPropertyFixture): JsonObject {
    const options =
      property.options === "owners"
        ? this.owners.map((owner, index) => ({
            label: `${owner.firstName} ${owner.lastName}`,
            value: owner.id,
            displayOrder: index,
            hidden: false,
          }))
        : (property.options ?? []).map((value, index) => ({
            label: value,
            value,
            displayOrder: index,
            hidden: false,
          }));
    return {
      updatedAt: "2025-10-01T14:00:00.000Z",
      createdAt: "2025-10-01T14:00:00.000Z",
      name: property.name,
      label: property.label,
      type: property.type,
      fieldType: property.fieldType,
      description: "",
      groupName: property.groupName,
      options,
      displayOrder: -1,
      calculated: false,
      externalOptions: false,
      hasUniqueValue: false,
      hidden: false,
      hubspotDefined: true,
      modificationMetadata: {
        archivable: false,
        readOnlyDefinition: true,
        readOnlyValue: property.readOnly === true,
      },
      formField: property.readOnly !== true,
      dataSensitivity: "non_sensitive",
      archived: false,
      objectType: type,
    };
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function offsetOf(after: string | undefined): number {
  if (after === undefined || after === "") return 0;
  const offset = Number(after);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new HubSpotApiError(400, "VALIDATION_ERROR", `Invalid paging cursor: ${after}`);
  }
  return offset;
}

/** An ISO date or datetime, or epoch milliseconds, as an ISO instant; null when neither. */
export function parseHubSpotDate(value: string): string | null {
  if (/^\d{10,14}$/.test(value)) return new Date(Number(value)).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  return new Date(parsed).toISOString();
}
