// Zod building blocks for API tool inputs. Only plain types, formats, ranges
// and descriptions: shapes must convert to JSON schema for the model, and the
// gateway validates calls against that schema before any approval.

import { z } from "zod";

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** A calendar date, YYYY-MM-DD. */
export const isoDate = (description: string) => z.iso.date().describe(description);

/** A date (YYYY-MM-DD, read as 00:00 UTC) or a date-time with a zone (…Z or …+02:00). */
export const isoTimestamp = (description: string) =>
  z
    .string()
    .regex(ISO_TIMESTAMP, "Use YYYY-MM-DD or an ISO 8601 date-time with a zone")
    .describe(description);

/** Unix seconds of an isoTimestamp value. */
export function unixSeconds(value: string): number {
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) throw new RangeError(`not a timestamp: ${value}`);
  return Math.floor(ms / 1000);
}

/** A page size with a default. */
export const pageSize = (max: number, fallback: number, noun: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(fallback)
    .describe(`How many ${noun} to return (1-${max}, default ${fallback}).`);

/** An identifier with a known shape, e.g. /^cus_[A-Za-z0-9]+$/. */
export const identifier = (pattern: RegExp, description: string) =>
  z.string().regex(pattern, `Expected an id like ${pattern.source}`).describe(description);

/** Free-form key/value pairs stored on a record. */
export const metadataField = (description: string) =>
  z.record(z.string().max(40), z.string().max(500)).describe(description);
