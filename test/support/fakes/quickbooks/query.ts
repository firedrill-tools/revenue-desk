/**
 * The QuickBooks Online query language, as far as Revenue Desk needs it:
 *
 *   SELECT * | COUNT(*) | Field[, Field] FROM Entity
 *     [WHERE Field op Value [AND Field op Value]...]
 *     [ORDERBY Field [ASC|DESC][, ...]]
 *     [STARTPOSITION n] [MAXRESULTS n]
 *
 * Operators: = < > <= >= LIKE ('%' wildcards) and IN ('a', 'b'). There is
 * no OR, as in QuickBooks. Keywords, entity and field names are case
 * insensitive; string values are single-quoted with \' escapes.
 */

export type QueryValue = string | number | boolean;
export type QueryOperator = "=" | "<" | ">" | "<=" | ">=" | "LIKE" | "IN";

export interface QueryCondition {
  readonly field: string;
  readonly operator: QueryOperator;
  readonly values: readonly QueryValue[];
}

export interface ParsedQuery {
  readonly entity: string;
  /** "*" for all fields, "count" for COUNT(*), else the selected fields. */
  readonly select: "*" | "count" | readonly string[];
  readonly where: readonly QueryCondition[];
  readonly orderBy: readonly { readonly field: string; readonly descending: boolean }[];
  /** 1-based. */
  readonly startPosition: number;
  readonly maxResults: number;
}

export class QueryError extends Error {
  constructor(
    /** "4000" for a parse error, "4001" for an invalid (well-formed) query. */
    readonly code: "4000" | "4001",
    message: string,
  ) {
    super(message);
  }
}

