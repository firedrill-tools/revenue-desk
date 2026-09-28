import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const surfaces = resolve(import.meta.dirname, "../fixtures/surfaces");
const load = (file: string): unknown => JSON.parse(readFileSync(join(surfaces, file), "utf8"));

interface ToolEntry {
  name: string;
  inputSchema: { type?: string };
}

describe("hubspot-mcp-0.4.0.json", () => {
  const fixture = load("hubspot-mcp-0.4.0.json") as {
    capturedAt: string;
    source: { package: string; version: string; integrity: string };
    tools: ToolEntry[];
    firedrillAliasComparison: {
      aliases: string[];
      aliasesNotInServer: string[];
      matched: { name: string }[];
    };
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

  it("contains every Firedrill HubSpot alias", () => {
    const names = new Set(fixture.tools.map((tool) => tool.name));
    const { aliases, aliasesNotInServer, matched } = fixture.firedrillAliasComparison;
    expect(aliases).toHaveLength(11);
    expect(aliasesNotInServer).toEqual([]);
    expect(matched.map((entry) => entry.name)).toEqual(aliases);
    for (const alias of aliases) expect(names.has(alias)).toBe(true);
  });
});

describe("google-mcp.json", () => {
  const fixture = load("google-mcp.json") as {
    capturedAt: string;
    source: { commit: string };
    toolsets: {
      key: string;
      packageId: string;
      aliases: (ToolEntry & { canonicalName: string })[];
      canonicalOnly: ToolEntry[];
    }[];
  };

  it("is dated and pinned to a firedrill-tools commit", () => {
    expect(Number.isNaN(Date.parse(fixture.capturedAt))).toBe(false);
    expect(fixture.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists the Gmail and Calendar aliases with unique names across both Tools", () => {
    const byKey = new Map(fixture.toolsets.map((toolset) => [toolset.key, toolset]));
    expect(byKey.get("gmail")?.aliases).toHaveLength(12);
    expect(byKey.get("google-calendar")?.aliases).toHaveLength(9);
    const names = fixture.toolsets.flatMap((toolset) => [
      ...toolset.aliases.flatMap((alias) => [alias.name, alias.canonicalName]),
      ...toolset.canonicalOnly.map((tool) => tool.name),
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const toolset of fixture.toolsets) {
      for (const tool of [...toolset.aliases, ...toolset.canonicalOnly]) {
        expect(tool.inputSchema.type).toBe("object");
      }
    }
  });

  it("offers sending only under canonical Gmail names", () => {
    const gmail = fixture.toolsets.find((toolset) => toolset.key === "gmail");
    const canonical = gmail?.canonicalOnly.map((tool) => tool.name) ?? [];
    expect(canonical).toEqual(expect.arrayContaining(["gmail.messages.send", "gmail.drafts.send"]));
    expect(gmail?.aliases.some((alias) => /send/.test(alias.name))).toBe(false);
  });
});
