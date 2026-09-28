// Chat messages (docs/ARCHITECTURE.md §8): the rendered UIMessage parts, in
// conversation order (seq), with plain text for search. Transient data parts
// never reach this table: the AI SDK reducer does not add them to a message.

import { and, asc, eq, max } from "drizzle-orm";
import type { ChatMessageMetadata, ChatUIMessage } from "../../contracts/api.js";
import { type ChatMessageRow, messages } from "../schema.js";
import type { DbExecutor, IsoTime } from "./types.js";

type Parts = ChatUIMessage["parts"];

/** The text parts joined by blank lines: what search matches. */
export function messageText(parts: Parts): string {
  return parts
    .flatMap((part) => (part.type === "text" && part.text.length > 0 ? [part.text] : []))
    .join("\n\n");
}

function nextSeq(db: DbExecutor, conversationId: string): number {
  const row = db
    .select({ last: max(messages.seq) })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .get();
  return row?.last === null || row?.last === undefined ? 0 : row.last + 1;
}

export function insertUserMessage(
  db: DbExecutor,
  input: {
    readonly id: string;
    readonly conversationId: string;
    readonly runId: string | null;
    readonly parts: Parts;
    readonly now: IsoTime;
  },
): void {
  db.insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      runId: input.runId,
      role: "user",
      partsJson: [...input.parts],
      metadataJson: null,
      text: messageText(input.parts),
      seq: nextSeq(db, input.conversationId),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run();
}

/**
 * Inserts the assistant message at the end of the conversation, or replaces
 * its parts and metadata when it exists (persisted again at every step end,
 * approval request and run end).
 */
export function upsertAssistantMessage(
  db: DbExecutor,
  input: {
    readonly conversationId: string;
    readonly runId: string | null;
    readonly message: ChatUIMessage;
    readonly now: IsoTime;
  },
): void {
  const { message } = input;
  const values = {
    partsJson: [...message.parts],
    metadataJson: message.metadata ?? null,
    text: messageText(message.parts),
    updatedAt: input.now,
  };
  const existing = getMessageRow(db, message.id);
  if (existing !== undefined) {
    if (existing.conversationId !== input.conversationId || existing.role !== "assistant") {
      throw new Error(`Message ${message.id} belongs to another conversation or role`);
    }
    db.update(messages).set(values).where(eq(messages.id, message.id)).run();
    return;
  }
  db.insert(messages)
    .values({
      id: message.id,
      conversationId: input.conversationId,
      runId: input.runId,
      role: "assistant",
      seq: nextSeq(db, input.conversationId),
      createdAt: input.now,
      ...values,
    })
    .run();
}

export function getMessageRow(db: DbExecutor, id: string): ChatMessageRow | undefined {
  return db.select().from(messages).where(eq(messages.id, id)).get();
}

export function toChatMessage(row: ChatMessageRow): ChatUIMessage {
  const metadata: ChatMessageMetadata | null = row.metadataJson;
  return {
    id: row.id,
    role: row.role,
    parts: row.partsJson,
    ...(metadata === null ? {} : { metadata }),
  };
}

/** The conversation's messages in order, leaving out the ids in `exclude`. */
export function listMessages(
  db: DbExecutor,
  conversationId: string,
  options: { readonly exclude?: ReadonlySet<string> } = {},
): ChatUIMessage[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq))
    .all()
    .filter((row) => !options.exclude?.has(row.id))
    .map(toChatMessage);
}

/** Replaces an assistant message's parts and metadata (boot recovery). */
export function replaceAssistantMessage(
  db: DbExecutor,
  id: string,
  message: Pick<ChatUIMessage, "parts" | "metadata">,
  now: IsoTime,
): void {
  db.update(messages)
    .set({
      partsJson: [...message.parts],
      metadataJson: message.metadata ?? null,
      text: messageText(message.parts),
      updatedAt: now,
    })
    .where(and(eq(messages.id, id), eq(messages.role, "assistant")))
    .run();
}
