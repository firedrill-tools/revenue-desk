// Safe readers for untyped JSON (tool inputs and provider responses), so
// classifiers and projections never cast.

import type { JsonObject, JsonValue } from "../../contracts/json.js";

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

export function asArray(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function field(object: JsonObject | undefined, key: string): JsonValue | undefined {
  if (object === undefined || !Object.hasOwn(object, key)) return undefined;
  return object[key];
}

/** A non-empty string (after trimming), or undefined. */
export function str(object: JsonObject | undefined, key: string): string | undefined {
  const value = field(object, key);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function num(object: JsonObject | undefined, key: string): number | undefined {
  const value = field(object, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function bool(object: JsonObject | undefined, key: string): boolean | undefined {
  const value = field(object, key);
  return typeof value === "boolean" ? value : undefined;
}

export function obj(object: JsonObject | undefined, key: string): JsonObject | undefined {
  return asObject(field(object, key));
}

export function arr(object: JsonObject | undefined, key: string): readonly JsonValue[] | undefined {
  return asArray(field(object, key));
}

/** The string items of an array field; undefined when the field is absent or holds a non-string. */
export function strings(
  object: JsonObject | undefined,
  key: string,
): readonly string[] | undefined {
  const items = arr(object, key);
  if (items === undefined) return undefined;
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

/** The object items of an array field, skipping anything else. */
export function objects(object: JsonObject | undefined, key: string): readonly JsonObject[] {
  return (arr(object, key) ?? []).filter(isObject);
}

/** Keeps only the listed keys that are present, in the listed order. */
export function pick(object: JsonObject | undefined, keys: readonly string[]): JsonObject {
  const out: Record<string, JsonValue> = {};
  if (object === undefined) return out;
  for (const key of keys) {
    const value = field(object, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Drops keys whose value is undefined, so optional facts never become `null` by accident. */
export function compact(entries: Readonly<Record<string, JsonValue | undefined>>): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out;
}
