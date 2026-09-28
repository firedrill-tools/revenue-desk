// Conversations CRUD (docs/ARCHITECTURE.md §9): the rail, search, one
// conversation with its messages, rename and archive. Conversation ids are
// created here, never by the client.

import type { Hono } from "hono";
import { z } from "zod";
import { API_PATHS, type ConversationDetail } from "../../contracts/api.js";
import { pendingApprovalsForConversation } from "../../db/repos/approvals.js";
import {
  conversationPage,
  conversationSummary,
  getConversation,
  insertConversation,
  MAX_TITLE_LENGTH,
  updateConversation,
} from "../../db/repos/conversations.js";
import { listMessages } from "../../db/repos/messages.js";
import { decodeCursor, MAX_PAGE_LIMIT } from "../../db/repos/pagination.js";
import { apiError, parseJsonBody, parseQuery } from "../http.js";
import type { ApiServices } from "../services.js";

const booleanParam = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");
const limitParam = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT);
const title = z.string().trim().max(MAX_TITLE_LENGTH);

const listQuery = z.object({
  q: z.string().max(200).optional(),
  archived: booleanParam.optional(),
  cursor: z.string().max(512).optional(),
  limit: limitParam.optional(),
});

const createBody = z.strictObject({ title: title.optional() });
const updateBody = z.strictObject({ title: title.optional(), archived: z.boolean().optional() });

export function registerConversationRoutes(app: Hono, services: ApiServices): void {
  app.get(API_PATHS.conversations, (c) => {
    const query = parseQuery(c, listQuery);
    if (!query.ok) return query.response;
    const cursor = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
    if (cursor === null) return apiError(c, "invalid_request", "The cursor is not valid.");
    return c.json(
      conversationPage(services.db, {
        q: query.data.q,
        archived: query.data.archived,
        cursor,
        limit: query.data.limit,
      }),
    );
  });

  app.post(API_PATHS.conversations, async (c) => {
    const body = await parseJsonBody(c, createBody);
    if (!body.ok) return body.response;
    const row = insertConversation(services.db, {
      id: services.newId(),
      title: body.data.title ?? "",
      source: "ui",
      now: services.now().toISOString(),
    });
    return c.json({ conversation: conversationSummary(services.db, row) }, 201);
  });

  app.get(API_PATHS.conversation, (c) => {
    const row = getConversation(services.db, c.req.param("conversationId"));
    if (row === undefined) return apiError(c, "not_found", "No conversation has this id.");
    // The active run's assistant message is replayed by the stream endpoint;
    // listing it here too would render it twice after a resume.
    const active = services.registry.forConversation(row.id);
    const detail: ConversationDetail = {
      conversation: conversationSummary(services.db, row),
      messages: listMessages(services.db, row.id, {
        exclude: new Set(active === undefined ? [] : [active.assistantMessageId]),
      }),
      pendingApprovals: pendingApprovalsForConversation(services.db, row.id),
    };
    return c.json(detail);
  });

  app.patch(API_PATHS.conversation, async (c) => {
    const body = await parseJsonBody(c, updateBody);
    if (!body.ok) return body.response;
    const row = updateConversation(
      services.db,
      c.req.param("conversationId"),
      body.data,
      services.now().toISOString(),
    );
    if (row === undefined) return apiError(c, "not_found", "No conversation has this id.");
    return c.json({ conversation: conversationSummary(services.db, row) });
  });
}
