import { describe, expect, it } from "vitest";
import { createRedactorFor } from "../../../src/config/redact.js";
import { REDACTED } from "../../../src/config/secret.js";
import type { JsonValue } from "../../../src/contracts/json.js";
import {
  compactJson,
  compactToolResult,
  DEFAULT_MAX_OUTPUT_CHARS,
} from "../../../src/gateway/compact.js";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

describe("compactToolResult", () => {
  it("passes small JSON through unchanged, as one text block", () => {
    const body = JSON.stringify({ data: [{ id: "ch_1", amount: 4900 }], has_more: false });
    const compacted = compactToolResult(text(body));
    expect(compacted).toEqual({
      result: { content: [{ type: "text", text: body }] },
      output: { data: [{ id: "ch_1", amount: 4900 }], has_more: false },
      text: body,
      truncated: false,
    });
  });

  it("keeps the error flag and plain text", () => {
    const compacted = compactToolResult({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
    expect(compacted.result).toEqual({ isError: true, content: [{ type: "text", text: "boom" }] });
    expect(compacted.output).toBe("boom");
  });

  it(`keeps a large JSON result valid and under ${DEFAULT_MAX_OUTPUT_CHARS} characters, marked truncated`, () => {
    const invoices = Array.from({ length: 400 }, (_, index) => ({
      id: `in_${index}`,
      memo: "x".repeat(200),
      lines: [{ description: "Seat licence", amount: 1200 }],
    }));
    const compacted = compactToolResult(text(JSON.stringify({ data: invoices, has_more: true })));
    expect(compacted.truncated).toBe(true);
    expect(compacted.text.length).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_CHARS);
    const parsed = JSON.parse(compacted.text) as {
      data: unknown[];
      truncated: boolean;
      has_more: boolean;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.has_more).toBe(true);
    expect(parsed.data.at(-1)).toMatch(/^… \d+ more items$/);
    expect(compacted.output).toEqual(parsed);
  });

  it("wraps a truncated top-level array", () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => ({ id: index, name: `row ${index}` }));
    const compacted = compactToolResult(text(JSON.stringify(rows)), { maxChars: 2_000 });
    const parsed = JSON.parse(compacted.text) as { truncated: boolean; value: unknown[] };
    expect(parsed.truncated).toBe(true);
    expect(Array.isArray(parsed.value)).toBe(true);
    expect(compacted.text.length).toBeLessThanOrEqual(2_000);
  });

  it("cuts long plain text with a note", () => {
    const compacted = compactToolResult(text("a".repeat(50)), { maxChars: 10 });
    expect(compacted.text).toBe(`${"a".repeat(10)}\n[truncated: 40 more characters]`);
    expect(compacted.truncated).toBe(true);
  });

  it("redacts before the model or the observer sees anything", () => {
    const redact = createRedactorFor(["upstream-secret-token"]);
    const compacted = compactToolResult(
      text(JSON.stringify({ echo: "Authorization: Bearer upstream-secret-token" })),
      { redact },
    );
    expect(compacted.text).not.toContain("upstream-secret-token");
    expect(compacted.output).toEqual({ echo: `Authorization: Bearer ${REDACTED}` });
  });

  it("replaces non-text blocks and falls back to structured content", () => {
    const withImage = compactToolResult({
      content: [
        { type: "text", text: "chart:" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
    expect(withImage.text).toBe("chart:\n[image content omitted]");
    const structured = compactToolResult({ content: [], structuredContent: { ok: true } });
    expect(structured.output).toEqual({ ok: true });
  });
});

describe("compactJson", () => {
  it("falls back to a preview when nothing else fits", () => {
    let deep: JsonValue = "leaf";
    for (let level = 0; level < 3; level += 1) deep = { [`k${"z".repeat(300)}${level}`]: deep };
    const compacted = compactJson(deep, 200);
    expect(compacted.truncated).toBe(true);
    expect(JSON.stringify(compacted.value).length).toBeLessThanOrEqual(200);
    expect(compacted.value).toMatchObject({ truncated: true });
  });

  it("shortens long strings inside objects", () => {
    const compacted = compactJson({ body: "b".repeat(10_000) }, 5_000);
    expect(compacted.truncated).toBe(true);
    expect((compacted.value as { body: string }).body).toMatch(/more characters]$/);
  });
});
