// Conversations (docs/ARCHITECTURE.md §8): the chat rail, search and totals.

import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { ConversationStatus, ConversationSummary, Page } from "../../contracts/api.js";
import type { RunSource } from "../../contracts/events.js";
import { approvals, type ConversationRow, conversations, messages, runs } from "../schema.js";
import {
  afterCursor,
  type Cursor,
  DEFAULT_PAGE_LIMIT,
  likeContains,
  MAX_PAGE_LIMIT,
  toPage,
} from "./pagination.js";
import type { DbExecutor, IsoTime } from "./types.js";

export const MAX_TITLE_LENGTH = 200;

export function insertConversation(
  db: DbExecutor,
  input: {
    readonly id: string;
    readonly title: string;
    readonly source: RunSource;
    readonly now: IsoTime;
  },
): ConversationRow {
  return db
    .insert(conversations)
    .values({
      id: input.id,
      title: input.title,
      source: input.source,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .get();
}

export function getConversation(db: DbExecutor, id: string): ConversationRow | undefined {
  return db.select().from(conversations).where(eq(conversations.id, id)).get();
}

export type ConversationListOptions = {
  /** Matches the title or the text of any message (case-insensitive for ASCII). */
  readonly q?: string | undefined;
  /** false (default): active conversations; true: archived ones. */
  readonly archived?: boolean | undefined;
  readonly cursor?: Cursor | undefined;
  readonly limit?: number | undefined;
};

/** Newest activity first. */
export function listConversations(
  db: DbExecutor,
  options: ConversationListOptions = {},
): { readonly rows: readonly ConversationRow[]; readonly nextCursor: string | null } {
  const limit = clampLimit(options.limit);
  const conditions = [
    options.archived === true
      ? isNotNull(conversations.archivedAt)
      : isNull(conversations.archivedAt),
  ];
  const q = options.q?.trim();
  if (q) {
    const pattern = likeContains(q);
    const matchesMessage = sql`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.conversationId} = ${conversations.id} AND ${messages.text} LIKE ${pattern} ESCAPE '\\')`;
    const matches = or(sql`${conversations.title} LIKE ${pattern} ESCAPE '\\'`, matchesMessage);
    if (matches !== undefined) conditions.push(matches);
  }
  if (options.cursor) {
    conditions.push(afterCursor(conversations.updatedAt, conversations.id, options.cursor));
  }
  const rows = db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit + 1)
    .all();
  return toPage(rows, limit, (row) => ({ at: row.updatedAt, id: row.id }));
}

export function updateConversation(
  db: DbExecutor,
  id: string,
  update: { readonly title?: string | undefined; readonly archived?: boolean | undefined },
  now: IsoTime,
): ConversationRow | undefined {
  const values: Partial<typeof conversations.$inferInsert> = { updatedAt: now };
  if (update.title !== undefined) values.title = update.title;
  if (update.archived !== undefined) values.archivedAt = update.archived ? now : null;
  return db.update(conversations).set(values).where(eq(conversations.id, id)).returning().get();
}

/** Sets the title only while it is still blank (the first message names the chat). */
export function nameConversationIfBlank(
  db: DbExecutor,
  id: string,
  title: string,
  now: IsoTime,
): void {
  db.update(conversations)
    .set({ title, updatedAt: now })
    .where(and(eq(conversations.id, id), eq(conversations.title, "")))
    .run();
}

export function setConversationStatus(
  db: DbExecutor,
  id: string,
  status: ConversationStatus,
  now: IsoTime,
): void {
  db.update(conversations).set({ status, updatedAt: now }).where(eq(conversations.id, id)).run();
}

export function setConversationSession(db: DbExecutor, id: string, sdkSessionId: string): void {
  db.update(conversations).set({ sdkSessionId }).where(eq(conversations.id, id)).run();
}

/** Adds a run's usage delta to the conversation totals. */
export function addConversationUsage(
  db: DbExecutor,
  id: string,
  delta: { readonly costUsd: number; readonly inputTokens: number; readonly outputTokens: number },
): void {
  db.update(conversations)
    .set({
      totalCostUsd: sql`${conversations.totalCostUsd} + ${delta.costUsd}`,
      inputTokens: sql`${conversations.inputTokens} + ${delta.inputTokens}`,
      outputTokens: sql`${conversations.outputTokens} + ${delta.outputTokens}`,
    })
    .where(eq(conversations.id, id))
    .run();
}

/** Summaries with the running run and the number of pending approvals, in input order. */
export function conversationSummaries(
  db: DbExecutor,
  rows: readonly ConversationRow[],
): ConversationSummary[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const running = new Map<string, string>();
  for (const run of db
    .select({ id: runs.id, conversationId: runs.conversationId })
    .from(runs)
    .where(and(inArray(runs.conversationId, ids), eq(runs.status, "running")))
    .orderBy(desc(runs.startedAt))
    .all()) {
    if (!running.has(run.conversationId)) running.set(run.conversationId, run.id);
  }
  const pending = new Map<string, number>();
  const consequences = new Map<string, string>();
  for (const approval of db
    .select({ conversationId: approvals.conversationId, consequence: approvals.consequence })
    .from(approvals)
    .where(and(inArray(approvals.conversationId, ids), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.requestedAt), desc(sql`rowid`))
    .all()) {
    pending.set(approval.conversationId, (pending.get(approval.conversationId) ?? 0) + 1);
    if (!consequences.has(approval.conversationId)) {
      consequences.set(approval.conversationId, approval.consequence);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    source: row.source,
    status: row.status,
    activeRunId: running.get(row.id) ?? null,
    pendingApprovals: pending.get(row.id) ?? 0,
    pendingConsequence: consequences.get(row.id) ?? null,
    totalCostUsd: row.totalCostUsd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }));
}

export function conversationSummary(db: DbExecutor, row: ConversationRow): ConversationSummary {
  const [summary] = conversationSummaries(db, [row]);
  if (summary === undefined) throw new Error("unreachable: one summary per row");
  return summary;
}

export function conversationPage(
  db: DbExecutor,
  options: ConversationListOptions,
): Page<ConversationSummary> {
  const { rows, nextCursor } = listConversations(db, options);
  return { items: conversationSummaries(db, rows), nextCursor };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}
