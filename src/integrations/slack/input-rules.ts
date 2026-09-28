// Slack formatting the post_message schema cannot state.
//
// In the live runs the agent posted "@Sam" (plain text, which notifies
// nobody) and "<@71001>" (a HubSpot owner id in Slack's mention syntax, which
// renders as a broken mention). A mention must be <@U…> or <@W…> with a
// Slack user id from find_user. The gateway checks this before the post
// (InputCheckSource, src/gateway/catalog.ts), so the call is rejected
// without reaching Slack and the message says how to fix it. Broadcasts
// (@channel, @here, @everyone) are left to the classifier, which asks.

import type { JsonObject } from "../../contracts/json.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import { str } from "../shared/json.js";
import { SLACK_ID } from "./schemas.js";

const MENTION = /<@([^>|]*)(?:\|[^>]*)?>/g;
/** "@Sam" at the start or after a space or bracket: not an email address, not a broadcast. */
const PLAIN_MENTION = /(?:^|[\s(])@([A-Za-z][\w.-]*)/g;
const BROADCASTS = new Set(["channel", "here", "everyone"]);

/** Issues of a Slack call that satisfies its schema; empty when the post would render as meant. */
export function checkSlackInput(tool: string, input: JsonObject): readonly SchemaIssue[] {
  if (tool !== "post_message") return [];
  const text = str(input, "text");
  if (text === undefined) return [];
  const issues: SchemaIssue[] = [];
  for (const [whole, id = ""] of text.matchAll(MENTION)) {
    if (!SLACK_ID.user.test(id)) {
      issues.push({
        path: "/text",
        message: `mentions ${whole}, which is not a Slack user id (U… or W…): find the person with find_user and use their id, or write their name without a mention`,
      });
    }
  }
  for (const [, name = ""] of text.matchAll(PLAIN_MENTION)) {
    if (BROADCASTS.has(name.toLowerCase())) continue;
    issues.push({
      path: "/text",
      message: `has a plain @${name}, which mentions nobody in Slack: find the person with find_user and write <@USERID>, or write the name without @`,
    });
  }
  return issues;
}
