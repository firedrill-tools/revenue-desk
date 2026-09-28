// Slack formatting the post_message schema cannot state.
//
// In the live runs the agent posted "@Sam" (plain text, which notifies
// nobody), "<@71001>" (a HubSpot owner id in Slack's mention syntax, which
// renders as a broken mention) and weekly digests with Markdown tables, which
// Slack shows as rows of pipes. A mention must be <@U…> or <@W…> with a Slack
// user id from find_user, and Markdown that mrkdwn does not render (tables,
// # headings, **double asterisks**) is refused. The gateway checks this
// before the post (InputCheckSource, src/gateway/catalog.ts), so the call is
// rejected without reaching Slack and the message says how to fix it.
// Broadcasts (@channel, @here, @everyone) are left to the classifier, which
// asks. Emoji render, so they are a matter of style for the prompt, not a rule.

import type { JsonObject } from "../../contracts/json.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import { str } from "../shared/json.js";
import { SLACK_ID } from "./schemas.js";

const MENTION = /<@([^>|]*)(?:\|[^>]*)?>/g;
/** "@Sam" at the start or after a space or bracket: not an email address, not a broadcast. */
const PLAIN_MENTION = /(?:^|[\s(])@([A-Za-z][\w.-]*)/g;
const BROADCASTS = new Set(["channel", "here", "everyone"]);
/** A Markdown table's separator row, e.g. "|---|:---:|". */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
const HEADING = /^\s{0,3}#{1,6}\s+\S/m;
const DOUBLE_ASTERISKS = /\*\*[^*\n]+\*\*/;

function unrenderedMarkdown(text: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (TABLE_SEPARATOR.test(text)) {
    issues.push({
      path: "/text",
      message:
        "has a Markdown table, which Slack does not render: write one line per record instead, e.g. • Customer — $1,200.00 — 34 days overdue",
    });
  }
  if (HEADING.test(text)) {
    issues.push({
      path: "/text",
      message:
        "has a Markdown # heading, which Slack shows as plain text: use a *bold* line instead",
    });
  }
  if (DOUBLE_ASTERISKS.test(text)) {
    issues.push({
      path: "/text",
      message:
        "uses **double asterisks**, which Slack shows as they are: use *single asterisks* for bold",
    });
  }
  return issues;
}

/** Issues of a Slack call that satisfies its schema; empty when the post renders as meant. */
export function checkSlackInput(tool: string, input: JsonObject): readonly SchemaIssue[] {
  if (tool !== "post_message") return [];
  const text = str(input, "text");
  if (text === undefined) return [];
  const issues: SchemaIssue[] = unrenderedMarkdown(text);
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
