// `pnpm db:seed` (docs/ARCHITECTURE.md §8): writes only the default workspace
// settings (company name blank, which Settings prompts for) and
// DEFAULT_POLICY. Idempotent: existing rows are never changed. It never
// fabricates conversations, runs or tool data; connection rows come from
// configuration and probes when the server starts.
//
// The server and the CLI call seedDatabase() when they open the database, so
// running this script by hand is optional.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_DEFAULTS } from "../contracts/env.js";
import { databasePath, openDatabase } from "./client.js";
import { ensurePolicies } from "./repos/policies.js";
import { ensureSettings } from "./repos/settings.js";
import type { DbExecutor, IsoTime } from "./repos/types.js";

export function seedDatabase(db: DbExecutor, now: IsoTime): void {
  db.transaction((tx) => {
    ensureSettings(tx, now);
    ensurePolicies(tx, now);
  });
}

function isEntryPoint(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(resolve(script))).href;
  } catch {
    return false;
  }
}

function main(): void {
  // The same state directory the server and the CLI use (AGENT_STATE_DIR).
  const stateDir = resolve(process.env.AGENT_STATE_DIR || ENV_DEFAULTS.AGENT_STATE_DIR);
  const database = openDatabase({ path: databasePath(stateDir) });
  try {
    seedDatabase(database.db, new Date().toISOString());
    process.stderr.write(`Seeded default settings and policies in ${database.path}\n`);
  } finally {
    database.close();
  }
}

if (isEntryPoint(import.meta.url)) main();
