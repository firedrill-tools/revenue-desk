// The action log: one row per tool call (docs/ARCHITECTURE.md §8). Inputs are
// redacted and outputs compacted by the caller before they reach this module.

import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { ToolCallStatus, ToolCallView } from "../../contracts/api.js";
import type { ToolDecision } from "../../contracts/events.js";
import { CONNECTION_KINDS, type ConnectionKind } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { type ToolCallRow, toolCalls } from "../schema.js";
import type { DbExecutor, IsoTime } from "./types.js";

export type NewToolCall = Pick<
  typeof toolCalls.$inferInsert,
  | "id"
  | "runId"
  | "conversationId"
  | "toolUseId"
  | "integration"
  | "connectionKind"
  | "toolName"
  | "operation"
  | "actionClass"
  | "title"
> & { readonly input: JsonObject; readonly startedAt: IsoTime };

/**
 * A call is identified by its run and the model's tool_use id: a tool_use id
 * is unique only within a run (a scripted model, or a replayed transcript,
 * can repeat one), so no write may ever reach another run's row.
 */
export type ToolCallKey = { readonly runId: string; readonly toolUseId: string };

function byKey(key: ToolCallKey) {
  return and(eq(toolCalls.runId, key.runId), eq(toolCalls.toolUseId, key.toolUseId));
}

/** Records a call once its input is complete. A repeated tool_use id in the same run is ignored. */
export function insertToolCall(db: DbExecutor, call: NewToolCall): void {
  const { input, ...values } = call;
  db.insert(toolCalls)
    .values({ ...values, inputJson: input, status: "running", decision: "pending" })
    .onConflictDoNothing({ target: [toolCalls.runId, toolCalls.toolUseId] })
    .run();
}

export function getToolCall(db: DbExecutor, key: ToolCallKey): ToolCallRow | undefined {
  return db.select().from(toolCalls).where(byKey(key)).get();
}

/** The latest call with this tool_use id in any run (diagnostics and tests). */
export function getToolCallByToolUseId(db: DbExecutor, toolUseId: string): ToolCallRow | undefined {
  return db
    .select()
    .from(toolCalls)
    .where(eq(toolCalls.toolUseId, toolUseId))
    .orderBy(desc(toolCalls.startedAt))
    .get();
}

export function markToolCallAwaitingApproval(
  db: DbExecutor,
  key: ToolCallKey,
  approvalId: string,
): void {
  db.update(toolCalls).set({ status: "awaiting_approval", approvalId }).where(byKey(key)).run();
}

/** An approval was decided: approved calls run on; others are denied. */
export function markToolCallDecided(
  db: DbExecutor,
  key: ToolCallKey,
  decision: Extract<ToolDecision, "approved" | "denied" | "timed_out" | "stopped">,
): void {
  const status: ToolCallStatus = decision === "approved" ? "running" : "denied";
  db.update(toolCalls).set({ status, decision }).where(byKey(key)).run();
}

/**
 * The call did not run. `rejected` (unknown tool or invalid input) is a
 * failure; every other decision is a denial. `reason` is what the model got.
 */
export function markToolCallDenied(
  db: DbExecutor,
  key: ToolCallKey,
  input: {
    readonly decision: Extract<
      ToolDecision,
      "denied" | "policy_denied" | "timed_out" | "stopped" | "rejected"
    >;
    readonly reason: string;
    readonly finishedAt: IsoTime;
  },
): void {
  const row = getToolCall(db, key);
  if (row === undefined) return;
  const rejected = input.decision === "rejected";
  db.update(toolCalls)
    .set({
      status: rejected ? "failed" : "denied",
      decision: input.decision,
      outputJson: input.reason,
      isError: rejected,
      errorMessage: rejected ? input.reason : null,
      finishedAt: input.finishedAt,
      durationMs: elapsedMs(row.startedAt, input.finishedAt),
    })
    .where(byKey(key))
    .run();
}

export function markToolCallFinished(
  db: DbExecutor,
  key: ToolCallKey,
  result: {
    readonly output: JsonValue;
    readonly truncated: boolean;
    readonly isError: boolean;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly httpStatus: number | null;
    readonly upstreamTool: string | null;
    readonly idempotencyKey: string | null;
    readonly durationMs: number;
    readonly finishedAt: IsoTime;
  },
): void {
  const row = getToolCall(db, key);
  if (row === undefined) return;
  db.update(toolCalls)
    .set({
      status: result.isError ? "failed" : "succeeded",
      // A call that never asked ran on the policy's `auto`.
      decision: row.decision === "pending" ? "auto" : row.decision,
      outputJson: result.output,
      truncated: result.truncated,
      isError: result.isError,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      httpStatus: result.httpStatus,
      upstreamTool: result.upstreamTool ?? row.upstreamTool,
      idempotencyKey: result.idempotencyKey,
      finishedAt: result.finishedAt,
      durationMs: Math.max(0, Math.round(result.durationMs)),
    })
    .where(byKey(key))
    .run();
}

