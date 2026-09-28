// The server's view of the redactor (docs/ARCHITECTURE.md §0 "Secrets").
//
// The redactor itself is built from the configuration snapshot
// (src/config/redact.ts, W1) and injected; the server applies it to
// everything it stores, streams or logs that came from a tool or an error.

import type { JsonObject, JsonValue } from "../contracts/json.js";

/** Scrubs configured secrets and token shapes from text. Must be idempotent. */
export type Redact = (text: string) => string;

/** A copy of `value` with every string, keys included, redacted. */
export function redactJson(value: JsonValue, redact: Redact): JsonValue {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item: JsonValue) => redactJson(item, redact));
  const out: { [key: string]: JsonValue } = {};
  for (const [key, child] of Object.entries(value as JsonObject)) {
    out[redact(key)] = redactJson(child, redact);
  }
  return out;
}

export function redactJsonObject(value: JsonObject, redact: Redact): JsonObject {
  return redactJson(value, redact) as JsonObject;
}

/** A short, redacted message for an unknown thrown value. */
export function describeError(error: unknown, redact: Redact, maxLength = 500): string {
  const text = error instanceof Error ? error.message : String(error);
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}
