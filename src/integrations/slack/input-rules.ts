// Slack rules the SLACK_SEND_MESSAGE schema cannot state (InputCheckSource,
// src/gateway/catalog.ts). They run before any policy, so a post that breaks
// one is rejected without reaching Slack and the message says how to fix it.
//
// - The message is `markdown_text`: Slack renders standard Markdown there
//   (headings, bold, lists, tables). Block Kit `blocks` can carry buttons and
//   layouts the approval card cannot show as they appear, so they are refused,
//   and so is `fallback_text`: Slack shows it in notifications and previews,
//   and the card shows only the message.
// - In the live runs the agent posted "@Sam" (plain text, which notifies
//   nobody) and "<@71001>" (a HubSpot owner id in Slack's mention syntax,
//   which renders as a broken mention). A mention must be <@U…> or <@W…>
//   with a Slack user id from a user search.
// Broadcasts (@channel, <!here>, …) are left to the classifier, which asks.

import type { JsonObject } from "../../contracts/json.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import { field, str } from "../shared/json.js";
import { MENTION_START, SLACK_ID } from "./channels.js";

const MENTION = /<@([^>|]*)(?:\|[^>]*)?>/g;
/** "@Sam" or "*@Sam*", not inside a word or an email address; broadcasts are skipped below. */
const PLAIN_MENTION = new RegExp(String.raw`${MENTION_START}([A-Za-z][\w.-]*)`, "g");
const BROADCASTS = new Set(["channel", "here", "everyone"]);

/** Issues of a Slack call that satisfies its schema; empty when the post renders as meant. */
export function checkSlackInput(tool: string, input: JsonObject): readonly SchemaIssue[] {
  if (tool !== "SLACK_SEND_MESSAGE") return [];
  const issues: SchemaIssue[] = [];
  const blocks = field(input, "blocks");
  if (blocks !== undefined && blocks !== null) {
    issues.push({
      path: "/blocks",
      message:
        "is not used by Revenue Desk: write the message as Markdown in markdown_text and leave blocks and fallback_text out",
    });
  }
  const fallback = field(input, "fallback_text");
  if (fallback !== undefined && fallback !== null) {
    issues.push({
      path: "/fallback_text",
      message:
        "is not used by Revenue Desk: Slack would show it in notifications instead of the message; leave it out and write the message in markdown_text",
    });
  }
  const text = str(input, "markdown_text");
  if (text === undefined) {
    issues.push({
      path: "/markdown_text",
      message: "is needed: the message itself, as standard Markdown",
    });
    return issues;
  }
  for (const [whole, id = ""] of text.matchAll(MENTION)) {
    if (!SLACK_ID.user.test(id)) {
      issues.push({
        path: "/markdown_text",
        message: `mentions ${whole}, which is not a Slack user id (U… or W…): find the person with a Slack user search and use their id, or write their name without a mention`,
      });
    }
  }
  for (const [, match = ""] of text.matchAll(PLAIN_MENTION)) {
    // "@here." ends a sentence and "_@Sam_" is emphasis: the name stops before them.
    const name = match.replace(/[._-]+$/, "");
    if (BROADCASTS.has(name.toLowerCase())) continue;
    issues.push({
      path: "/markdown_text",
      message: `has a plain @${name}, which mentions nobody in Slack: find the person with a Slack user search and write <@USERID>, or write the name without @`,
    });
  }
  return issues;
}
