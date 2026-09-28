// One active run per conversation across processes: the CLI's workspace
// (src/cli/services.ts) against a real state directory, with a run of the
// conversation owned by another live process.

import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { isActiveRunError } from "../../../src/cli/errors.js";
import { createServices } from "../../../src/cli/services.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import { databasePath, openDatabase } from "../../../src/db/client.js";
import { systemProcessProbe } from "../../../src/db/owner.js";
import { insertConversation } from "../../../src/db/repos/conversations.js";
import { insertRun } from "../../../src/db/repos/runs.js";
import { seedDatabase } from "../../../src/db/seed.js";
import { TEST_SETTINGS } from "../../helpers/agent-fixtures.js";
import { cleanupAll, onCleanup, tempStateDir } from "../../unit/db/support.js";
import { testEnv } from "../../unit/integrations/helpers.js";

afterEach(cleanupAll);

describe("the CLI's run start", () => {
  it("reports a run another process started on the conversation as an active run", async () => {
    const stateDir = tempStateDir();
    const env = testEnv({ runtime: { stateDir } });
    // Another process (the app's server, say) runs the conversation and is alive.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    onCleanup(() => other.kill("SIGKILL"));
    const pid = other.pid;
    if (pid === undefined) throw new Error("no child pid");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = systemProcessProbe.startedAt(pid)?.toISOString();
    if (startedAt === undefined) throw new Error("ps could not read the child");
    const seeded = openDatabase({ path: databasePath(stateDir) });
    seedDatabase(seeded.db, startedAt);
    insertConversation(seeded.db, { id: "c1", title: "Busy", source: "ui", now: startedAt });
    insertRun(seeded.db, {
      id: "r_app",
      conversationId: "c1",
      source: "ui",
      mode: "interactive",
      model: "claude-sonnet-5",
      effort: "medium",
      userMessageId: null,
      assistantMessageId: null,
      policy: DEFAULT_POLICY,
      connections: [],
      startedAt,
      owner: { pid, startedAt },
    });
    seeded.close();

    const services = await createServices({ log: () => {} });
    const workspace = services.openWorkspace(env);
    try {
      const error = await Promise.resolve()
        .then(() =>
          workspace.beginRun({
            mode: "headless",
            runId: "r_cli",
            conversationId: "c1",
            source: "cli",
            prompt: "Refund it",
            resumeSessionId: null,
            env,
            model: {
              model: "claude-sonnet-5",
              effort: "medium",
              thinkingDisplay: "omitted",
              maxTurns: 5,
              maxBudgetUsd: 1,
            },
            settings: TEST_SETTINGS,
            policy: DEFAULT_POLICY,
            businessDate: "2026-09-29",
            connections: [],
            signal: new AbortController().signal,
          }),
        )
        .catch((caught: unknown) => caught);
      expect(isActiveRunError(error)).toBe(true);
      expect((error as Error).message).toContain("already has an active run");
    } finally {
      workspace.close();
    }
  });
});
