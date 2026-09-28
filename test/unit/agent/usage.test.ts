import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileUsageBaselineStore,
  runUsage,
  sessionTotals,
  ZERO_TOTALS,
} from "../../../src/agent/usage.js";
import { tempStateDir } from "../../helpers/agent-fixtures.js";
import { result } from "../../helpers/sdk-messages.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const twoModels = result({
  total_cost_usd: 0.05,
  duration_api_ms: 700,
  modelUsage: {
    "claude-sonnet-5": {
      inputTokens: 4000,
      outputTokens: 800,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 50,
      webSearchRequests: 0,
      costUSD: 0.04,
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
    "claude-haiku-5": {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.01,
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
  },
}) as SDKResultMessage;

const stream = { inputTokens: 1000, outputTokens: 250, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe("usage", () => {
  it("sums every model of a result into session totals", () => {
    expect(sessionTotals(twoModels)).toEqual({
      costUsd: 0.05,
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      durationApiMs: 700,
    });
  });

  it("is the whole result for a new session", () => {
    expect(
      runUsage({ result: twoModels, baseline: ZERO_TOTALS, stream, modelRequests: 3 }),
    ).toEqual({
      costUsd: 0.05,
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      numTurns: 2,
      modelRequests: 3,
      durationMs: 900,
      durationApiMs: 700,
    });
  });

  it("subtracts the session's totals at the end of its previous run for a resumed session", () => {
    const baseline = {
      costUsd: 0.03,
      inputTokens: 3000,
      outputTokens: 600,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      durationApiMs: 400,
    };
    expect(runUsage({ result: twoModels, baseline, stream, modelRequests: 1 })).toMatchObject({
      costUsd: 0.02,
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationApiMs: 300,
      durationMs: 900,
    });
  });

  it("estimates from its own stream when a resumed session has no baseline", () => {
    const usage = runUsage({ result: twoModels, baseline: null, stream, modelRequests: 1 });
    expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 250 });
    expect(usage.costUsd).toBeCloseTo(0.05 * (1250 / 6150), 6);
    expect(usage.costUsd).toBeLessThan(0.05);
  });

  it("never reports negative numbers", () => {
    const baseline = { ...ZERO_TOTALS, costUsd: 1, inputTokens: 1e9 };
    const usage = runUsage({ result: twoModels, baseline, stream, modelRequests: 1 });
    expect(usage.costUsd).toBe(0);
    expect(usage.inputTokens).toBe(0);
  });
});

describe("fileUsageBaselineStore", () => {
  it("round-trips totals per session id and ignores anything unreadable", () => {
    const state = tempStateDir();
    cleanups.push(state.cleanup);
    const directory = join(state.dir, "usage");
    const store = fileUsageBaselineStore(directory);
    const sessionId = "2b12aa9b-5884-4a1c-9b29-5bfd36f3d851";
    expect(store.read(sessionId)).toBeNull();
    store.write(sessionId, sessionTotals(twoModels));
    expect(store.read(sessionId)).toEqual(sessionTotals(twoModels));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "bad-session-000.json"), "{not json");
    expect(store.read("bad-session-000")).toBeNull();
    writeFileSync(join(directory, "partial-session.json"), JSON.stringify({ costUsd: 1 }));
    expect(store.read("partial-session")).toBeNull();
    // Ids that could escape the directory are refused.
    store.write("../../escape", ZERO_TOTALS);
    expect(store.read("../../escape")).toBeNull();
  });
});
