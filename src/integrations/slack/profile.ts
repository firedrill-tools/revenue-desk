// The slack-api profile: the frozen §2 table of docs/ARCHITECTURE.md.

import type { ToolSpec } from "../../contracts/integration.js";
import { defineProfile } from "../shared/profile.js";

const read = (
  name: string,
  method: string,
  operation: ToolSpec["operation"],
  title: string,
): ToolSpec => ({
  name,
  upstream: `POST /api/${method}`,
  operation,
  title,
  baseClass: "read",
  readOnly: true,
});

export const SLACK_PROFILE = defineProfile("slack-api", "slack", [
  read("list_channels", "conversations.list", "slack.conversations.list", "List Slack channels"),
  read(
    "read_channel",
    "conversations.history",
    "slack.conversations.history",
    "Read Slack channel",
  ),
  read("read_thread", "conversations.replies", "slack.conversations.replies", "Read Slack thread"),
  read("find_user", "users.info, users.list", "slack.users.lookup", "Find Slack user"),
  {
    name: "post_message",
    upstream: "POST /api/chat.postMessage",
    operation: "slack.chat.post_message",
    title: "Post message in Slack",
    baseClass: "outbound",
    readOnly: false,
  },
  {
    name: "add_reaction",
    upstream: "POST /api/reactions.add",
    operation: "slack.reactions.add",
    title: "Add reaction in Slack",
    baseClass: "internal_write",
    readOnly: false,
  },
]);
