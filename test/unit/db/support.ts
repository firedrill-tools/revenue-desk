// Temporary state directories and databases for the repository and server
// tests: a real SQLite file (WAL, foreign keys) under the OS temp directory,
// removed after each test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDescriptor } from "../../../src/contracts/events.js";
import { databasePath, openDatabase, type RevenueDeskDatabase } from "../../../src/db/client.js";

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
    consequence: "Refund $49.00 to Kestrel Analytics",
    facts: [
      { label: "Amount", value: "$49.00 USD" },
      { label: "Charge", value: "ch_dup_0002" },
    ],
    amount: { amountMinor: 4900, currency: "USD" },
    recordIds: ["ch_dup_0002"],
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}
