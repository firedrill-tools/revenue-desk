import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const surfaces = resolve(import.meta.dirname, "../fixtures/surfaces");
const load = (file: string): unknown => JSON.parse(readFileSync(join(surfaces, file), "utf8"));

interface ToolEntry {
  name: string;
  inputSchema: { type?: string };
  annotations?: { readOnlyHint?: boolean };
}

/**
 * The tools of the hubspot-mcp-0.4 profile (docs/ARCHITECTURE.md §2): CRM
 * reads plus creating and updating records. Notes and tasks are created with
 * their associations inline in hubspot-batch-create-objects. The other 11
 * tools (property and engagement administration, association batches,
 * workflows, links, feedback) are not offered. W2's profile must stay equal
 * to this list.
 */
const HUBSPOT_PROFILE_TOOLS = [
  "hubspot-get-user-details",
  "hubspot-list-objects",
  "hubspot-search-objects",
  "hubspot-batch-read-objects",
  "hubspot-list-associations",
  "hubspot-get-association-definitions",
  "hubspot-list-properties",
  "hubspot-get-property",
  "hubspot-batch-create-objects",
  "hubspot-batch-update-objects",
];
const HUBSPOT_PROFILE_WRITES = ["hubspot-batch-create-objects", "hubspot-batch-update-objects"];

describe("hubspot-mcp-0.4.0.json", () => {
  const fixture = load("hubspot-mcp-0.4.0.json") as {
    capturedAt: string;
    source: { package: string; version: string; integrity: string };
    tools: ToolEntry[];
  };

  it("is a dated capture of the pinned package", () => {
    expect(Number.isNaN(Date.parse(fixture.capturedAt))).toBe(false);
    expect(fixture.source).toMatchObject({ package: "@hubspot/mcp-server", version: "0.4.0" });
    expect(fixture.source.integrity).toMatch(/^sha512-/);
  });

  it("holds 21 uniquely named tools with object input schemas", () => {
    const names = fixture.tools.map((tool) => tool.name);
    expect(names).toHaveLength(21);
    expect(new Set(names).size).toBe(21);
    for (const tool of fixture.tools) expect(tool.inputSchema.type).toBe("object");
  });

  it("contains every tool of Revenue Desk's HubSpot profile, reads annotated read-only", () => {
    const byName = new Map(fixture.tools.map((tool) => [tool.name, tool]));
    for (const name of HUBSPOT_PROFILE_TOOLS) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(!HUBSPOT_PROFILE_WRITES.includes(name));
    }
  });
});
