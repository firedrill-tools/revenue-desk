// The usage baseline of a resumed SDK session, from the database
// (src/db/usage-baseline.ts): what the session's earlier runs recorded,
// never the run being measured, and unknown when no earlier run is known.

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import { insertConversation } from "../../../src/db/repos/conversations.js";
import {
  finishRun,
  insertRun,
  recordedSessionUsage,
  recordRunUsage,
  setRunSession,
} from "../../../src/db/repos/runs.js";
import { seedDatabase } from "../../../src/db/seed.js";
import { recordedUsageBaselines, stateDirUsageBaselines } from "../../../src/db/usage-baseline.js";
import { cleanupAll, openTestDatabase, TEST_SELF, tempStateDir } from "./support.js";

afterEach(cleanupAll);

const T0 = "2026-09-28T10:00:00.000Z";

function usage(costUsd: number, inputTokens: number) {
  return {
    costUsd,
    inputTokens,
    outputTokens: inputTokens / 10,
    cacheReadTokens: 5,
    cacheCreationTokens: 1,
    numTurns: 1,
    modelRequests: 1,
    durationMs: 100,
    durationApiMs: 50,
  };
}

function seeded(stateDir = tempStateDir()) {
  const database = openTestDatabase(stateDir);
  const { db } = database;
  seedDatabase(db, T0);
  insertConversation(db, { id: "c1", title: "", source: "ui", now: T0 });
  const run = (id: string, session: string | null, spent: number | null) => {
    insertRun(db, {
      id,
      conversationId: "c1",
      source: "ui",
      mode: "interactive",
      model: "claude-sonnet-5",
      effort: "medium",
      userMessageId: null,
      assistantMessageId: null,
      policy: DEFAULT_POLICY,
      connections: [],
      startedAt: T0,
      owner: TEST_SELF,
    });
    if (session !== null) setRunSession(db, id, session);
    if (spent !== null) recordRunUsage(db, id, usage(spent, spent * 10_000));
  };
  return { database, db, run, stateDir };
}

describe("recordedSessionUsage", () => {
  it("sums the session's earlier runs, a run that recorded nothing as zero, never the run itself", () => {
    const { db, run } = seeded();
    run("r1", "s1", 0.01);
    run("r2", "s1", null); // killed before it recorded usage
    run("r3", "s1", 0.02);
    run("r_other", "s2", 0.5);
    run("r_now", "s1", null);
    finishRun(db, "r1", {
      status: "completed",
      finishedAt: T0,
      stopReason: null,
      terminalReason: "completed",
      error: null,
    });
    expect(recordedSessionUsage(db, "s1", "r_now")).toEqual({
      costUsd: 0.03,
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheCreationTokens: 2,
      durationApiMs: 100,
    });
  });

  it("is unknown when no earlier run of the session is known", () => {
    const { db, run } = seeded();
    run("r_old", null, 0.01); // written before runs recorded their session
    run("r_now", "s1", null);
    expect(recordedSessionUsage(db, "s1", "r_now")).toBeNull();
    expect(recordedSessionUsage(db, "unknown", "r_now")).toBeNull();
  });
});

describe("usage baseline stores", () => {
  it("read from an open database or through the state directory, and write nothing", () => {
    const { db, run, stateDir } = seeded();
    run("r1", "s1", 0.01);
    run("r_now", "s1", null);
    const key = { sessionId: "s1", runId: "r_now" };
    const expected = recordedSessionUsage(db, "s1", "r_now");
    if (expected === null) throw new Error("expected a baseline");
    expect(expected.costUsd).toBe(0.01);
    expect(recordedUsageBaselines(db).read(key)).toEqual(expected);
    expect(stateDirUsageBaselines(stateDir).read(key)).toEqual(expected);
    recordedUsageBaselines(db).write(key, { ...expected, costUsd: 9 });
    expect(recordedUsageBaselines(db).read(key)).toEqual(expected);
  });
});
