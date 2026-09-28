// The Gmail tools of the composio profile (docs/ARCHITECTURE.md §2). Slugs and
// access levels equal COMPOSIO_ALLOWLISTS.gmail in composio/session.ts.

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

export const GMAIL_PROFILE = defineProfile("composio", "gmail", [
  spec("GMAIL_FETCH_EMAILS", "gmail.messages.list", "Search Gmail messages", "read"),
  spec("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "gmail.threads.get", "Read Gmail thread", "read"),
  spec("GMAIL_LIST_THREADS", "gmail.threads.list", "List Gmail threads", "read"),
  spec("GMAIL_LIST_LABELS", "gmail.labels.list", "List Gmail labels", "read"),
  spec("GMAIL_CREATE_EMAIL_DRAFT", "gmail.drafts.create", "Create Gmail draft", "internal_write"),
  spec("GMAIL_ADD_LABEL_TO_EMAIL", "gmail.messages.label", "Label Gmail message", "internal_write"),
  spec("GMAIL_SEND_DRAFT", "gmail.drafts.send", "Send Gmail draft", "outbound"),
  spec("GMAIL_REPLY_TO_THREAD", "gmail.threads.reply", "Reply in Gmail thread", "outbound"),
]);
