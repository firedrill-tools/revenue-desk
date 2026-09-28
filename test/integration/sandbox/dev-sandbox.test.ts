/**
 * `pnpm dev:sandbox` started for real (API only, on a free port so it never
 * collides with a developer's running server): the fakes, the scripted
 * model and the server process come up, the banner describes them, and stop
 * shuts everything down.
 */
import { describe, expect, it } from "vitest";
import { SANDBOX_BANNER, startSandbox } from "../../../scripts/dev-sandbox.js";
import { freePort } from "../../support/harness.js";

describe("dev:sandbox", () => {
  it("starts the labelled demo against local fakes and stops it", { timeout: 60_000 }, async () => {
    const apiPort = await freePort();
    const output: string[] = [];
    const sandbox = await startSandbox(
      { model: "scripted", hubspot: "stdio", stateDir: null, web: false },
      { apiPort, onServerOutput: (text) => output.push(text) },
    );
    let stopped = false;
    try {
      const { harness, banner } = sandbox;
      expect(banner).toContain(SANDBOX_BANNER);
      expect(banner).toContain(`http://127.0.0.1:${apiPort}`);
      expect(harness.env.AGENT_SANDBOX).toBe("1");
      expect(harness.env.DOTENV_PATH).toBeUndefined();
      expect(harness.model).not.toBeNull();
      expect(harness.env.ANTHROPIC_BASE_URL).toBe(harness.model?.url);
      const health = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      expect(health.ok).toBe(true);
      expect(output.join("")).toContain("listening");
      // The fakes run on a clock that starts at the fixtures' date and moves.
      expect(harness.fakes.clock.now().toISOString() >= "2026-09-28T13:00:00.000Z").toBe(true);
      await sandbox.stop();
      stopped = true;
      await expect(fetch(`http://127.0.0.1:${apiPort}/api/health`)).rejects.toThrow();
    } finally {
      if (!stopped) await sandbox.stop();
    }
  });
});
