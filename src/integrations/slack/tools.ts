// The Slack tools (docs/ARCHITECTURE.md §2).

import type { JsonObject } from "../../contracts/json.js";
import { type ApiTool, type ApiToolOptions, apiTool } from "../shared/api-tool.js";
import { ApiToolError } from "../shared/errors.js";
import { bool, obj, objects, str } from "../shared/json.js";
import { unixSeconds } from "../shared/schema.js";
import { SLACK_PROVIDER, type SlackClient } from "./client.js";
import * as view from "./project.js";
import { channelLabel, SLACK_INPUTS } from "./schemas.js";

/** users.list pages read for a query (200 users each). */
const USER_SEARCH_PAGES = 10;
const USER_SEARCH_MATCHES = 20;

function matchesUser(user: JsonObject, needle: string): boolean {
  const profile = obj(user, "profile");
  const haystack = [
    str(user, "name"),
    str(user, "real_name"),
    str(profile, "display_name"),
    str(profile, "real_name"),
    str(profile, "email"),
  ];
  return haystack.some((value) => value?.toLowerCase().includes(needle) === true);
}

export function createSlackTools(
  client: SlackClient,
  options: Pick<ApiToolOptions, "timezone"> = {},
): readonly ApiTool[] {
  const { timezone } = options;
  const message = (item: JsonObject) => view.message(item, timezone);
  return [
    apiTool({
      name: "list_channels",
      description:
        "List Slack channels the bot can see (public by default), with membership and topic. " +
        "Page with next_cursor.",
      input: SLACK_INPUTS.list_channels,
      readOnly: true,
      async run(args, call) {
        const body = await client.read(
          "conversations.list",
          {
            types: args.include_private ? "public_channel,private_channel" : "public_channel",
            exclude_archived: true,
            limit: args.limit,
            cursor: args.cursor,
          },
          call.signal,
        );
        const needle = args.name_contains?.replace(/^#/, "").toLowerCase();
        const channels = objects(body, "channels")
          .filter((item) => needle === undefined || (str(item, "name") ?? "").includes(needle))
          .map(view.channel);
        return { channels, next_cursor: view.nextCursor(body) };
      },
    }),
    apiTool({
      name: "read_channel",
      description:
        "Read recent messages of a Slack channel, newest first, optionally within a time " +
        "window. The bot must be a member of the channel.",
      input: SLACK_INPUTS.read_channel,
      readOnly: true,
      async run(args, call) {
        const body = await client.read(
          "conversations.history",
          {
            channel: args.channel,
            oldest: args.after === undefined ? undefined : unixSeconds(args.after),
            latest: args.before === undefined ? undefined : unixSeconds(args.before),
            limit: args.limit,
            cursor: args.cursor,
          },
          call.signal,
        );
        return {
          messages: objects(body, "messages").map(message),
          has_more: bool(body, "has_more") ?? false,
          next_cursor: view.nextCursor(body),
        };
      },
    }),
    apiTool({
      name: "read_thread",
      description: "Read a Slack thread: its parent message and replies, oldest first.",
      input: SLACK_INPUTS.read_thread,
      readOnly: true,
      async run(args, call) {
        const body = await client.read(
          "conversations.replies",
          { channel: args.channel, ts: args.thread_ts, limit: args.limit, cursor: args.cursor },
          call.signal,
        );
        return {
          messages: objects(body, "messages").map(message),
          has_more: bool(body, "has_more") ?? false,
          next_cursor: view.nextCursor(body),
        };
      },
    }),
    apiTool({
      name: "find_user",
      description:
        "Find a Slack user by id, or search by name, display name or email. Returns ids to " +
        "mention people as <@U123>.",
      input: SLACK_INPUTS.find_user,
      readOnly: true,
      async run(args, call) {
        if (args.user_id !== undefined) {
          const body = await client.read("users.info", { user: args.user_id }, call.signal);
          const found = obj(body, "user");
          return { users: found === undefined ? [] : [view.user(found)], complete: true };
        }
        if (args.query === undefined) {
          throw new ApiToolError(SLACK_PROVIDER, "Give user_id or query.", {
            code: "invalid_request",
          });
        }
        const needle = args.query.toLowerCase();
        const users: JsonObject[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < USER_SEARCH_PAGES; page += 1) {
          const body = await client.read("users.list", { limit: 200, cursor }, call.signal);
          for (const candidate of objects(body, "members")) {
            if (matchesUser(candidate, needle)) users.push(view.user(candidate));
          }
          cursor = view.nextCursor(body) ?? undefined;
          if (cursor === undefined || users.length >= USER_SEARCH_MATCHES) {
            return { users: users.slice(0, USER_SEARCH_MATCHES), complete: cursor === undefined };
          }
        }
        return { users: users.slice(0, USER_SEARCH_MATCHES), complete: false };
      },
    }),
    apiTool({
      name: "post_message",
      description:
        "Post a message to a Slack channel, or reply in a thread. The text is Slack mrkdwn, " +
        "not Markdown: *bold*, bullets, <@USERID> mentions; tables and # headings are not " +
        "rendered. Post about an action only after it succeeded. Posting to the workspace's " +
        "allowed channels is automatic; anywhere else, or a message that notifies everyone, " +
        "needs the user's approval.",
      input: SLACK_INPUTS.post_message,
      readOnly: false,
      async run(args, call) {
        const body = await client.write(
          "chat.postMessage",
          {
            channel: channelLabel(args.channel),
            text: args.text,
            thread_ts: args.thread_ts,
            unfurl_links: false,
            unfurl_media: false,
          },
          call.signal,
        );
        const ts = str(body, "ts");
        return {
          channel: str(body, "channel") ?? channelLabel(args.channel),
          ts: ts ?? null,
          time: view.isoFromTs(ts, timezone) ?? null,
        };
      },
    }),
    apiTool({
      name: "add_reaction",
      description: "Add an emoji reaction to a Slack message, e.g. to mark it handled.",
      input: SLACK_INPUTS.add_reaction,
      readOnly: false,
      async run(args, call) {
        try {
          await client.write(
            "reactions.add",
            { channel: args.channel, timestamp: args.timestamp, name: args.name },
            call.signal,
          );
          return { added: true, already_reacted: false };
        } catch (error) {
          if (error instanceof ApiToolError && error.code === "already_reacted") {
            return { added: false, already_reacted: true };
          }
          throw error;
        }
      },
    }),
  ];
}
