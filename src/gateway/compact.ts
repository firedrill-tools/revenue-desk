// Output compaction (docs/ARCHITECTURE.md §5): each tool result reaches the
// model as one text block of at most about 20k characters, redacted. JSON
// stays valid JSON: long strings are shortened and long arrays cut, step by
// step, until it fits, and the result says `truncated: true`. Other text is
// cut with a note. Non-text blocks (images, resources) are replaced by a
// short note; Revenue Desk's tools all answer with JSON or text.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject, JsonValue } from "../contracts/json.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

export type CompactOptions = {
  readonly maxChars?: number;
  readonly redact?: (text: string) => string;
};

export type CompactedResult = {
  /** What the model receives. */
  readonly result: CallToolResult;
  /** The same content as JSON when it parses, otherwise the text. */
  readonly output: JsonValue;
  readonly text: string;
  readonly truncated: boolean;
};

/** Steps of shortening: [longest string, longest array, deepest object]. */
const SHRINK_STEPS: readonly (readonly [number, number, number])[] = [
  [4_000, 100, 12],
  [1_000, 40, 10],
  [400, 20, 8],
  [160, 10, 6],
  [80, 5, 5],
  [40, 3, 4],
];

function resultText(result: CallToolResult): string {
  const pieces: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") pieces.push(block.text);
    else pieces.push(`[${block.type} content omitted]`);
  }
  if (pieces.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return pieces.join("\n");
}

function parseJson(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
}

function shrink(
  value: JsonValue,
  step: readonly [number, number, number],
  depth: number,
): JsonValue {
  const [maxString, maxItems, maxDepth] = step;
  if (typeof value === "string") {
    return value.length <= maxString
      ? value
      : `${value.slice(0, maxString)}… [${value.length - maxString} more characters]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const items: JsonValue[] = value
      .slice(0, maxItems)
      .map((item) => shrink(item, step, depth + 1));
    if (value.length > maxItems) items.push(`… ${value.length - maxItems} more items`);
    return items;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as JsonObject)) {
    out[key] = shrink(child, step, depth + 1);
  }
  return out;
}

function markTruncated(value: JsonValue): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as JsonObject), truncated: true };
  }
  return { truncated: true, value };
}

/** A JSON value that serialises within `maxChars`, and whether it had to be shortened. */
export function compactJson(
  value: JsonValue,
  maxChars: number,
): { readonly value: JsonValue; readonly truncated: boolean } {
  if (JSON.stringify(value).length <= maxChars) return { value, truncated: false };
  for (const step of SHRINK_STEPS) {
    const candidate = markTruncated(shrink(value, step, 0));
    if (JSON.stringify(candidate).length <= maxChars) return { value: candidate, truncated: true };
  }
  const preview = JSON.stringify(value).slice(0, Math.max(0, maxChars - 64));
  return { value: { truncated: true, preview }, truncated: true };
}

function compactText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const note = `\n[truncated: ${text.length - maxChars} more characters]`;
  return { text: text.slice(0, maxChars) + note, truncated: true };
}

/** The result the model receives: one redacted text block within the size limit. */
export function compactToolResult(
  result: CallToolResult,
  options: CompactOptions = {},
): CompactedResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const redact = options.redact ?? ((text: string) => text);
  const raw = redact(resultText(result));
  const parsed = parseJson(raw);
  let text: string;
  let output: JsonValue;
  let truncated: boolean;
  if (parsed !== undefined) {
    const compacted = compactJson(parsed, maxChars);
    output = compacted.value;
    truncated = compacted.truncated;
    text = truncated ? JSON.stringify(output) : raw;
  } else {
    const compacted = compactText(raw, maxChars);
    text = compacted.text;
    output = text;
    truncated = compacted.truncated;
  }
  return {
    result: {
      content: [{ type: "text", text }],
      ...(result.isError === true ? { isError: true } : {}),
    },
    output,
    text,
    truncated,
  };
}
