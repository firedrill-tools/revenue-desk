// Runs (docs/ARCHITECTURE.md §8): one row per turn of the agent, from the
// user's message to run.finished, with usage, the effective policy and the
// connection availability the run used.

import { and, desc, eq, ne, type SQL, sql } from "drizzle-orm";
import type { Page, RunDetailView, RunSummaryView } from "../../contracts/api.js";
import type { AgentEffort } from "../../contracts/env.js";
import type {
  AgentMode,
  FinishedRunStatus,
  RunConnection,
  RunError,
  RunSource,
  RunStatus,
  RunUsage,
  SdkTerminalReason,
} from "../../contracts/events.js";
import type { PolicyModes } from "../../contracts/integration.js";
import type { RunOwner } from "../owner.js";
import { type RunRow, runs } from "../schema.js";
import { approvalCountsByRun, listApprovalsForRun } from "./approvals.js";
import {
  afterCursor,
  type Cursor,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  toPage,
} from "./pagination.js";
import { failedToolCallCounts, listToolCalls, toolCallCountsByKind } from "./tool-calls.js";
import type { DbExecutor, IsoTime } from "./types.js";

export type NewRun = {
  readonly id: string;
  readonly conversationId: string;
  readonly source: RunSource;
  readonly mode: AgentMode;
  readonly model: string;
  readonly effort: AgentEffort;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly policy: PolicyModes;
  readonly connections: readonly RunConnection[];
  readonly startedAt: IsoTime;
  /** The process that runs it (src/db/owner.ts). */
  readonly owner: RunOwner;
};

export function insertRun(db: DbExecutor, run: NewRun): void {
  db.insert(runs)
    .values({
      id: run.id,
      conversationId: run.conversationId,
      source: run.source,
      mode: run.mode,
      status: "running",
      model: run.model,
      effort: run.effort,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      policySnapshot: { ...run.policy },
      connectionsSnapshot: [...run.connections],
      startedAt: run.startedAt,
      ownerPid: run.owner.pid,
      ownerStartedAt: run.owner.startedAt,
    })
    .run();
}

export function getRun(db: DbExecutor, id: string): RunRow | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

/** The conversation's running run, if any (possibly owned by another process). */
export function runningRunOf(db: DbExecutor, conversationId: string): RunRow | undefined {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), eq(runs.status, "running")))
    .orderBy(desc(runs.startedAt))
    .get();
}

/** Every running run, oldest first; only the conversation's when one is given. */
export function runningRuns(db: DbExecutor, conversationId?: string): RunRow[] {
  const running = eq(runs.status, "running");
  return db
    .select()
    .from(runs)
    .where(
      conversationId === undefined
        ? running
        : and(running, eq(runs.conversationId, conversationId)),
    )
    .orderBy(runs.startedAt, runs.id)
    .all();
}

/** From run.started: what the core actually used. */
export function recordRunStarted(
  db: DbExecutor,
  id: string,
  started: {
    readonly model: string;
    readonly effort: AgentEffort;
    readonly connections: readonly RunConnection[];
  },
): void {
  db.update(runs)
    .set({
      model: started.model,
      effort: started.effort,
      connectionsSnapshot: [...started.connections],
    })
    .where(eq(runs.id, id))
    .run();
}

export function toRunUsage(row: RunRow): RunUsage | null {
  if (row.costUsd === null) return null;
  return {
    costUsd: row.costUsd,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheCreationTokens: row.cacheCreationTokens ?? 0,
    numTurns: row.numTurns ?? 0,
    modelRequests: row.modelRequests ?? 0,
    durationMs: row.durationMs ?? 0,
    durationApiMs: row.durationApiMs ?? 0,
  };
}

/** The Agent SDK session the run uses (its `session` event). */
export function setRunSession(db: DbExecutor, id: string, sdkSessionId: string): void {
  db.update(runs).set({ sdkSessionId }).where(eq(runs.id, id)).run();
}

/** Usage totals of an SDK session: cost, tokens and API time. */
export type SessionUsage = {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly durationApiMs: number;
};

/**
 * What the earlier runs of an SDK session recorded, summed (runs that
 * recorded no usage count as zero). Null when no earlier run of the session
 * is known, e.g. rows written before runs recorded their session.
 */
