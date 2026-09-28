// Classifies Gmail (Composio) calls (docs/ARCHITECTURE.md §2, §7): reads are
// read; drafts and labels change only the user's own mailbox (internal_write);
// sending a draft and replying reach other people (outbound). Moving a message
// to Trash or Spam through labels is destructive.
//
// Denied (null): another mailbox than the user's own (user_id other than
// "me"), attachments (the agent has no files to attach, so one can only come
// from somewhere unexpected), and recipients that are not email addresses.
//
// Sending a draft: its input holds only the draft id, but "no email to the
// wrong customer" means the card must name who receives it. The recipients
// come from the same run's GMAIL_CREATE_EMAIL_DRAFT of that draft
// (GmailDraftMemory in run-memory.ts). No allowlisted read tool returns a
// draft by id (the fetch, thread and label tools return messages and
// threads, which do not carry draft ids), so a draft the run did not create
// cannot be looked up: its card says plainly that the recipients could not
// be confirmed.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { parseAddress } from "../shared/email.js";
import { asObject, field, obj, str, strings } from "../shared/json.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { listOf, preview } from "../shared/text.js";
import { GMAIL_PROFILE } from "./profile.js";

export type Recipients = {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
};

/** A draft this run created: who it goes to, as the create call named them. */
export type KnownDraft = {
  readonly draftId: string;
  readonly recipients: Recipients;
  readonly subject: string | null;
  readonly threadId: string | null;
};

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

export const UNCONFIRMED_RECIPIENTS =
  "Not confirmed: this draft was not created in this run. Check it in Gmail before approving.";

/**
 * Sending draft `draft_id`. With the draft this run created, the card names
 * its recipients; otherwise it says they could not be confirmed. Outbound
 * either way.
 */
export function classifySendDraft(
  input: JsonObject,
  known: KnownDraft | null,
): Classification | null {
  const draft = str(input, "draft_id");
  if (draft === undefined) return null;
  const confirmed = known !== null && known.draftId === draft ? known : null;
  if (confirmed === null) {
    return {
      actionClass: "outbound",
      operation: "gmail.drafts.send",
      title: "Send Gmail draft",
      details: {
        consequence: `Send Gmail draft ${draft}. Its recipients could not be confirmed.`,
        facts: [
          { label: "Draft", value: draft },
          { label: "Recipients", value: UNCONFIRMED_RECIPIENTS },
        ],
        recordIds: [draft],
      },
    };
  }
  const all = everyone(confirmed.recipients);
  const facts = recipientFacts(confirmed.recipients);
  if (confirmed.subject !== null) {
    facts.push({ label: "Subject", value: preview(confirmed.subject, 120) });
  }
  if (confirmed.threadId !== null) facts.push({ label: "Thread", value: confirmed.threadId });
  facts.push({ label: "Draft", value: draft });
  return {
    actionClass: "outbound",
    operation: "gmail.drafts.send",
    title: "Send Gmail draft",
    details: {
      consequence: `Send the Gmail draft to ${listOf(all)}`,
      facts,
      recipients: all,
      recordIds: [draft],
    },
  };
}

/** The draft id in a GMAIL_CREATE_EMAIL_DRAFT result (Composio's `{successful, data}` or bare). */
function createdDraftId(output: JsonValue): string | undefined {
  const top = asObject(output);
  if (top === undefined || field(top, "successful") === false) return undefined;
  const data = obj(top, "data") ?? top;
  const nested = obj(data, "response_data") ?? obj(data, "draft");
  for (const candidate of [data, nested, top]) {
    const id = str(candidate, "id") ?? str(candidate, "draft_id") ?? str(candidate, "draftId");
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The draft a successful GMAIL_CREATE_EMAIL_DRAFT call created, from its
 * input (recipients, subject, thread) and its result (the draft id). Null
 * when either is missing or the recipients are not addresses.
 */
export function draftFromCreate(input: JsonObject, output: JsonValue): KnownDraft | null {
  const draftId = createdDraftId(output);
  const recipients = recipientsOf(input);
  if (draftId === undefined || recipients === null || everyone(recipients).length === 0) {
    return null;
  }
  return {
    draftId,
    recipients,
    subject: str(input, "subject") ?? null,
    threadId: str(input, "thread_id") ?? null,
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
      // Without the run's memory of its drafts (GmailDraftMemory) nothing confirms them.
      return classifySendDraft(input, null);
    case "GMAIL_REPLY_TO_THREAD":
      return reply(input);
    default:
      return fromSpec(spec);
  }
}
