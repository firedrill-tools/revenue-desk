// Input shapes of the Slack tools, shared by the tools and the classifier.

import { z } from "zod";
import { identifier, isoTimestamp } from "../shared/schema.js";

export const SLACK_ID = {
  /** Public (C), private (G) and direct (D) conversation ids. */
  channel: /^[CGD][A-Z0-9]{2,}$/,
  user: /^[UW][A-Z0-9]{2,}$/,
  /** A message timestamp, e.g. 1727512345.000200. */
  ts: /^\d{9,11}\.\d{1,6}$/,
} as const;

const channelId = identifier(
  SLACK_ID.channel,
  "The channel id (C…, G… or D…), as returned by list_channels.",
);
const cursor = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe("Cursor for the next page: pass next_cursor from the previous result.");

export const SLACK_INPUTS = {
  list_channels: {
    include_private: z
      .boolean()
      .default(false)
      .describe("Also list private channels the bot belongs to (needs the groups:read scope)."),
    name_contains: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("Keep only channels whose name contains this text."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Channels per page (default 200)."),
    cursor,
  },
  read_channel: {
    channel: channelId,
    after: isoTimestamp(
      "Only messages after this time (YYYY-MM-DD or ISO 8601 date-time).",
    ).optional(),
    before: isoTimestamp(
      "Only messages before this time (YYYY-MM-DD or ISO 8601 date-time).",
    ).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(30)
      .describe("Messages per page, newest first (default 30)."),
    cursor,
  },
  read_thread: {
    channel: channelId,
    thread_ts: identifier(SLACK_ID.ts, "The ts of the thread's parent message."),
    limit: z.number().int().min(1).max(200).default(50).describe("Replies per page (default 50)."),
    cursor,
  },
  find_user: {
    user_id: identifier(SLACK_ID.user, "A Slack user id (U… or W…).").optional(),
    query: z
      .string()
      .min(2)
      .max(100)
      .optional()
      .describe("Name, display name or email to search for. Give user_id or query."),
  },
  post_message: {
    channel: z
      .string()
      .regex(/^(?:#?[A-Za-z0-9][A-Za-z0-9._-]{0,79}|[CGDU][A-Z0-9]{2,})$/)
      .describe(
        "Where to post: a channel name like #billing, or a channel id. Posting outside the " +
          "workspace's allowed channels needs the user's approval.",
      ),
    text: z
      .string()
      .min(1)
      .max(4000)
      .describe("The message, in Slack mrkdwn. Do not mention @channel or @here unless asked."),
    thread_ts: identifier(SLACK_ID.ts, "Reply in the thread of this message ts.").optional(),
  },
  add_reaction: {
    channel: channelId,
    timestamp: identifier(SLACK_ID.ts, "The ts of the message to react to."),
    name: z
      .string()
      .regex(/^[a-z0-9_+'-]{1,100}$/)
      .describe("Emoji name without colons, e.g. white_check_mark."),
  },
} as const;

export const postMessageInput = z.object(SLACK_INPUTS.post_message);

/** "#Billing", "billing" -> "billing"; ids keep their case. */
export function normaliseChannel(channel: string): string {
  const trimmed = channel.trim();
  if (/^[CGDU][A-Z0-9]{2,}$/.test(trimmed)) return trimmed;
  return trimmed.replace(/^#/, "").toLowerCase();
}

/**
 * How a channel is sent to Slack and shown on a card: "#billing" for a name
 * (Slack channel names are lower case), or the id itself.
 */
export function channelLabel(channel: string): string {
  const normalised = normaliseChannel(channel);
  return /^[CGDU][A-Z0-9]{2,}$/.test(normalised) ? normalised : `#${normalised}`;
}

const BROADCAST =
  /<!(?:channel|here|everyone)(?:\|[^>]*)?>|(?:^|[\s(])@(?:channel|here|everyone)\b/i;

/** True when a message would notify a whole channel or workspace. */
export function mentionsEveryone(text: string): boolean {
  return BROADCAST.test(text);
}