/**
 * The gateway started executing an API write: its row keeps the idempotency
 * key the provider receives from now on, so a run that ends before the
 * answer (a forced stop, a crash) still records which request may have been
 * applied. The call's own outcome replaces it (markToolCallFinished).
 */
export function markToolCallExecuting(
  db: DbExecutor,
  key: ToolCallKey,
  idempotencyKey: string,
): void {
  db.update(toolCalls)
    .set({ idempotencyKey })
    .where(
      and(byKey(key), eq(toolCalls.status, "running"), sql`${toolCalls.idempotencyKey} IS NULL`),
    )
    .run();
}

/** Why a started write that ended without its answer is not "not run". */
export const INTERRUPTED_WRITE_MESSAGE =
  "The run ended while this write was running, before its result arrived, so it may have been applied. Check the record (its idempotency key is recorded) before trying again.";

/**
 * The run ended (stop, failure or restart) with these calls in flight. A
 * write that had started (its idempotency key is recorded) may have been
 * applied: it is interrupted with the outcome_unknown error, not as never run.
 */
export function interruptToolCalls(db: DbExecutor, runId: string, now: IsoTime): number {
  const inFlight = db
    .select()
    .from(toolCalls)
    .where(
      and(eq(toolCalls.runId, runId), inArray(toolCalls.status, ["running", "awaiting_approval"])),
    )
    .all();
  for (const row of inFlight) {
    const startedWrite =
      row.status === "running" &&
      row.idempotencyKey !== null &&
      row.actionClass !== null &&
      row.actionClass !== "read";
    db.update(toolCalls)
      .set({
        status: "interrupted",
        finishedAt: now,
        durationMs: elapsedMs(row.startedAt, now),
        ...(startedWrite
          ? {
              isError: true,
              errorCode: "outcome_unknown",
              errorMessage: INTERRUPTED_WRITE_MESSAGE,
              decision: row.decision === "pending" ? "auto" : row.decision,
            }
          : {}),
      })
      .where(eq(toolCalls.id, row.id))
      .run();
  }
  return inFlight.length;
}

export function toToolCallView(row: ToolCallRow): ToolCallView {
  return {
    id: row.id,
    toolCallId: row.toolUseId,
    runId: row.runId,
    integration: row.integration,
    connectionKind: row.connectionKind,
    toolName: row.toolName,
    upstreamTool: row.upstreamTool,
    operation: row.operation,
    actionClass: row.actionClass,
    title: row.title,
    status: row.status,
    decision: row.decision,
    input: row.inputJson,
    output: row.outputJson ?? null,
    isError: row.isError,
    error: row.isError
      ? {
          provider: row.integration,
          status: row.httpStatus,
          code: row.errorCode,
          message: row.errorMessage ?? "",
        }
      : null,
    httpStatus: row.httpStatus,
    idempotencyKey: row.idempotencyKey,
    approvalId: row.approvalId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
  };
}

export function listToolCalls(db: DbExecutor, runId: string): ToolCallView[] {
  return (
    db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId))
      // Calls started in the same millisecond keep their insertion order.
      .orderBy(asc(toolCalls.startedAt), asc(sql`rowid`))
      .all()
      .map(toToolCallView)
  );
}

export type ToolCallsByKind = { readonly [K in ConnectionKind]: number };

/** Tool calls per connection kind for each run id (zero for missing kinds). */
export function toolCallCountsByKind(
  db: DbExecutor,
  runIds: readonly string[],
): ReadonlyMap<string, ToolCallsByKind> {
  const counts = new Map<string, { [K in ConnectionKind]: number }>();
  for (const runId of runIds) counts.set(runId, emptyKindCounts());
  if (runIds.length === 0) return counts;
  for (const group of db
    .select({ runId: toolCalls.runId, kind: toolCalls.connectionKind, calls: count() })
    .from(toolCalls)
    .where(and(inArray(toolCalls.runId, [...runIds]), isNotNull(toolCalls.connectionKind)))
    .groupBy(toolCalls.runId, toolCalls.connectionKind)
    .all()) {
    const entry = counts.get(group.runId);
    if (entry !== undefined && group.kind !== null) entry[group.kind] = group.calls;
  }
  return counts;
}

function emptyKindCounts(): { [K in ConnectionKind]: number } {
  const counts = {} as { [K in ConnectionKind]: number };
  for (const kind of CONNECTION_KINDS) counts[kind] = 0;
  return counts;
}

function elapsedMs(startedAt: IsoTime, finishedAt: IsoTime): number | null {
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : null;
}
