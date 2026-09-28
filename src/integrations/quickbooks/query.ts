// A small builder for QuickBooks Online query statements
// ("SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate STARTPOSITION 1
// MAXRESULTS 100"). Field names come from code, never from the model; values
// are always quoted and escaped, so tool input cannot change the statement.

export const QUERY_ENTITIES = ["Customer", "Invoice", "Payment"] as const;
export type QueryEntity = (typeof QUERY_ENTITIES)[number];

/** QuickBooks caps MAXRESULTS at 1000. */
export const MAX_PAGE_SIZE = 1000;

export type Comparison = "=" | "<" | ">" | "<=" | ">=";

export type Condition =
  | { readonly field: string; readonly op: Comparison; readonly value: string | number | boolean }
  | { readonly field: string; readonly op: "LIKE"; readonly pattern: string }
  | { readonly field: string; readonly op: "IN"; readonly values: readonly string[] };

export type SelectQuery = {
  readonly entity: QueryEntity;
  readonly where?: readonly Condition[];
  readonly orderBy?: { readonly field: string; readonly direction: "ASC" | "DESC" };
};

const FIELD = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;

function assertField(field: string): string {
  if (!FIELD.test(field)) throw new Error(`invalid QuickBooks query field: ${field}`);
  return field;
}

/** A quoted literal: backslashes and single quotes are escaped with a backslash. */
export function quote(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("QuickBooks query numbers must be finite");
  }
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Text for a LIKE pattern: QuickBooks only knows the % wildcard, so a literal % is dropped. */
export function containsPattern(text: string): string {
  return `%${text.replace(/%/g, "")}%`;
}

function condition(entry: Condition): string {
  const field = assertField(entry.field);
  switch (entry.op) {
    case "LIKE":
      return `${field} LIKE ${quote(entry.pattern)}`;
    case "IN":
      if (entry.values.length === 0) throw new Error(`IN on ${field} needs at least one value`);
      return `${field} IN (${entry.values.map(quote).join(", ")})`;
    default:
      return `${field} ${entry.op} ${quote(entry.value)}`;
  }
}

/** One page of a query. `startPosition` is 1-based. */
export function selectStatement(
  query: SelectQuery,
  page: { readonly startPosition: number; readonly maxResults: number },
): string {
  if (!Number.isInteger(page.startPosition) || page.startPosition < 1) {
    throw new Error("STARTPOSITION must be a positive integer");
  }
  if (
    !Number.isInteger(page.maxResults) ||
    page.maxResults < 1 ||
    page.maxResults > MAX_PAGE_SIZE
  ) {
    throw new Error(`MAXRESULTS must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const parts = [`SELECT * FROM ${query.entity}`];
  const where = query.where ?? [];
  if (where.length > 0) parts.push(`WHERE ${where.map(condition).join(" AND ")}`);
  if (query.orderBy !== undefined) {
    parts.push(`ORDERBY ${assertField(query.orderBy.field)} ${query.orderBy.direction}`);
  }
  parts.push(`STARTPOSITION ${page.startPosition} MAXRESULTS ${page.maxResults}`);
  return parts.join(" ");
}
