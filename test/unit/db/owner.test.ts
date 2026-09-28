// Run ownership (src/db/owner.ts): which process runs a run, and whether it
// is still there. The system probe is exercised against real processes.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createProcessProbe,
  currentRunOwner,
  OWNER_START_TOLERANCE_MS,
  ownerOf,
  ownerState,
  psPath,
  type RunOwner,
  systemProcessProbe,
} from "../../../src/db/owner.js";
import { probeOf } from "./support.js";

const SELF: RunOwner = { pid: 1_000, startedAt: "2026-09-28T08:00:00.000Z" };

describe("ownerState", () => {
  it("knows its own runs, and a run of an earlier process with its pid as gone", () => {
    const probe = probeOf({});
    expect(ownerState(SELF, { self: SELF, probe })).toBe("self");
    expect(
      ownerState({ pid: SELF.pid, startedAt: "2026-09-28T07:00:00.000Z" }, { self: SELF, probe }),
    ).toBe("gone");
  });

  it("is gone without an owner, for a pid that cannot exist, or for a process that exited", () => {
    const probe = probeOf({ 3000: "2026-09-28T09:00:00.000Z" });
    const options = { self: SELF, probe };
    expect(ownerState({ pid: null, startedAt: null }, options)).toBe("gone");
    expect(ownerState({ pid: 0, startedAt: "2026-09-28T09:00:00.000Z" }, options)).toBe("gone");
    expect(ownerState({ pid: -5, startedAt: "2026-09-28T09:00:00.000Z" }, options)).toBe("gone");
    expect(ownerState({ pid: 4_000, startedAt: "2026-09-28T09:00:00.000Z" }, options)).toBe("gone");
  });

  it("compares start times: a live pid with another start is a reused pid", () => {
    const probe = probeOf({ 3000: "2026-09-28T09:00:00.000Z" });
    const options = { self: SELF, probe };
    expect(ownerState({ pid: 3_000, startedAt: "2026-09-28T09:00:00.900Z" }, options)).toBe(
      "alive",
    );
    const late = new Date(Date.parse("2026-09-28T09:00:00.000Z") + OWNER_START_TOLERANCE_MS + 1);
    expect(ownerState({ pid: 3_000, startedAt: late.toISOString() }, options)).toBe("gone");
  });

  it("takes a live pid at its word when its start time cannot be read", () => {
    const probe = { exists: () => true, startedAt: () => null };
    expect(ownerState({ pid: 3_000, startedAt: "2026-09-28T09:00:00.000Z" }, { probe })).toBe(
      "alive",
    );
  });
});

describe("the system probe", () => {
  it("records this process with the start time the system reports", () => {
    const self = currentRunOwner();
    expect(self.pid).toBe(process.pid);
    const reported = systemProcessProbe.startedAt(process.pid);
    expect(reported).not.toBeNull();
    expect(Math.abs((reported?.getTime() ?? 0) - Date.parse(self.startedAt))).toBeLessThanOrEqual(
      OWNER_START_TOLERANCE_MS,
    );
    expect(ownerState(self)).toBe("self");
    // The same pid with another start time is an earlier process that reused it.
    expect(ownerState({ pid: self.pid, startedAt: "2020-01-01T00:00:00.000Z" })).toBe("gone");
  });

  it("sees another process while it runs and after it was killed with SIGKILL", async () => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("no child pid");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const owner = { pid, startedAt };
      expect(systemProcessProbe.exists(pid)).toBe(true);
      expect(ownerState(owner)).toBe("alive");
      // Recorded long before the process under this pid started: a reused pid.
      expect(ownerState({ pid, startedAt: "2020-01-01T00:00:00.000Z" })).toBe("gone");

      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      expect(systemProcessProbe.exists(pid)).toBe(false);
      expect(ownerState(owner)).toBe("gone");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

describe("the ps probe", () => {
  it("runs ps by absolute path with no secret in its environment", () => {
    process.env.REVENUE_DESK_TEST_SECRET = "sk_test_should_not_leak";
    try {
      const calls: { command: string; args: readonly string[]; env: Record<string, string> }[] = [];
      const probe = createProcessProbe((command, args, options) => {
        calls.push({ command, args, env: { ...options.env } });
        return { status: 0, stdout: "Tue Sep 29 03:11:52 2026\n" };
      }, "/bin/ps");
      expect(probe.startedAt(4242)?.getTime()).toBe(Date.parse("Tue Sep 29 03:11:52 2026"));
      expect(calls).toEqual([
        {
          command: "/bin/ps",
          args: ["-o", "lstart=", "-p", "4242"],
          env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
        },
      ]);
      expect(JSON.stringify(calls)).not.toContain("sk_test_should_not_leak");
      expect(psPath((path) => path === "/usr/bin/ps")).toBe("/usr/bin/ps");
      expect(psPath(() => true)).toBe("/bin/ps");
      expect(systemProcessProbe.startedAt(process.pid)).not.toBeNull();
    } finally {
      delete process.env.REVENUE_DESK_TEST_SECRET;
    }
  });

  it("reads nothing from a failing or unreadable ps", () => {
    expect(createProcessProbe(() => ({ status: 1, stdout: "" })).startedAt(1)).toBeNull();
    expect(createProcessProbe(() => ({ status: 0, stdout: "not a date" })).startedAt(1)).toBeNull();
    expect(
      createProcessProbe(() => {
        throw new Error("ENOENT");
      }).startedAt(1),
    ).toBeNull();
  });
});

describe("an owner started through a delayed exec", () => {
  it("records its start as ps reports it, so another process sees it alive", () => {
    // The pid was forked at 09:00:00; Node initialised 4.5 s later (sh -c 'sleep 4; exec node …').
    const forked = "2026-09-28T09:00:00.000Z";
    const nodeStart = Date.parse(forked) + 4_546;
    const probe = probeOf({ 3000: forked });
    const owner = ownerOf(3_000, probe, nodeStart);
    expect(owner.startedAt).toBe(forked);
    expect(ownerState(owner, { self: SELF, probe })).toBe("alive");
    // With Node's clock, it would have been taken for a reused pid.
    const byNodeClock = { pid: 3_000, startedAt: new Date(nodeStart).toISOString() };
    expect(ownerState(byNodeClock, { self: SELF, probe })).toBe("gone");
    // Without ps, Node's clock is the fallback.
    expect(ownerOf(3_000, { startedAt: () => null }, nodeStart).startedAt).toBe(
      new Date(nodeStart).toISOString(),
    );
  });
});
