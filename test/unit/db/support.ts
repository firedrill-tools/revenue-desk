// Temporary state directories and databases for the repository and server
// tests: a real SQLite file (WAL, foreign keys) under the OS temp directory,
// removed after each test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDescriptor } from "../../../src/contracts/events.js";
import { databasePath, openDatabase, type RevenueDeskDatabase } from "../../../src/db/client.js";
import type { ProcessProbe, RunOwner } from "../../../src/db/owner.js";

const cleanups: (() => void)[] = [];

/** Registers a cleanup; they run in reverse order in cleanupAll(). */
export function onCleanup(cleanup: () => void): void {
  cleanups.push(cleanup);
}

/** Runs every registered cleanup (call from afterEach). */
export function cleanupAll(): void {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // Best effort: a later cleanup must still run.
    }
  }
}

export function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "revenue-desk-w3-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "state");
}

export function openTestDatabase(stateDir = tempStateDir()): RevenueDeskDatabase {
  const database = openDatabase({ path: databasePath(stateDir) });
  onCleanup(() => database.close());
  return database;
}

/** A financial approval's descriptor, as the core builds it for a Stripe refund. */
export function refundDescriptor(expiresInMs = 60_000): ApprovalDescriptor {
  return {
    actionClass: "financial",
    integration: "stripe",
    connectionKind: "api",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    consequence: "Refund $49.00 to Contoso Ltd",
    facts: [
      { label: "Amount", value: "$49.00 USD" },
      { label: "Charge", value: "ch_dup_0002" },
    ],
    amount: { amountMinor: 4900, currency: "USD" },
    recordIds: ["ch_dup_0002"],
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Run owners (src/db/owner.ts) with a stubbed view of the system's processes
// ---------------------------------------------------------------------------

/** The process under test, as tests record it. */
export const TEST_SELF: RunOwner = { pid: 1_000, startedAt: "2026-09-28T08:00:00.000Z" };
/** Another process that is still running (a CLI in the middle of a run). */
export const LIVE_OWNER: RunOwner = { pid: 3_000, startedAt: "2026-09-28T09:59:30.000Z" };
/** A process that exited (a CLI killed with SIGKILL). */
export const GONE_OWNER: RunOwner = { pid: 2_000, startedAt: "2026-09-28T09:00:00.000Z" };

/** The processes that exist, with the start time `ps` would report. */
export function probeOf(processes: Readonly<Record<number, string>>): ProcessProbe {
  return {
    exists: (pid) => pid in processes,
    startedAt: (pid) => {
      const started = processes[pid];
      return started === undefined ? null : new Date(started);
    },
  };
}

/** TEST_SELF, with LIVE_OWNER running and GONE_OWNER gone. */
export const TEST_OWNERSHIP = {
  self: TEST_SELF,
  probe: probeOf({ [LIVE_OWNER.pid]: LIVE_OWNER.startedAt }),
} as const;
