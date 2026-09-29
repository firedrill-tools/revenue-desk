// Slack rules the SLACK_SEND_MESSAGE schema cannot state (InputCheckSource,
// src/gateway/catalog.ts). They run before any policy, so a post that breaks
// one is rejected without reaching Slack and the message says how to fix it.
//
// - The message is `markdown_text`: Slack renders standard Markdown there
//   (headings, bold, lists, tables). Block Kit `blocks` can carry buttons and
//   layouts the approval card cannot show as they appear, so they are refused.
// - In the live runs the agent posted "@Sam" (plain text, which notifies
//   nobody) and "<@71001>" (a HubSpot owner id in Slack's mention syntax,
//   which renders as a broken mention). A mention must be <@U…> or <@W…>
//   with a Slack user id from a user search.
// Broadcasts (@channel, <!here>, …) are left to the classifier, which asks.

import type { JsonObject } from "../../contracts/json.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import { field, str } from "../shared/json.js";
import { SLACK_ID } from "./channels.js";

const MENTION = /<@([^>|]*)(?:\|[^>]*)?>/g;
/** "@Sam" at the start or after a space or bracket: not an email address, not a broadcast. */
const PLAIN_MENTION = /(?:^|[\s(])@([A-Za-z][\w.-]*)/g;
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
  for (const [, name = ""] of text.matchAll(PLAIN_MENTION)) {
    if (BROADCASTS.has(name.toLowerCase())) continue;
    issues.push({
      path: "/markdown_text",
      message: `has a plain @${name}, which mentions nobody in Slack: find the person with a Slack user search and write <@USERID>, or write the name without @`,
    });
  }
  return issues;
}
