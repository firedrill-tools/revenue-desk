// The Slack tools of the composio profile (docs/ARCHITECTURE.md §2). Slugs
// and access levels equal COMPOSIO_ALLOWLISTS.slack in composio/session.ts;
// their schemas are captured in test/fixtures/surfaces/composio-direct.json.

import type { ActionClass, ToolSpec } from "../../contracts/integration.js";
import { defineProfile } from "../shared/profile.js";

const spec = (
  name: string,
  operation: ToolSpec["operation"],
  title: string,
  baseClass: ActionClass,
): ToolSpec => ({
  name,
  upstream: name,
  operation,
  title,
  baseClass,
  readOnly: baseClass === "read",
});

export const SLACK_PROFILE = defineProfile("composio", "slack", [
  spec("SLACK_FIND_CHANNELS", "slack.conversations.find", "Find Slack channels", "read"),
  spec("SLACK_LIST_ALL_CHANNELS", "slack.conversations.list", "List Slack channels", "read"),
  spec(
    "SLACK_FETCH_CONVERSATION_HISTORY",
    "slack.conversations.history",
    "Read Slack channel",
    "read",
  ),
  spec(
    "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
    "slack.conversations.replies",
    "Read Slack thread",
    "read",
  ),
  spec("SLACK_FIND_USERS", "slack.users.find", "Find Slack user", "read"),
  spec(
    "SLACK_ADD_REACTION_TO_AN_ITEM",
    "slack.reactions.add",
    "Add reaction in Slack",
    "internal_write",
  ),
  spec("SLACK_SEND_MESSAGE", "slack.chat.post_message", "Post message in Slack", "outbound"),
]);
