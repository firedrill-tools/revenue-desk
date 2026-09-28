/**
 * Contract tests for the HubSpot CRM REST fake (the API the pinned
 * @hubspot/mcp-server 0.4.0 calls), independent of the agent and of MCP.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import { createClock } from "../../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";
import { HubSpotFake } from "../../support/fakes/hubspot/index.js";

const TOKEN = FAKE_CREDENTIALS.hubspotAccessToken;
let hubspot: HubSpotFake;

beforeEach(async () => {
  const fixtures = loadBusinessFixtures();
  hubspot = await HubSpotFake.start({
    fixture: fixtures.hubspot,
    clock: createClock(fixtures.company.asOf),
    accessToken: TOKEN,
    mcpToken: FAKE_CREDENTIALS.hubspotMcpToken,
    prefix: "/hubspot",
  });
});

afterEach(async () => {
  await hubspot.close();
});

async function api(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${hubspot.baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as JsonObject };
}

const ids = (body: JsonObject) => (body.results as JsonObject[]).map((result) => result.id);

describe("HubSpot fake: auth, account and owners", () => {
  it("answers a missing or wrong token with the INVALID_AUTHENTICATION envelope", async () => {
    for (const token of [null, "pat-na1-wrong"]) {
      const reply = await api("GET", "/crm/v3/objects/contacts", undefined, token);
      expect(reply.status).toBe(401);
      expect(reply.body).toMatchObject({ status: "error", category: "INVALID_AUTHENTICATION" });
      expect(reply.body.correlationId).toEqual(expect.any(String));
    }
  });

  it("serves token info, account details and owners by userId", async () => {
    const info = await api("POST", "/oauth/v2/private-apps/get/access-token-info", {
      tokenKey: TOKEN,
    });
    expect(info.body).toMatchObject({ userId: 9103, hubId: 48213377 });
    const account = await api("GET", "/account-info/v3/details");
    expect(account.body).toMatchObject({
      portalId: 48213377,
      companyCurrency: "USD",
      timeZone: "US/Eastern",
    });
    const owner = await api("GET", "/crm/v3/owners/9103?idProperty=userId&archived=false");
    expect(owner.body).toMatchObject({ id: "71003", email: "maya@kestrel.test", userId: 9103 });
    expect((await api("GET", "/crm/v3/owners/1?idProperty=userId")).status).toBe(404);
  });
});

describe("HubSpot fake: reads", () => {
  it("lists objects with default properties, paging and associations", async () => {
    const first = await api("GET", "/crm/v3/objects/deals?limit=4&archived=false");
    expect(ids(first.body)).toEqual(["90011001", "90011002", "90011003", "90011004"]);
    expect(first.body.paging).toMatchObject({ next: { after: "4" } });
    expect(Object.keys((first.body.results as JsonObject[])[0]?.properties as JsonObject)).toEqual([
      "amount",
      "closedate",
      "createdate",
      "dealname",
      "dealstage",
      "hs_lastmodifieddate",
      "hs_object_id",
      "pipeline",
    ]);
    const next = await api(
      "GET",
      "/crm/v3/objects/deals?limit=4&after=4&associations=companies,contacts",
    );
    expect(ids(next.body)).toEqual(["90011005", "90011006"]);
    expect(next.body.paging).toBeUndefined();
    expect((next.body.results as JsonObject[])[0]?.associations).toEqual({
      companies: { results: [{ id: "30011008", type: "deal_to_company" }] },
      contacts: { results: [{ id: "51011008", type: "deal_to_contact" }] },
    });
  });

  it("returns requested properties (null when unset) plus system properties", async () => {
    const reply = await api(
      "GET",
      "/crm/v3/objects/contacts/51011001?properties=email,phone,jobtitle,nope",
    );
    expect(reply.body.properties).toEqual({
      createdate: "2026-02-10T15:02:00.000Z",
      email: "dana@harborpine.test",
      hs_object_id: "51011001",
      jobtitle: "Finance Manager",
      lastmodifieddate: "2026-02-10T15:02:00.000Z",
      phone: "(207) 555-0118",
    });
    expect((await api("GET", "/crm/v3/objects/contacts/1")).status).toBe(404);
    expect((await api("GET", "/crm/v3/objects/widgets")).body).toMatchObject({
      category: "VALIDATION_ERROR",
    });
  });

  it("searches by text and by filter groups (AND within, OR across)", async () => {
    const byEmail = await api("POST", "/crm/v3/objects/contacts/search", {
      query: "dana@harborpine.test",
    });
    expect(byEmail.body).toMatchObject({ total: 1 });
    expect(ids(byEmail.body)).toEqual(["51011001"]);

    const closedWonThisWeek = await api("POST", "/crm/v3/objects/deals/search", {
      filterGroups: [
        {
          filters: [
            { propertyName: "dealstage", operator: "EQ", value: "closedwon" },
            { propertyName: "closedate", operator: "GTE", value: "2026-09-21T00:00:00Z" },
          ],
        },
      ],
      properties: ["dealname", "amount", "closedate"],
    });
    expect(ids(closedWonThisWeek.body)).toEqual(["90011004"]);
    expect((closedWonThisWeek.body.results as JsonObject[])[0]?.properties).toMatchObject({
      dealname: "Solstice Energy – Enterprise annual",
      amount: "18000",
    });

    const createdThisWeek = await api("POST", "/crm/v3/objects/deals/search", {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "createdate",
              operator: "GTE",
              value: String(Date.parse("2026-09-21T00:00:00Z")),
            },
          ],
        },
      ],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    });
    expect(ids(createdThisWeek.body)).toEqual(["90011006", "90011005"]);

    const either = await api("POST", "/crm/v3/objects/companies/search", {
      filterGroups: [
        { filters: [{ propertyName: "domain", operator: "EQ", value: "copperleaf.test" }] },
        { filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: "tide*" }] },
      ],
    });
    expect(ids(either.body)).toEqual(["30011002", "30011004"]);
  });

  it("validates search requests", async () => {
    const tooMany = await api("POST", "/crm/v3/objects/deals/search", {
      filterGroups: Array.from({ length: 6 }, () => ({
        filters: [{ propertyName: "dealname", operator: "HAS_PROPERTY" }],
      })),
    });
    expect(tooMany.status).toBe(400);
    const unknown = await api("POST", "/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "colour", operator: "EQ", value: "red" }] }],
    });
    expect(unknown.body).toMatchObject({ status: "error", category: "VALIDATION_ERROR" });
    const notJson = await fetch(`${hubspot.baseUrl}/crm/v3/objects/deals/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect(notJson.status).toBe(415);
  });

  it("batch-reads with 207 for missing ids and optional history", async () => {
    const reply = await api("POST", "/crm/v3/objects/deals/batch/read", {
      inputs: [{ id: "90011004" }, { id: "1" }],
      properties: ["dealname"],
      propertiesWithHistory: ["dealstage"],
    });
    expect(reply.status).toBe(207);
    expect(reply.body).toMatchObject({
      status: "COMPLETE",
      numErrors: 1,
      errors: [{ category: "OBJECT_NOT_FOUND", context: { ids: ["1"] } }],
    });
    expect((reply.body.results as JsonObject[])[0]).toMatchObject({
      id: "90011004",
      propertiesWithHistory: { dealstage: [{ value: "closedwon", sourceType: "CRM_UI" }] },
    });
  });

  it("lists v4 associations with labels and association definitions", async () => {
    const reply = await api(
      "GET",
      "/crm/v4/objects/deals/90011004/associations/contacts?limit=500",
    );
    expect(reply.body).toEqual({
      results: [
        {
          toObjectId: 51011007,
          associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 3, label: null }],
        },
      ],
    });
    const inverse = await api("GET", "/crm/v4/objects/companies/30011007/associations/deals");
    expect(inverse.body).toMatchObject({
      results: [{ toObjectId: 90011004, associationTypes: [{ typeId: 342 }] }],
    });
    const labels = await api("GET", "/crm/v4/associations/notes/contacts/labels");
    expect(labels.body).toEqual({
      results: [{ category: "HUBSPOT_DEFINED", typeId: 202, label: null }],
    });
  });

  it("serves property definitions", async () => {
    const list = await api("GET", "/crm/v3/properties/deals?archived=false&includeHidden=false");
    expect((list.body.results as JsonObject[]).map((property) => property.name)).toContain(
      "dealstage",
    );
    const owner = await api("GET", "/crm/v3/properties/tasks/hubspot_owner_id");
    expect(owner.body).toMatchObject({ name: "hubspot_owner_id", type: "enumeration" });
    expect((owner.body.options as JsonObject[]).map((option) => option.value)).toEqual([
      "71001",
      "71002",
      "71003",
    ]);
    expect((await api("GET", "/crm/v3/properties/deals/colour")).status).toBe(404);
  });
});

describe("HubSpot fake: writes", () => {
  it("creates a note with inline associations and their inverses", async () => {
    const reply = await api("POST", "/crm/v3/objects/notes/batch/create", {
      inputs: [
        {
          properties: {
            hs_note_body: "Refunded duplicate charge ch_KAhp_0922b ($490.00).",
            hs_timestamp: "2026-09-28T13:00:00Z",
            hubspot_owner_id: "71003",
          },
          associations: [
            {
              to: { id: "51011001" },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
            },
            {
              to: { id: "30011001" },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }],
            },
          ],
        },
      ],
    });
    expect(reply.status).toBe(201);
    const note = (reply.body.results as JsonObject[])[0] as JsonObject;
    expect(note).toMatchObject({
      id: "90011007",
      properties: {
        hs_note_body: "Refunded duplicate charge ch_KAhp_0922b ($490.00).",
        hs_timestamp: "2026-09-28T13:00:00.000Z",
      },
      createdAt: "2026-09-28T13:00:00.000Z",
    });
    expect(hubspot.crm.created("notes", hubspot.crm.firstCreatedId)).toEqual([
      expect.objectContaining({
        id: "90011007",
        associations: [
          { to: "contacts", toId: "51011001", typeId: 202 },
          { to: "companies", toId: "30011001", typeId: 190 },
        ],
      }),
    ]);
    const fromContact = await api("GET", "/crm/v4/objects/contacts/51011001/associations/notes");
    expect(fromContact.body).toMatchObject({
      results: [{ toObjectId: 90011007, associationTypes: [{ typeId: 201 }] }],
    });
    expect(hubspot.writes()).toHaveLength(1);
  });

  it("validates properties and associations, and a failed batch creates nothing", async () => {
    const invalid = await api("POST", "/crm/v3/objects/tasks/batch/create", {
      inputs: [
        {
          properties: {
            hs_task_subject: "Call Theo",
            hs_task_status: "OPEN",
            colour: "red",
            hs_object_id: "5",
          },
        },
      ],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.category).toBe("VALIDATION_ERROR");
    const message = String(invalid.body.message);
    for (const code of [
      "INVALID_OPTION",
      "PROPERTY_DOESNT_EXIST",
      "READ_ONLY_VALUE",
      "REQUIRED_PROPERTY",
    ]) {
      expect(message).toContain(code);
    }
    const badAssociation = await api("POST", "/crm/v3/objects/notes/batch/create", {
      inputs: [
        {
          properties: { hs_note_body: "x", hs_timestamp: "2026-09-28T13:00:00Z" },
          associations: [
            {
              to: { id: "99" },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
            },
          ],
        },
      ],
    });
    expect(badAssociation.status).toBe(400);
    const wrongType = await api("POST", "/crm/v3/objects/notes/batch/create", {
      inputs: [
        {
          properties: { hs_note_body: "x", hs_timestamp: "2026-09-28T13:00:00Z" },
          associations: [
            {
              to: { id: "51011001" },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 279 }],
            },
          ],
        },
      ],
    });
    expect(wrongType.status).toBe(400);
    expect(hubspot.crm.created("notes", hubspot.crm.firstCreatedId)).toEqual([]);
    expect(hubspot.crm.created("tasks", hubspot.crm.firstCreatedId)).toEqual([]);
  });

  it("creates a task with an epoch-millisecond due date", async () => {
    const reply = await api("POST", "/crm/v3/objects/tasks/batch/create", {
      inputs: [
        {
          properties: {
            hs_task_subject: "Call Copperleaf about invoice 1043",
            hs_task_status: "NOT_STARTED",
            hs_task_priority: "HIGH",
            hs_task_type: "CALL",
            hs_timestamp: String(Date.parse("2026-09-30T14:00:00Z")),
          },
          associations: [
            {
              to: { id: "30011002" },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 192 }],
            },
          ],
        },
      ],
    });
    expect(reply.status).toBe(201);
    expect((reply.body.results as JsonObject[])[0]?.properties).toMatchObject({
      hs_timestamp: "2026-09-30T14:00:00.000Z",
    });
  });

  it("batch-updates, recording history, with 207 for unknown ids", async () => {
    const reply = await api("POST", "/crm/v3/objects/deals/batch/update", {
      inputs: [
        { id: "90011006", properties: { dealstage: "presentationscheduled" } },
        { id: "5", properties: { dealstage: "closedwon" } },
      ],
    });
    expect(reply.status).toBe(207);
    expect((reply.body.results as JsonObject[])[0]?.properties).toMatchObject({
      dealstage: "presentationscheduled",
    });
    const history = await api("POST", "/crm/v3/objects/deals/batch/read", {
      inputs: [{ id: "90011006" }],
      propertiesWithHistory: ["dealstage"],
    });
    expect(history.body.results).toMatchObject([
      {
        propertiesWithHistory: {
          dealstage: [{ value: "presentationscheduled" }, { value: "qualifiedtobuy" }],
        },
      },
    ]);
  });

  it("injects 429 and 500 envelopes", async () => {
    hubspot.faults.rateLimit("/crm/v3/objects/contacts/search");
    const limited = await api("POST", "/crm/v3/objects/contacts/search", { query: "dana" });
    expect(limited).toMatchObject({
      status: 429,
      body: { errorType: "RATE_LIMIT", policyName: "SECONDLY" },
    });
    hubspot.faults.serverError(/\/batch\/create$/);
    const failed = await api("POST", "/crm/v3/objects/notes/batch/create", {
      inputs: [{ properties: { hs_note_body: "x", hs_timestamp: "2026-09-28T13:00:00Z" } }],
    });
    expect(failed.status).toBe(500);
    expect(hubspot.crm.created("notes", hubspot.crm.firstCreatedId)).toEqual([]);
  });
});
