/**
 * The subset of Stripe's Search Query Language the fake serves for
 * `GET /v1/customers/search` (https://docs.stripe.com/search#search-query-language):
 * clauses `field:"value"` (exact) or `field~"value"` (substring, at least 3
 * characters), joined by all `AND` or all `OR`; string fields `name`,
 * `email`, `phone` and `metadata["key"]`. Matching ignores case. Anything
 * else is a 400 on `query`, as Stripe answers a query it cannot parse.
 */
import { invalid } from "./errors.js";

export interface SearchClause {
  readonly field: string;
  readonly operator: ":" | "~";
  readonly value: string;
}

export interface SearchQuery {
  readonly join: "AND" | "OR";
  readonly clauses: readonly SearchClause[];
}

const CLAUSE = /^(name|email|phone|metadata\["[^"\\]+"\])([:~])"((?:[^"\\]|\\.)*)"$/;

function invalidQuery(message: string) {
  return invalid(`Invalid search query: ${message}`, { param: "query", saved: false });
}

/** Splits on AND/OR outside quoted values. */
function tokens(query: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index] as string;
    if (character === "\\" && quoted) {
      current += character + (query[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === " ") {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted) throw invalidQuery("unterminated string");
  if (current !== "") out.push(current);
  return out;
}

export function parseSearchQuery(query: string): SearchQuery {
  const parts = tokens(query.trim());
  if (parts.length === 0) throw invalidQuery("the query is empty");
  const clauses: SearchClause[] = [];
  const joins = new Set<string>();
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      if (part !== "AND" && part !== "OR") throw invalidQuery(`expected AND or OR, got ${part}`);
      joins.add(part);
      return;
    }
    const match = CLAUSE.exec(part);
    if (match === null) throw invalidQuery(`cannot parse ${part}`);
    const [, field, operator, raw] = match as unknown as [string, string, ":" | "~", string];
    const value = raw.replace(/\\(.)/g, "$1");
    if (operator === "~" && value.length < 3) {
      throw invalidQuery(`a substring search needs at least 3 characters (${field})`);
    }
    if (operator === "~" && field.startsWith("metadata")) {
      throw invalidQuery("metadata fields support exact matches only");
    }
    clauses.push({ field, operator, value });
  });
  if (parts.length % 2 === 0) throw invalidQuery("the query ends with a conjunction");
  if (joins.size > 1) throw invalidQuery("AND and OR cannot be combined");
  return { join: joins.has("OR") ? "OR" : "AND", clauses };
}

/** Whether a record's string fields satisfy the query. */
export function matchesSearch(
  query: SearchQuery,
  fieldOf: (field: string) => string | null | undefined,
): boolean {
  const test = (clause: SearchClause) => {
    const actual = fieldOf(clause.field)?.toLowerCase();
    if (actual === undefined || actual === null) return false;
    const wanted = clause.value.toLowerCase();
    return clause.operator === ":" ? actual === wanted : actual.includes(wanted);
  };
  return query.join === "AND" ? query.clauses.every(test) : query.clauses.some(test);
}