export function recordedSessionUsage(
  db: DbExecutor,
  sdkSessionId: string,
  excludingRunId: string,
): SessionUsage | null {
  const row = db
    .select({
      runs: sql<number>`count(*)`,
      costUsd: sql<number>`coalesce(sum(${runs.costUsd}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${runs.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${runs.outputTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${runs.cacheReadTokens}), 0)`,
      cacheCreationTokens: sql<number>`coalesce(sum(${runs.cacheCreationTokens}), 0)`,
      durationApiMs: sql<number>`coalesce(sum(${runs.durationApiMs}), 0)`,
    })
    .from(runs)
    .where(and(eq(runs.sdkSessionId, sdkSessionId), ne(runs.id, excludingRunId)))
    .get();
  if (row === undefined || row.runs === 0) return null;
  return {
    costUsd: row.costUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    durationApiMs: row.durationApiMs,
  };
}

/** Stores the run's usage totals and returns the previous totals (null if none). */
export function recordRunUsage(db: DbExecutor, id: string, usage: RunUsage): RunUsage | null {
  const row = getRun(db, id);
  if (row === undefined) return null;
  const previous = toRunUsage(row);
  db.update(runs)
    .set({
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      numTurns: usage.numTurns,
      modelRequests: usage.modelRequests,
      durationMs: usage.durationMs,
      durationApiMs: usage.durationApiMs,
    })
    .where(eq(runs.id, id))
    .run();
  return previous;
}

/** Finishes a running run. False when it was not running. */
export function finishRun(
  db: DbExecutor,
  id: string,
  finished: {
    readonly status: FinishedRunStatus;
    readonly finishedAt: IsoTime;
    readonly stopReason: string | null;
    readonly terminalReason: SdkTerminalReason | null;
    readonly error: RunError | null;
  },
): boolean {
  return (
    db
      .update(runs)
      .set({
        status: finished.status,
        finishedAt: finished.finishedAt,
        stopReason: finished.stopReason,
        terminalReason: finished.terminalReason,
        errorCode: finished.error?.code ?? null,
        errorMessage: finished.error?.message ?? null,
      })
      .where(and(eq(runs.id, id), eq(runs.status, "running")))
      .run().changes === 1
  );
}

export type RunListOptions = {
  readonly conversationId?: string | undefined;
  readonly status?: RunStatus | undefined;
  readonly source?: RunSource | undefined;
  readonly cursor?: Cursor | undefined;
  readonly limit?: number | undefined;
};

/** Newest first. */
export function listRuns(
  db: DbExecutor,
  options: RunListOptions = {},
): { readonly rows: readonly RunRow[]; readonly nextCursor: string | null } {
  const limit =
    options.limit === undefined
      ? DEFAULT_PAGE_LIMIT
      : Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(options.limit)));
  const conditions: SQL[] = [];
  if (options.conversationId !== undefined) {
    conditions.push(eq(runs.conversationId, options.conversationId));
  }
  if (options.status !== undefined) conditions.push(eq(runs.status, options.status));
  if (options.source !== undefined) conditions.push(eq(runs.source, options.source));
  if (options.cursor !== undefined) {
    conditions.push(afterCursor(runs.startedAt, runs.id, options.cursor));
  }
  const rows = db
    .select()
    .from(runs)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(limit + 1)
    .all();
  return toPage(rows, limit, (row) => ({ at: row.startedAt, id: row.id }));
}

function toRunError(row: RunRow): RunError | null {
  if (row.errorCode === null) return null;
  return { code: row.errorCode, message: row.errorMessage ?? "" };
}

export function runSummaryViews(db: DbExecutor, rows: readonly RunRow[]): RunSummaryView[] {
  const ids = rows.map((row) => row.id);
  const kinds = toolCallCountsByKind(db, ids);
  const failures = failedToolCallCounts(db, ids);
  const decisions = approvalCountsByRun(db, ids);
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    source: row.source,
    mode: row.mode,
    status: row.status,
    model: row.model,
    effort: row.effort,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    usage: toRunUsage(row),
    toolCallsByKind: kinds.get(row.id) ?? { composio: 0, mcp: 0, api: 0 },
    failedToolCalls: failures.get(row.id) ?? 0,
    approvals: decisions.get(row.id) ?? { pending: 0, approved: 0, denied: 0 },
    error: toRunError(row),
  }));
}

export function runPage(db: DbExecutor, options: RunListOptions): Page<RunSummaryView> {
  const { rows, nextCursor } = listRuns(db, options);
  return { items: runSummaryViews(db, rows), nextCursor };
}

export function runDetailView(db: DbExecutor, row: RunRow): RunDetailView {
  const [summary] = runSummaryViews(db, [row]);
  if (summary === undefined) throw new Error("unreachable: one summary per row");
  const { approvals: _counts, ...rest } = summary;
  return {
    ...rest,
    stopReason: row.stopReason,
    terminalReason: row.terminalReason,
    policy: row.policySnapshot,
    connections: row.connectionsSnapshot,
    toolCalls: listToolCalls(db, row.id),
    approvals: listApprovalsForRun(db, row.id),
  };
}
