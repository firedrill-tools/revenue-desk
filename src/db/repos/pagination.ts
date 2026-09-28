// Keyset pagination for list endpoints (Page<T> in src/contracts/api.ts).
//
// Lists are ordered newest first by a time column, then by id. A cursor is
// the (time, id) of the last item of the previous page, encoded as opaque
// base64url JSON so clients never build one themselves.

import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export type Cursor = { readonly at: string; readonly id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString("base64url");
}

/** Null when the text is not a cursor this module produced. */
export function decodeCursor(text: string): Cursor | null {
  if (text.length === 0 || text.length > 512) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value as unknown[];
    return typeof at === "string" && typeof id === "string" ? { at, id } : null;
  } catch {
    return null;
  }
}

/** Rows strictly after the cursor in (time DESC, id DESC) order. */
export function afterCursor(timeColumn: SQLiteColumn, idColumn: SQLiteColumn, cursor: Cursor): SQL {
  const condition = or(
    lt(timeColumn, cursor.at),
    and(eq(timeColumn, cursor.at), lt(idColumn, cursor.id)),
  );
  if (condition === undefined) throw new Error("unreachable: or() of two conditions");
  return condition;
}

/**
 * Splits `limit + 1` fetched rows into a page and the next cursor. Callers
 * fetch one extra row to learn whether another page exists.
 */
export function toPage<Row>(
  rows: readonly Row[],
  limit: number,
  cursorOf: (row: Row) => Cursor,
): { readonly rows: readonly Row[]; readonly nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: last === undefined ? null : encodeCursor(cursorOf(last)) };
}

/** `%text%` for LIKE with `\` as the escape character. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