type Token =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "symbol"; readonly value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "'") {
      let value = "";
      index += 1;
      let closed = false;
      while (index < text.length) {
        const current = text[index] as string;
        if (current === "\\" && text[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (current === "'") {
          closed = true;
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      if (!closed)
        throw new QueryError("4000", `QueryParserError: Encountered unterminated string`);
      tokens.push({ kind: "string", value });
    } else if (/[0-9-]/.test(char) && /[0-9]/.test(text[index + (char === "-" ? 1 : 0)] ?? "")) {
      const match = /^-?\d+(\.\d+)?/.exec(text.slice(index));
      const raw = match?.[0] ?? char;
      tokens.push({ kind: "number", value: Number(raw) });
      index += raw.length;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(index));
      const raw = match?.[0] ?? char;
      tokens.push({ kind: "word", value: raw });
      index += raw.length;
    } else if (char === "<" || char === ">") {
      if (text[index + 1] === "=") {
        tokens.push({ kind: "symbol", value: `${char}=` });
        index += 2;
      } else {
        tokens.push({ kind: "symbol", value: char });
        index += 1;
      }
    } else if ("*(),=".includes(char)) {
      tokens.push({ kind: "symbol", value: char });
      index += 1;
    } else {
      throw new QueryError(
        "4000",
        `QueryParserError: Encountered " ${char} " at column ${index + 1}`,
      );
    }
  }
  return tokens;
}

class Cursor {
  private index = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.index];
  }

  next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new QueryError("4000", "QueryParserError: Encountered <EOF>");
    this.index += 1;
    return token;
  }

  keyword(value: string): boolean {
    const token = this.peek();
    if (token?.kind === "word" && token.value.toUpperCase() === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  expectKeyword(value: string): void {
    if (!this.keyword(value)) {
      throw new QueryError(
        "4000",
        `QueryParserError: Encountered ${describe(this.peek())}, expected ${value}`,
      );
    }
  }

  symbol(value: string): boolean {
    const token = this.peek();
    if (token?.kind === "symbol" && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  expectSymbol(value: string): void {
    if (!this.symbol(value)) {
      throw new QueryError(
        "4000",
        `QueryParserError: Encountered ${describe(this.peek())}, expected "${value}"`,
      );
    }
  }

  word(): string {
    const token = this.next();
    if (token.kind !== "word") {
      throw new QueryError(
        "4000",
        `QueryParserError: Encountered ${describe(token)}, expected a name`,
      );
    }
    return token.value;
  }

  integer(): number {
    const token = this.next();
    if (token.kind !== "number" || !Number.isInteger(token.value) || token.value < 1) {
      throw new QueryError(
        "4000",
        `QueryParserError: Encountered ${describe(token)}, expected a positive integer`,
      );
    }
    return token.value;
  }

  done(): boolean {
    return this.index >= this.tokens.length;
  }
}

function describe(token: Token | undefined): string {
  if (token === undefined) return "<EOF>";
  return token.kind === "string" ? `'${token.value}'` : `" ${String(token.value)} "`;
}

const RESERVED = new Set(["WHERE", "ORDERBY", "STARTPOSITION", "MAXRESULTS", "AND", "FROM"]);

export function parseQuery(text: string): ParsedQuery {
  const cursor = new Cursor(tokenize(text));
  cursor.expectKeyword("SELECT");
  let select: ParsedQuery["select"];
  if (cursor.symbol("*")) {
    select = "*";
  } else if (cursor.keyword("COUNT")) {
    cursor.expectSymbol("(");
    cursor.expectSymbol("*");
    cursor.expectSymbol(")");
    select = "count";
  } else {
    const fields = [cursor.word()];
    while (cursor.symbol(",")) fields.push(cursor.word());
    select = fields;
  }
  cursor.expectKeyword("FROM");
  const entity = cursor.word();

  const where: QueryCondition[] = [];
  if (cursor.keyword("WHERE")) {
    do {
      where.push(condition(cursor));
    } while (cursor.keyword("AND"));
    if (cursor.keyword("OR")) {
      throw new QueryError("4000", 'QueryParserError: Encountered " OR "; OR is not supported');
    }
  }
  const orderBy: { field: string; descending: boolean }[] = [];
  if (cursor.keyword("ORDERBY")) {
    do {
      const field = cursor.word();
      const descending = cursor.keyword("DESC");
      if (!descending) cursor.keyword("ASC");
      orderBy.push({ field, descending });
    } while (cursor.symbol(","));
  }
  let startPosition = 1;
  let maxResults = 100;
  if (cursor.keyword("STARTPOSITION")) startPosition = cursor.integer();
  if (cursor.keyword("MAXRESULTS")) maxResults = cursor.integer();
  if (!cursor.done()) {
    throw new QueryError("4000", `QueryParserError: Encountered ${describe(cursor.peek())}`);
  }
  if (maxResults > 1000) {
    throw new QueryError("4001", "QueryValidationError: MAXRESULTS must not exceed 1000");
  }
  return { entity, select, where, orderBy, startPosition, maxResults };
}

function condition(cursor: Cursor): QueryCondition {
  const field = cursor.word();
  if (RESERVED.has(field.toUpperCase())) {
    throw new QueryError(
      "4000",
      `QueryParserError: Encountered " ${field} ", expected a property name`,
    );
  }
  let operator: QueryOperator;
  if (cursor.keyword("LIKE")) operator = "LIKE";
  else if (cursor.keyword("IN")) operator = "IN";
  else {
    const token = cursor.next();
    if (token.kind !== "symbol" || !["=", "<", ">", "<=", ">="].includes(token.value)) {
      throw new QueryError(
        "4000",
        `QueryParserError: Encountered ${describe(token)}, expected an operator`,
      );
    }
    operator = token.value as QueryOperator;
  }
  if (operator === "IN") {
    cursor.expectSymbol("(");
    const values = [value(cursor)];
    while (cursor.symbol(",")) values.push(value(cursor));
    cursor.expectSymbol(")");
    return { field, operator, values };
  }
  return { field, operator, values: [value(cursor)] };
}

function value(cursor: Cursor): QueryValue {
  const token = cursor.next();
  if (token.kind === "string" || token.kind === "number") return token.value;
  if (token.kind === "word" && ["TRUE", "FALSE"].includes(token.value.toUpperCase())) {
    return token.value.toUpperCase() === "TRUE";
  }
  throw new QueryError(
    "4000",
    `QueryParserError: Encountered ${describe(token)}, expected a value`,
  );
}

// ---------------------------------------------------------------------------
// Evaluation over QuickBooks JSON entities
// ---------------------------------------------------------------------------

type Entity = { readonly [key: string]: unknown };

/** A field of an entity by dotted, case-insensitive path; refs compare by value, emails by Address. */
export function fieldValue(entity: Entity, path: string): unknown {
  let current: unknown = entity;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    const key = Object.keys(record).find((name) => name.toLowerCase() === segment.toLowerCase());
    current = key === undefined ? undefined : record[key];
  }
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    const record = current as Record<string, unknown>;
    if (typeof record.value === "string") return record.value;
    if (typeof record.Address === "string") return record.Address;
  }
  return current;
}

function compare(left: unknown, right: QueryValue): number | null {
  if (left === undefined || left === null) return null;
  if (typeof right === "boolean") {
    const bool = typeof left === "boolean" ? left : String(left).toLowerCase() === "true";
    return bool === right ? 0 : 1;
  }
  const leftNumber = typeof left === "number" ? left : Number.NaN;
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber - rightNumber;
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function like(left: unknown, pattern: QueryValue): boolean {
  if (left === undefined || left === null) return false;
  const source = String(pattern)
    .split("%")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(String(left));
}

export function matches(entity: Entity, conditions: readonly QueryCondition[]): boolean {
  return conditions.every(({ field, operator, values }) => {
    const left = fieldValue(entity, field);
    const [first] = values;
    if (first === undefined) return false;
    switch (operator) {
      case "IN":
        return values.some((candidate) => compare(left, candidate) === 0);
      case "LIKE":
        return like(left, first);
      default: {
        const result = compare(left, first);
        if (result === null) return false;
        if (operator === "=") return result === 0;
        if (operator === "<") return result < 0;
        if (operator === ">") return result > 0;
        if (operator === "<=") return result <= 0;
        return result >= 0;
      }
    }
  });
}

export function sortEntities<T extends Entity>(
  entities: readonly T[],
  orderBy: ParsedQuery["orderBy"],
): T[] {
  return [...entities].sort((a, b) => {
    for (const { field, descending } of orderBy) {
      const result = order(fieldValue(a, field), fieldValue(b, field));
      if (result !== 0) return descending ? -result : result;
    }
    return Number(fieldValue(a, "Id")) - Number(fieldValue(b, "Id"));
  });
}

/** Sort order of two field values: missing first, numbers numerically, text case-insensitively. */
function order(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}
