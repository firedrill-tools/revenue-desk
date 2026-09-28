// The usage baseline of a resumed Agent SDK session, from the database
// (docs/ARCHITECTURE.md §8, decisions log "Per-run usage of a resumed
// session").
//
// A resumed session's result reports running totals for the whole session,
// so the agent core reports a run's usage as the session totals minus a
// baseline (src/agent/usage.ts). The server and the CLI give it this store:
// the baseline is what the session's earlier runs recorded, so the runs rows
// and the conversation totals add up to the session's totals and never count
// a request twice, whichever process ran the earlier turns. A run that died
// without recording usage leaves its cost to the next run of the session
// instead of losing it. Nothing is written here: each run's recorder stores
// its own usage and session.

import type { UsageBaselineStore } from "../agent/usage.js";
import { databasePath, openDatabase } from "./client.js";
import { recordedSessionUsage } from "./repos/runs.js";
import type { DbExecutor } from "./repos/types.js";

/** Baselines from an open database (the CLI's workspace). */
export function recordedUsageBaselines(db: DbExecutor): UsageBaselineStore {
  return {
    read: ({ sessionId, runId }) => recordedSessionUsage(db, sessionId, runId),
    write: () => {},
  };
}

/**
 * Baselines from the state directory's database, read with a connection of
 * their own (the server's agent core is built before its database opens).
 */
export function stateDirUsageBaselines(stateDir: string): UsageBaselineStore {
  return {
    read(key) {
      const database = openDatabase({ path: databasePath(stateDir), migrate: false });
      try {
        return recordedSessionUsage(database.db, key.sessionId, key.runId);
      } finally {
        database.close();
      }
    },
    write: () => {},
  };
}
