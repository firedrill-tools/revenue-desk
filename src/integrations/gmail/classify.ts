// Classifies Gmail (Composio) calls (docs/ARCHITECTURE.md §2, §7): reads are
// read; drafts and labels change only the user's own mailbox (internal_write);
// sending a draft and replying reach other people (outbound). Moving a message
// to Trash or Spam through labels is destructive.
//
// Denied (null): another mailbox than the user's own (user_id other than
// "me"), attachments (the agent has no files to attach, so one can only come
// from somewhere unexpected), and recipients that are not email addresses.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { parseAddress } from "../shared/email.js";
import { field, str, strings } from "../shared/json.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { listOf, preview } from "../shared/text.js";
import { GMAIL_PROFILE } from "./profile.js";

type Recipients = { readonly to: string[]; readonly cc: string[]; readonly bcc: string[] };

const DESTRUCTIVE_LABELS = new Set(["TRASH", "SPAM"]);

function ownMailbox(input: JsonObject): boolean {
  const userId = field(input, "user_id");
  return userId === undefined || userId === null || userId === "me";
}

function hasAttachment(input: JsonObject): boolean {
  const value = field(input, "attachment");
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Addresses of a list field; "me" (the user) is skipped; null when any entry is not an address. */
function addresses(input: JsonObject, key: string): string[] | null {
  const value = field(input, key);
  if (value === undefined || value === null) return [];
  const items = typeof value === "string" ? [value] : strings(input, key);
  if (items === undefined) return null;
  const out: string[] = [];
  for (const item of items) {
    if (item.trim() === "" || item.trim().toLowerCase() === "me") continue;
    const address = parseAddress(item);
    if (address === null) return null;
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

function recipientsOf(input: JsonObject): Recipients | null {
  const primary = addresses(input, "recipient_email");
  const extra = addresses(input, "extra_recipients");
  const cc = addresses(input, "cc");
  const bcc = addresses(input, "bcc");
  if (primary === null || extra === null || cc === null || bcc === null) return null;
  return { to: [...primary, ...extra.filter((a) => !primary.includes(a))], cc, bcc };
}

function recipientFacts(recipients: Recipients): ApprovalFact[] {
  const facts: ApprovalFact[] = [];
  if (recipients.to.length > 0) facts.push({ label: "To", value: recipients.to.join(", ") });
  if (recipients.cc.length > 0) facts.push({ label: "Cc", value: recipients.cc.join(", ") });
  if (recipients.bcc.length > 0) facts.push({ label: "Bcc", value: recipients.bcc.join(", ") });
  return facts;
}

function everyone(recipients: Recipients): string[] {
  return [...recipients.to, ...recipients.cc, ...recipients.bcc];
}

function createDraft(input: JsonObject): Classification | null {
  const recipients = recipientsOf(input);
  if (recipients === null) return null;
  const all = everyone(recipients);
  const facts = recipientFacts(recipients);
  const subject = str(input, "subject");
  if (subject !== undefined) facts.push({ label: "Subject", value: preview(subject, 120) });
  const thread = str(input, "thread_id");
  if (thread !== undefined) facts.push({ label: "Thread", value: thread });
  const body = str(input, "body") ?? str(input, "message_body");
  if (body !== undefined) facts.push({ label: "Body", value: preview(body, 300) });
  return {
    actionClass: "internal_write",
    operation: "gmail.drafts.create",
    title: "Create Gmail draft",
    details: {
      consequence:
        all.length === 0
          ? "Create a Gmail draft (not sent)"
          : `Create a Gmail draft to ${listOf(all)} (not sent)`,
      facts,
      ...(all.length === 0 ? {} : { recipients: all }),
    },
  };
}

function label(input: JsonObject): Classification | null {
  const message = str(input, "message_id");
  const add = strings(input, "add_label_ids") ?? [];
  const remove = strings(input, "remove_label_ids") ?? [];
  if (message === undefined) return null;
  const facts: ApprovalFact[] = [{ label: "Message", value: message }];
  if (add.length > 0) facts.push({ label: "Add labels", value: add.join(", ") });
  if (remove.length > 0) facts.push({ label: "Remove labels", value: remove.join(", ") });
  const destructive = add.filter((id) => DESTRUCTIVE_LABELS.has(id.toUpperCase()));
  if (destructive.length > 0) {
    return {
      actionClass: "destructive",
      operation: "gmail.messages.label",
      title: "Move Gmail message to Trash or Spam",
      details: {
        consequence: `Move Gmail message ${message} to ${listOf(destructive)}`,
        facts,
        recordIds: [message],
      },
    };
  }
  return {
    actionClass: "internal_write",
    operation: "gmail.messages.label",
    title: "Label Gmail message",
    details: {
      consequence: `Change labels of Gmail message ${message}`,
      facts,
      recordIds: [message],
    },
  };
}

function sendDraft(input: JsonObject): Classification | null {
  const draft = str(input, "draft_id");
  if (draft === undefined) return null;
  return {
    actionClass: "outbound",
    operation: "gmail.drafts.send",
    title: "Send Gmail draft",
    details: {
      consequence: `Send Gmail draft ${draft} to the recipients saved in it`,
      facts: [
        { label: "Draft", value: draft },
        { label: "Recipients", value: "As saved in the draft" },
      ],
      recordIds: [draft],
    },
  };
}

function reply(input: JsonObject): Classification | null {
  const thread = str(input, "thread_id");
  const recipients = recipientsOf(input);
  if (thread === undefined || recipients === null) return null;
  const all = everyone(recipients);
  if (all.length === 0) return null;
  const facts = recipientFacts(recipients);
  facts.push({ label: "Thread", value: thread });
  const body = str(input, "message_body");
  if (body !== undefined) facts.push({ label: "Message", value: preview(body, 300) });
  return {
    actionClass: "outbound",
    operation: "gmail.threads.reply",
    title: "Reply in Gmail thread",
    details: {
      consequence: `Send a reply in Gmail to ${listOf(all)}`,
      facts,
      recipients: all,
      recordIds: [thread],
    },
  };
}

export function classifyGmail(
  tool: string,
  input: JsonObject,
  _settings: ClassifierSettings,
): Classification | null {
  const spec = specOf(GMAIL_PROFILE, tool);
  if (spec === undefined || !ownMailbox(input) || hasAttachment(input)) return null;
  switch (spec.name) {
    case "GMAIL_CREATE_EMAIL_DRAFT":
      return createDraft(input);
    case "GMAIL_ADD_LABEL_TO_EMAIL":
      return label(input);
    case "GMAIL_SEND_DRAFT":
      return sendDraft(input);
    case "GMAIL_REPLY_TO_THREAD":
      return reply(input);
    default:
      return fromSpec(spec);
  }
}
