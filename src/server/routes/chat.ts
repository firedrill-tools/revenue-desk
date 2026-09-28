// POST /api/chat and GET /api/chat/:conversationId/stream (docs/ARCHITECTURE.md §6).
//
// Both answer with the run's UI message stream: the replay from the start of
// the assistant message, then live chunks. A client disconnect detaches only
// that client; Stop is POST /api/runs/:id/stop.

import { createUIMessageStreamResponse } from "ai";
import type { Hono } from "hono";
import { z } from "zod";
import { API_PATHS } from "../../contracts/api.js";
import { apiError, parseJsonBody } from "../http.js";
import type { ApiServices } from "../services.js";

export const MAX_MESSAGE_TEXT_LENGTH = 32_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

const chatRequestSchema = z.object({
  conversationId: z.string().regex(ID, "Expected a conversation id."),
  message: z.object({
    id: z.string().regex(ID, "Expected a message id."),
    role: z.literal("user"),
    parts: z
      .array(
        z.looseObject({
          type: z.string(),
          text: z.string().max(MAX_MESSAGE_TEXT_LENGTH).optional(),
        }),
      )
      .min(1)
      .max(50),
  }),
});

export function registerChatRoutes(app: Hono, services: ApiServices): void {
  app.post(API_PATHS.chat, async (c) => {
    const parsed = await parseJsonBody(c, chatRequestSchema);
    if (!parsed.ok) return parsed.response;
    const { conversationId, message } = parsed.data;
    const texts: string[] = [];
    for (const part of message.parts) {
      if (part.type !== "text" || part.text === undefined) {
        return apiError(c, "invalid_request", "Only text parts are supported in a chat message.");
      }
      texts.push(part.text);
    }
    const started = services.chat.startTurn(conversationId, { messageId: message.id, texts });
    if (!started.ok) return apiError(c, started.code, started.message);
    return createUIMessageStreamResponse({ stream: started.run.channel.subscribe() });
  });

  app.get(API_PATHS.chatStream, (c) => {
    const run = services.registry.forConversation(c.req.param("conversationId"));
    if (run === undefined) return c.body(null, 204);
    return createUIMessageStreamResponse({ stream: run.channel.subscribe() });
  });
}
