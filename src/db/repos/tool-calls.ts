// The action log: one row per tool call (docs/ARCHITECTURE.md §8). Inputs are
// redacted and outputs compacted by the caller before they reach this module.

import { and, asc, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
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

/** Records a call once its input is complete. A repeated tool_use id is ignored. */
export function insertToolCall(db: DbExecutor, call: NewToolCall): void {
  const { input, ...values } = call;
  db.insert(toolCalls)
    .values({ ...values, inputJson: input, status: "running", decision: "pending" })
    .onConflictDoNothing({ target: toolCalls.toolUseId })
    .run();
}

export function getToolCallByToolUseId(db: DbExecutor, toolUseId: string): ToolCallRow | undefined {
  return db.select().from(toolCalls).where(eq(toolCalls.toolUseId, toolUseId)).get();
}

export function markToolCallAwaitingApproval(
  db: DbExecutor,
  toolUseId: string,
  approvalId: string,
): void {
  db.update(toolCalls)
    .set({ status: "awaiting_approval", approvalId })
    .where(eq(toolCalls.toolUseId, toolUseId))
    .run();
}

/** An approval was decided: approved calls run on; others are denied. */
export function markToolCallDecided(
  db: DbExecutor,
  toolUseId: string,
  decision: Extract<ToolDecision, "approved" | "denied" | "timed_out" | "stopped">,
): void {
  const status: ToolCallStatus = decision === "approved" ? "running" : "denied";
  db.update(toolCalls).set({ status, decision }).where(eq(toolCalls.toolUseId, toolUseId)).run();
}

/**
 * The call did not run. `rejected` (unknown tool or invalid input) is a
 * failure; every other decision is a denial. `reason` is what the model got.
 */
export function markToolCallDenied(
  db: DbExecutor,
  toolUseId: string,
  input: {
    readonly decision: Extract<
      ToolDecision,
      "denied" | "policy_denied" | "timed_out" | "stopped" | "rejected"
    >;
    readonly reason: string;
    readonly finishedAt: IsoTime;
  },
): void {
  const row = getToolCallByToolUseId(db, toolUseId);
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
    .where(eq(toolCalls.toolUseId, toolUseId))
    .run();
}

export function markToolCallFinished(
  db: DbExecutor,
  toolUseId: string,
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
  const row = getToolCallByToolUseId(db, toolUseId);
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
    .where(eq(toolCalls.toolUseId, toolUseId))
    .run();
}

/** The run ended (stop, failure or restart) with these calls in flight. */
export function interruptToolCalls(db: DbExecutor, runId: string, now: IsoTime): number {
  const inFlight = db
    .select()
    .from(toolCalls)
    .where(
      and(eq(toolCalls.runId, runId), inArray(toolCalls.status, ["running", "awaiting_approval"])),
    )
    .all();
  for (const row of inFlight) {
    db.update(toolCalls)
      .set({
        status: "interrupted",
        finishedAt: now,
        durationMs: elapsedMs(row.startedAt, now),
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
