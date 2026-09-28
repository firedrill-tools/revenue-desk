import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileArgumentValidator,
  invalidArgumentsMessage,
  SchemaCompileError,
} from "../../../src/gateway/validate.js";
import { CRM_TOOLS, MAIL_TOOLS } from "../../support/upstream-mcp.js";

type CapturedTool = { readonly name: string; readonly inputSchema: unknown };

function capturedTools(): CapturedTool[] {
  const root = resolve(import.meta.dirname, "../../fixtures/surfaces");
  const hubspot = JSON.parse(readFileSync(`${root}/hubspot-mcp-0.4.0.json`, "utf8")) as {
    tools: CapturedTool[];
  };
  const composio: unknown = JSON.parse(readFileSync(`${root}/composio-direct.json`, "utf8"));
  const found: CapturedTool[] = [...hubspot.tools];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.name === "string" && record.inputSchema !== undefined) {
        found.push(record as CapturedTool);
      }
      Object.values(record).forEach(walk);
    }
  };
  walk(composio);
  return found;
}

describe("compileArgumentValidator", () => {
  it("compiles every captured HubSpot 0.4.0 and Composio schema", () => {
    const tools = capturedTools();
    expect(tools.length).toBeGreaterThanOrEqual(21 + 13);
    for (const tool of tools) {
      expect(() => compileArgumentValidator(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it("checks types, ranges, required and undeclared properties of an upstream schema", () => {
    const schema = MAIL_TOOLS[0]?.tool.inputSchema;
    const validate = compileArgumentValidator(schema);
    expect(validate({ query: "from:ana@acme.test", max_results: 5 })).toEqual([]);
    expect(validate({ max_results: 500, surprise: 1 })).toEqual(
      expect.arrayContaining([
        { path: "", message: 'is missing the required property "query"' },
        { path: "/max_results", message: "must be <= 50" },
        { path: "", message: 'has an unexpected property "surprise"' },
      ]),
    );
  });

  it("follows $defs references and formats", () => {
    const note = compileArgumentValidator(CRM_TOOLS[1]?.tool.inputSchema);
    expect(
      note({ contact_id: "101", body: "ok", associations: [{ object_type: "deal", id: "555" }] }),
    ).toEqual([]);
    expect(
      note({ contact_id: "101", body: "ok", associations: [{ object_type: "lead", id: "x" }] }),
    ).toEqual(
      expect.arrayContaining([
        {
          path: "/associations/0/object_type",
          message: 'must be one of "contact", "company", "deal"',
        },
        { path: "/associations/0/id", message: 'must match pattern "^[0-9]+$"' },
      ]),
    );
    const draft = compileArgumentValidator(MAIL_TOOLS[1]?.tool.inputSchema);
    expect(draft({ recipient_email: "not-an-email", subject: "s", body: "b" })).toEqual([
      { path: "/recipient_email", message: 'must match format "email"' },
    ]);
  });

  it("picks the dialect from $schema (draft-07, 2019-09 and 2020-12)", () => {
    const tuple2020 = compileArgumentValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] },
      },
    });
    expect(tuple2020({ pair: ["a", 1] })).toEqual([]);
    expect(tuple2020({ pair: ["a", "b"] })).toHaveLength(1);
    const draft2019 = compileArgumentValidator({
      $schema: "https://json-schema.org/draft/2019-09/schema",
      type: "object",
      properties: { a: { type: "integer" } },
      unevaluatedProperties: false,
    });
    expect(draft2019({ a: 1, b: 2 })).toHaveLength(1);
    const draft07 = compileArgumentValidator({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.test/tool",
      type: "object",
      properties: { a: { type: "integer" } },
    });
    expect(draft07({ a: 1.5 })).toEqual([{ path: "/a", message: "must be integer" }]);
    // The same $id again must not collide.
    expect(() =>
      compileArgumentValidator({
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "https://example.test/tool",
        type: "object",
      }),
    ).not.toThrow();
  });

  it("rejects non-object inputs and ignores unknown keywords", () => {
    const validate = compileArgumentValidator({
      type: "object",
      "x-composio-hint": true,
      properties: { a: { type: "string", file_uploadable: false } },
    });
    expect(validate("nope")).toHaveLength(1);
    expect(validate({ a: "ok" })).toEqual([]);
  });

  it("refuses a schema it cannot use", () => {
    expect(() => compileArgumentValidator(null)).toThrow(SchemaCompileError);
    expect(() => compileArgumentValidator([])).toThrow(SchemaCompileError);
    expect(() =>
      compileArgumentValidator({ type: "object", properties: { a: { $ref: "#/nowhere" } } }),
    ).toThrow(SchemaCompileError);
  });
});

describe("invalidArgumentsMessage", () => {
  it("is compact, names the fields, and says nothing was run", () => {
    const message = invalidArgumentsMessage("Refund charge in Stripe", [
      { path: "/amount", message: "must be integer" },
      { path: "", message: 'is missing the required property "charge"' },
      { path: "/amount", message: "must be integer" },
    ]);
    expect(message).toBe(
      'Invalid arguments for "Refund charge in Stripe": `amount` must be integer; The call is missing the required property "charge". Nothing was run. Fix the arguments to match the tool\'s schema and call it again.',
    );
  });

  it("lists at most five problems", () => {
    const issues = Array.from({ length: 8 }, (_, index) => ({
      path: `/f${index}`,
      message: "must be string",
    }));
    expect(invalidArgumentsMessage("T", issues)).toContain("; and 3 more.");
  });
});
