// Shared types for the repositories over src/db/schema.ts (docs/ARCHITECTURE.md §8).

import type { RunResult } from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../schema.js";

/**
 * The database or a transaction on it. Every repository function takes one,
 * so callers can compose several writes into a single `db.transaction()`.
 * better-sqlite3 is synchronous: no repository function awaits.
 */
export type DbExecutor = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

/** ISO-8601 UTC text, as every time column stores it. */
export type IsoTime = string;
