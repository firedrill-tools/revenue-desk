// Per-run usage (RunUsage) from the SDK result message.
//
// A resumed session's result reports running totals for the whole session
// (total_cost_usd, modelUsage and duration_api_ms continue from the totals
// its transcript saved; checked against SDK 0.3.283 on 2026-09-28). A run's
// own usage is therefore the session totals minus a baseline: what the
// session's earlier runs recorded. The server and the CLI read it from the
// database (src/db/usage-baseline.ts), so run rows and conversation totals
// never count a request twice; without a store the core keeps the totals in
// a small file per session under CLAUDE_CONFIG_DIR. A new session, or a
// resume that started a different session, has a zero baseline. Without a
// baseline (an older session) tokens come from this run's own stream events
// and the cost is the session cost pro-rated by tokens: an estimate,
// labelled as such here. Totals below the baseline mean the SDK did not
// carry the session's totals over, and are this run's own.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunUsage } from "../contracts/events.js";

export type UsageTotals = {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly durationApiMs: number;
};

export const ZERO_TOTALS: UsageTotals = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  durationApiMs: 0,
};

/** Token counts of this run's own main-loop requests, from stream events. */
export type StreamTokens = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
};

/** The session totals a result reports (every model in modelUsage). */
export function sessionTotals(result: SDKResultMessage): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const usage of Object.values(result.modelUsage)) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadInputTokens;
    cacheCreationTokens += usage.cacheCreationInputTokens;
  }
  return {
    costUsd: result.total_cost_usd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    durationApiMs: result.duration_api_ms,
  };
}

const nonNegative = (value: number) => (value > 0 ? value : 0);
const roundUsd = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * This run's usage. `baseline` is the session's totals at the end of its
 * previous run, ZERO_TOTALS for a new session, or null when unknown.
 */
export function runUsage(input: {
  readonly result: SDKResultMessage;
  readonly baseline: UsageTotals | null;
  readonly stream: StreamTokens;
  readonly modelRequests: number;
}): RunUsage {
  const totals = sessionTotals(input.result);
  const common = {
    numTurns: input.result.num_turns,
    modelRequests: input.modelRequests,
    durationMs: input.result.duration_ms,
  };
  if (input.baseline !== null) {
    // Totals below the baseline did not continue from it: they are this run's own.
    const base = carriesOver(totals, input.baseline) ? input.baseline : ZERO_TOTALS;
    return {
      costUsd: roundUsd(nonNegative(totals.costUsd - base.costUsd)),
      inputTokens: nonNegative(totals.inputTokens - base.inputTokens),
      outputTokens: nonNegative(totals.outputTokens - base.outputTokens),
      cacheReadTokens: nonNegative(totals.cacheReadTokens - base.cacheReadTokens),
      cacheCreationTokens: nonNegative(totals.cacheCreationTokens - base.cacheCreationTokens),
      durationApiMs: nonNegative(totals.durationApiMs - base.durationApiMs),
      ...common,
    };
  }
  const { stream } = input;
  const runTokens =
    stream.inputTokens + stream.outputTokens + stream.cacheReadTokens + stream.cacheCreationTokens;
  const sessionTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  const share = sessionTokens > 0 ? Math.min(1, runTokens / sessionTokens) : 0;
  return {
    costUsd: roundUsd(totals.costUsd * share),
    inputTokens: stream.inputTokens,
    outputTokens: stream.outputTokens,
    cacheReadTokens: stream.cacheReadTokens,
    cacheCreationTokens: stream.cacheCreationTokens,
    durationApiMs: Math.round(totals.durationApiMs * share),
    ...common,
  };
}

/** Whether `totals` continue from `baseline` (running totals never go down). */
function carriesOver(totals: UsageTotals, baseline: UsageTotals): boolean {
  return (
    totals.costUsd + 1e-9 >= baseline.costUsd &&
    totals.inputTokens >= baseline.inputTokens &&
    totals.outputTokens >= baseline.outputTokens &&
    totals.cacheReadTokens >= baseline.cacheReadTokens &&
    totals.cacheCreationTokens >= baseline.cacheCreationTokens
  );
}

/** Which run of which session a baseline is asked for. */
export type BaselineKey = {
  readonly sessionId: string;
  /** The run being measured: never part of its own baseline. */
  readonly runId: string;
};

/** Where the baseline of a resumed session comes from. */
export interface UsageBaselineStore {
  /** The session's totals before this run; null when unknown. */
  read(key: BaselineKey): UsageTotals | null;
  /** The session's totals at the end of this run (stores that keep them). */
  write(key: BaselineKey, totals: UsageTotals): void;
}

/**
 * The baseline of a run: zero for a new session or when the SDK started a
 * different session than the one resumed, the store's otherwise (null when
 * it does not know or cannot say).
 */
export function usageBaseline(input: {
  readonly resumeSessionId: string | null;
  readonly sessionId: string;
  readonly runId: string;
  readonly store: UsageBaselineStore;
}): UsageTotals | null {
  if (input.resumeSessionId === null || input.resumeSessionId !== input.sessionId) {
    return ZERO_TOTALS;
  }
  try {
    return input.store.read({ sessionId: input.sessionId, runId: input.runId });
  } catch {
    return null;
  }
}

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

function isTotals(value: unknown): value is UsageTotals {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    [
      "costUsd",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "durationApiMs",
    ] as const
  ).every((key) => typeof record[key] === "number" && Number.isFinite(record[key]));
}

/** One JSON file per session id in `directory`; unreadable files count as missing. */
export function fileUsageBaselineStore(directory: string): UsageBaselineStore {
  const pathOf = (sessionId: string) =>
    SESSION_ID.test(sessionId) ? join(directory, `${sessionId}.json`) : null;
  return {
    read({ sessionId }) {
      const path = pathOf(sessionId);
      if (path === null) return null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isTotals(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write({ sessionId }, totals) {
      const path = pathOf(sessionId);
      if (path === null) return;
      mkdirSync(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(totals));
      renameSync(temporary, path);
    },
  };
}
