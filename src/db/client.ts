// Opens the Revenue Desk SQLite database (docs/ARCHITECTURE.md §8).
//
// One file per state directory, shared by the server and the CLI, possibly at
// the same time: WAL mode lets one writer and many readers work together, and
// busy_timeout makes a second process wait for the write lock instead of
// failing. Foreign keys are enforced on every connection.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { STATE_LAYOUT } from "../contracts/env.js";
import * as schema from "./schema.js";

export type RevenueDeskDb = BetterSQLite3Database<typeof schema>;

export interface RevenueDeskDatabase {
  readonly db: RevenueDeskDb;
  /** The raw connection, for pragmas and tests. */
  readonly sqlite: Database.Database;
  readonly path: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** A file path, or ":memory:" for tests. */
  readonly path: string;
  /** Apply pending migrations. Default true. */
  readonly migrate?: boolean;
  /** Where the SQL migrations live. Default src/db/migrations of this checkout. */
  readonly migrationsFolder?: string;
  /** How long to wait for another connection's write lock. Default 5000 ms. */
  readonly busyTimeoutMs?: number;
}

/**
 * src/db/client.ts and dist/db/client.js are both two levels below the
 * repository root, so this resolves to src/db/migrations from either.
 */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../src/db/migrations", import.meta.url),
);

/** <stateDir>/revenue-desk.sqlite */
export function databasePath(stateDir: string): string {
  return join(stateDir, STATE_LAYOUT.database);
}

export function openDatabase(options: OpenDatabaseOptions): RevenueDeskDatabase {
  const inMemory = options.path === ":memory:";
  if (!inMemory) mkdirSync(dirname(options.path), { recursive: true });

  const sqlite = new Database(options.path);
  try {
    sqlite.pragma(`busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5_000))}`);
    sqlite.pragma("foreign_keys = ON");
    if (sqlite.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new Error("SQLite refused to enable foreign keys");
    }
    if (!inMemory) {
      const mode = sqlite.pragma("journal_mode = WAL", { simple: true });
      if (typeof mode !== "string" || mode.toLowerCase() !== "wal") {
        throw new Error(`SQLite refused WAL mode (journal_mode is ${String(mode)})`);
      }
      // Safe with WAL: a crash can lose the last transactions, never corrupt the file.
      sqlite.pragma("synchronous = NORMAL");
    }

    const db = drizzle({ client: sqlite, schema });
    if (options.migrate ?? true) {
      migrate(db, { migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER });
    }
    return {
      db,
      sqlite,
      path: options.path,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
