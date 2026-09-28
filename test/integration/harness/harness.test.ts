/**
 * The full-stack harness: its explicit environment (nothing ambient, every
 * endpoint loopback, accepted by the product's config), the server launched
 * as `pnpm dev:server` runs it, and a scenario played over the HTTP API
 * (session, CSRF, SSE stream, approvals) against the in-process server with
 * the agent core, the production integrations and every fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentEnv, sandboxEndpointProblems } from "../../../src/config/env.js";
import { ENV_VAR_NAMES } from "../../../src/contracts/env.js";
import { J2_REFUND_DUPLICATE } from "../../scenarios/index.js";
import { runScenarioOverHttp } from "../../scenarios/run-over-http.js";
import { startFakes } from "../../support/fakes/index.js";
import {
  type Harness,
  harnessEnvironment,
  REPOSITORY_ROOT,
  startHarness,
} from "../../support/harness.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

describe("harness environment", () => {
  it("is explicit: no ambient keys or DOTENV_PATH, loopback endpoints, accepted as a sandbox", async () => {
    const saved = { ...process.env };
    process.env.STRIPE_SECRET_KEY = "sk_live_ambient_should_not_leak";
    process.env.DOTENV_PATH = "/somewhere/.env";
    process.env.COMPOSIO_API_KEY = "ambient-composio";
    const fakes = await startFakes();
    try {
      const env = harnessEnvironment({
        fakes,
        modelUrl: "http://127.0.0.1:9",
        stateDir: "/tmp/rd-state",
        port: 4999,
        sandbox: true,
      });
      expect(JSON.stringify(env)).not.toContain("ambient");
      expect(env.DOTENV_PATH).toBeUndefined();
      const product = Object.keys(env).filter((name) =>
        (ENV_VAR_NAMES as readonly string[]).includes(name),
      );
      expect(new Set(Object.keys(env))).toEqual(
        new Set([
          ...product,
          "PATH",
          "HOME",
          "TMPDIR",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
          "CLAUDE_CODE_MAX_RETRIES",
        ]),
      );
      for (const [name, value] of Object.entries(env)) {
        if (/_(URL|BASE_URL)$/.test(name)) expect(new URL(value).hostname, name).toBe("127.0.0.1");
      }
      const loaded = loadAgentEnv(env, { cwd: REPOSITORY_ROOT });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.problems));
      expect(loaded.env.runtime.sandbox).toBe(true);
      expect(sandboxEndpointProblems(loaded.env)).toEqual([]);
    } finally {
      await fakes.close();
      process.env = saved;
    }
  });
});

describe("harness servers", () => {
  it("starts src/server/main.ts as a child process with that environment and stops it", {
    timeout: 60_000,
  }, async () => {
    const harness = await startHarness({ server: "process" });
    open.push(harness);
    const health = await fetch(`${harness.url}/api/health`);
    expect(await health.json()).toMatchObject({ status: "ok", service: "revenue-desk" });
    expect(harness.serverLog()).toContain(`listening on ${harness.url}`);
    expect(["applied", "unsupported"]).toContain(harness.workspace);
    await harness.close();
    open.splice(0);
    await expect(fetch(`${harness.url}/api/health`)).rejects.toThrow();
  });

  it("plays J2 over the HTTP API against the in-process server, deciding the approval mid-stream", {
    timeout: 120_000,
  }, async () => {
    const harness = await startHarness({ server: "in-process", model: J2_REFUND_DUPLICATE });
    open.push(harness);
    expect(harness.workspace).toBe("applied");
    const settings = await harness.api?.expect("GET /api/settings");
    expect(settings?.settings.allowedSlackChannels).toEqual(["#billing", "#sales-ops", "#revenue"]);
    const run = await runScenarioOverHttp(harness, J2_REFUND_DUPLICATE);
    expect(run.problems, harness.serverLog().slice(-4_000)).toEqual([]);
    expect(run.chunks.map((chunk) => chunk.type)).toEqual(
      expect.arrayContaining([
        "start",
        "tool-approval-request",
        "tool-approval-response",
        "finish",
      ]),
    );
    const detail = await harness.api?.expect("GET /api/runs/:runId", {
      params: { runId: String(run.runId) },
    });
    expect(detail?.status).toBe("completed");
    expect(detail?.toolCalls.find((call) => call.toolCallId === "toolu_j2_refund")).toMatchObject({
      decision: "approved",
      status: "succeeded",
    });
  });
});
