/**
 * The mailbox behind the Composio fake's GMAIL_* tools (the composio
 * profile's Gmail slugs), loaded from test/fixtures/business/gmail.json.
 *
 * Inputs follow the captured Composio schemas exactly (the fake validates
 * them against test/fixtures/surfaces/composio-direct.json before a handler
 * runs). Results are modelled on Composio's Gmail actions: the capture holds
 * input schemas only, so result field names are the fake's best rendering
 * of Gmail API resources, documented per tool below.
 *
 * Every message that leaves the mailbox (a sent draft or a reply) is recorded
 * in `outbox`, so tests can prove who received what, and that nothing was
 * sent without approval.
 */
import type { JsonObject, JsonValue } from "../../../../src/contracts/json.js";
import type { FakeClock } from "../core/clock.js";
import type { GmailFixture } from "../fixtures.js";

export class ToolError extends Error {}

interface MailMessage {
  readonly id: string;
  readonly threadId: string;
  labelIds: string[];
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly date: string;
  readonly body: string;
  readonly isHtml: boolean;
}

/** A message that left the mailbox. */
export interface SentMail {
  readonly messageId: string;
  readonly threadId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly sentAt: string;
  readonly via: "draft" | "reply";
}

/** A draft as the mailbox holds it. */
export interface MailDraft {
  readonly id: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
}

type Args = Readonly<Record<string, JsonValue>>;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class GmailMailbox {
  readonly owner: string;
  readonly outbox: SentMail[] = [];
  private readonly labels: GmailFixture["labels"];
  private readonly messages: MailMessage[] = [];
  private readonly drafts = new Map<string, { readonly messageId: string }>();
  private sequence = 0;

  constructor(
    fixture: GmailFixture,
    private readonly clock: FakeClock,
  ) {
    const data = structuredClone(fixture);
    this.owner = data.mailbox;
    this.labels = data.labels;
    for (const message of data.messages) {
      this.messages.push({ ...message, cc: message.cc ?? [], bcc: [], isHtml: false });
    }
  }

  /** Drafts currently in the mailbox. */
  draftList(): MailDraft[] {
    return [...this.drafts.entries()].map(([id, draft]) => {
      const message = this.message(draft.messageId);
      return {
        id,
        messageId: message.id,
        threadId: message.threadId,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        body: message.body,
      };
    });
  }

  /** Label ids on a message, for assertions. */
  labelsOf(messageId: string): readonly string[] {
    return this.message(messageId).labelIds;
  }

  // --- Tools ------------------------------------------------------------------

  /** GMAIL_FETCH_EMAILS: `{messages, nextPageToken, resultSizeEstimate}`, newest first. */
  fetchEmails(args: Args): JsonObject {
    const labelIds = stringList(args.label_ids);
    const includeSpamTrash = args.include_spam_trash === true;
    const matching = this.search(String(args.query ?? ""), includeSpamTrash).filter((message) =>
      labelIds.every((label) => message.labelIds.includes(label)),
    );
    const { page, next } = paginate(matching, args.page_token, Number(args.max_results ?? 1));
    const idsOnly = args.ids_only === true;
    const full = args.verbose !== false && args.include_payload !== false;
    return {
      messages: page.map((message) =>
        idsOnly
          ? { messageId: message.id, threadId: message.threadId }
          : this.summary(message, full),
      ),
      nextPageToken: next,
      resultSizeEstimate: matching.length,
    };
  }

  /** GMAIL_FETCH_MESSAGE_BY_THREAD_ID: `{messages}` of the thread, oldest first. */
  fetchThread(args: Args): JsonObject {
    const threadId = String(args.thread_id ?? "").replace(/^(msg-f:|thread-f:)/, "");
    const messages = this.messages
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (messages.length === 0)
      throw new ToolError(`Requested entity was not found (thread ${threadId}).`);
    return { messages: messages.map((message) => this.summary(message, true)) };
  }

  /** GMAIL_LIST_THREADS: `{threads:[{id, snippet, historyId}], nextPageToken, resultSizeEstimate}`. */
  listThreads(args: Args): JsonObject {
    const matching = this.search(String(args.query ?? ""), false);
    const threadIds = [...new Set(matching.map((message) => message.threadId))];
    const { page, next } = paginate(threadIds, args.page_token, Number(args.max_results ?? 10));
    return {
      threads: page.map((threadId) => {
        const messages = this.messages
          .filter((message) => message.threadId === threadId)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = messages[0] as MailMessage;
        return {
          id: threadId,
          snippet: snippet(latest.body),
          historyId: String(100000 + this.messages.indexOf(latest)),
          ...(args.verbose === true
            ? { messages: messages.map((message) => this.summary(message, true)) }
            : {}),
        };
      }),
      nextPageToken: next,
      resultSizeEstimate: threadIds.length,
    };
  }

  /** GMAIL_LIST_LABELS: `{labels:[{id, name, type}]}`, with counts when include_details. */
  listLabels(args: Args): JsonObject {
    return {
      labels: this.labels.map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type,
        ...(args.include_details === true
          ? {
              messagesTotal: this.messages.filter((message) => message.labelIds.includes(label.id))
                .length,
              messagesUnread: this.messages.filter(
                (message) =>
                  message.labelIds.includes(label.id) && message.labelIds.includes("UNREAD"),
              ).length,
            }
          : {}),
      })),
    };
  }

  /** GMAIL_CREATE_EMAIL_DRAFT: the Gmail draft resource `{id, message:{id, threadId, labelIds}}`. */
  createDraft(args: Args): JsonObject {
    const to = [...optionalAddress(args.recipient_email), ...stringList(args.extra_recipients)];
    const cc = stringList(args.cc);
    const bcc = stringList(args.bcc);
    if (to.length + cc.length + bcc.length === 0) {
      throw new ToolError(
        "At least one of recipient_email, cc or bcc is required to create a draft.",
      );
    }
    for (const address of [...to, ...cc, ...bcc]) assertAddress(address);
    const subject = typeof args.subject === "string" ? args.subject : "";
    const body = typeof args.body === "string" ? args.body : "";
    if (subject === "" && body === "") throw new ToolError("A draft needs a subject or a body.");
    const requestedThread = typeof args.thread_id === "string" ? args.thread_id : "";
    const thread = this.messages.filter((message) => message.threadId === requestedThread);
    // As Gmail: a subject on a reply draft starts a new thread; an unknown thread id does too.
    const inThread = thread.length > 0 && subject === "";
    const id = this.nextMessageId();
    const message: MailMessage = {
      id,
      threadId: inThread ? requestedThread : id,
      labelIds: ["DRAFT"],
      from: this.owner,
      to,
      cc,
      bcc,
      subject: inThread ? replySubject(thread) : subject,
      date: this.clock.now().toISOString(),
      body,
      isHtml: args.is_html === true,
    };
    this.messages.push(message);
    const draftId = `r-${String(7_400_000_000 + this.sequence).padStart(19, "0")}`;
    this.drafts.set(draftId, { messageId: id });
    return {
      id: draftId,
      message: { id, threadId: message.threadId, labelIds: [...message.labelIds] },
    };
  }

  /** GMAIL_ADD_LABEL_TO_EMAIL: the message `{id, threadId, labelIds}`. */
  modifyLabels(args: Args): JsonObject {
    const message = this.message(String(args.message_id ?? ""));
    const add = stringList(args.add_label_ids);
    const remove = stringList(args.remove_label_ids);
    for (const label of [...add, ...remove]) {
      if (!this.labels.some((entry) => entry.id === label))
        throw new ToolError(`Invalid label: ${label}`);
      if (["INBOX", "SPAM", "TRASH", "SENT", "DRAFT"].includes(label) && add.includes(label)) {
        throw new ToolError(`Label ${label} cannot be added with this tool.`);
      }
    }
    message.labelIds = [
      ...new Set([...message.labelIds.filter((label) => !remove.includes(label)), ...add]),
    ];
    return { id: message.id, threadId: message.threadId, labelIds: [...message.labelIds] };
  }

  /** GMAIL_SEND_DRAFT: the sent message `{id, threadId, labelIds:["SENT"]}`. */
  sendDraft(args: Args): JsonObject {
    const draftId = String(args.draft_id ?? "");
    const draft = this.drafts.get(draftId);
    if (draft === undefined)
      throw new ToolError(`Requested entity was not found (draft ${draftId}).`);
    const message = this.message(draft.messageId);
    if (message.to.length + message.cc.length + message.bcc.length === 0) {
      throw new ToolError("The draft has no recipients.");
    }
    this.drafts.delete(draftId);
    message.labelIds = ["SENT"];
    this.record(message, "draft");
    return { id: message.id, threadId: message.threadId, labelIds: ["SENT"] };
  }

  /** GMAIL_REPLY_TO_THREAD: the sent reply `{id, threadId, labelIds:["SENT"]}`. */
  reply(args: Args): JsonObject {
    const threadId = String(args.thread_id ?? "").replace(/^(msg-f:|thread-f:)/, "");
    const thread = this.messages.filter((message) => message.threadId === threadId);
    if (thread.length === 0)
      throw new ToolError(`Requested entity was not found (thread ${threadId}).`);
    const to = [...optionalAddress(args.recipient_email), ...stringList(args.extra_recipients)];
    const cc = stringList(args.cc);
    const bcc = stringList(args.bcc);
    if (to.length + cc.length + bcc.length === 0) {
      throw new ToolError("At least one of recipient_email, cc or bcc is required to reply.");
    }
    for (const address of [...to, ...cc, ...bcc]) assertAddress(address);
    const message: MailMessage = {
      id: this.nextMessageId(),
      threadId,
      labelIds: ["SENT"],
      from: this.owner,
      to,
      cc,
      bcc,
      subject: replySubject(thread),
      date: this.clock.now().toISOString(),
      body: typeof args.message_body === "string" ? args.message_body : "",
      isHtml: args.is_html === true,
    };
    this.messages.push(message);
    this.record(message, "reply");
    return { id: message.id, threadId, labelIds: ["SENT"] };
  }

  // --- Internals ---------------------------------------------------------------

  private summary(message: MailMessage, full: boolean): JsonObject {
    return {
      messageId: message.id,
      threadId: message.threadId,
      labelIds: [...message.labelIds],
      subject: message.subject,
      sender: message.from,
      to: message.to.join(", "),
      ...(message.cc.length === 0 ? {} : { cc: message.cc.join(", ") }),
      messageTimestamp: message.date,
      internalDate: String(Date.parse(message.date)),
      preview: { subject: message.subject, body: snippet(message.body) },
      ...(full ? { messageText: message.body } : {}),
      attachmentList: [],
    };
  }

  private search(query: string, includeSpamTrash: boolean): MailMessage[] {
    const clauses = parseGmailQuery(query);
    const explicitlyTargetsBin = clauses.some((clause) =>
      clause.some(
        (term) =>
          (term.key === "label" || term.key === "in") &&
          ["spam", "trash"].includes(term.value.toLowerCase()),
      ),
    );
    return this.messages
      .filter(
        (message) =>
          includeSpamTrash ||
          explicitlyTargetsBin ||
          !message.labelIds.some((label) => label === "SPAM" || label === "TRASH"),
      )
      .filter((message) =>
        clauses.every((clause) =>
          clause.some((term) => this.termMatches(message, term) !== term.negated),
        ),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }

  private termMatches(message: MailMessage, term: QueryTerm): boolean {
    const value = term.value.toLowerCase();
    const contains = (text: string) => text.toLowerCase().includes(value);
    switch (term.key) {
      case "from":
        return contains(message.from);
      case "to":
        return [...message.to, ...message.cc].some(contains);
      case "cc":
        return message.cc.some(contains);
      case "subject":
        return contains(message.subject);
      case "label":
      case "in":
      case "category":
        return this.hasLabel(message, term.key === "category" ? `category_${value}` : value);
      case "is":
        return value === "read"
          ? !message.labelIds.includes("UNREAD")
          : this.hasLabel(message, value);
      case "after":
      case "before": {
        const day = Date.parse(`${term.value.replaceAll("/", "-")}T00:00:00Z`);
        if (Number.isNaN(day)) return false;
        const at = Date.parse(message.date);
        return term.key === "after" ? at >= day : at < day;
      }
      case "newer_than":
      case "older_than": {
        const match = /^(\d+)([dmy])$/.exec(value);
        if (match === null) return false;
        const days = Number(match[1]) * (match[2] === "d" ? 1 : match[2] === "m" ? 30 : 365);
        const boundary = this.clock.now().getTime() - days * 86_400_000;
        const at = Date.parse(message.date);
        return term.key === "newer_than" ? at >= boundary : at < boundary;
      }
      case "has":
        return false;
      default:
        return [message.subject, message.body, message.from, ...message.to, ...message.cc].some(
          contains,
        );
    }
  }

  private hasLabel(message: MailMessage, name: string): boolean {
    const aliases: Readonly<Record<string, string>> = {
      drafts: "DRAFT",
      draft: "DRAFT",
      sent: "SENT",
      inbox: "INBOX",
      unread: "UNREAD",
      starred: "STARRED",
      important: "IMPORTANT",
      spam: "SPAM",
      trash: "TRASH",
    };
    const label =
      aliases[name] ??
      this.labels.find(
        (entry) =>
          entry.id.toLowerCase() === name || entry.name.toLowerCase().replaceAll(" ", "-") === name,
      )?.id;
    return label !== undefined && message.labelIds.includes(label);
  }

  private message(id: string): MailMessage {
    const message = this.messages.find((entry) => entry.id === id);
    if (message === undefined)
      throw new ToolError(`Requested entity was not found (message ${id}).`);
    return message;
  }

  private nextMessageId(): string {
    this.sequence += 1;
    return `19b0${this.sequence.toString(16).padStart(12, "0")}`;
  }

  private record(message: MailMessage, via: SentMail["via"]): void {
    this.outbox.push({
      messageId: message.id,
      threadId: message.threadId,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      body: message.body,
      sentAt: this.clock.now().toISOString(),
      via,
    });
  }
}

// ---------------------------------------------------------------------------
// Gmail search syntax
// ---------------------------------------------------------------------------

interface QueryTerm {
  /** An operator (`from`, `label`, ...) or "" for free text. */
  readonly key: string;
  readonly value: string;
  readonly negated: boolean;
}

const OPERATORS = new Set([
  "from",
  "to",
  "cc",
  "subject",
  "label",
  "in",
  "is",
  "after",
  "before",
  "newer_than",
  "older_than",
  "has",
  "category",
]);

/**
 * Gmail search: space-separated terms are ANDed; `a OR b` alternatives;
 * `-term` negates; `key:value` operators; quoted phrases. Returns clauses,
 * each a list of alternatives.
 */
export function parseGmailQuery(query: string): QueryTerm[][] {
  const tokens = [...query.matchAll(/(-?)(?:([a-z_]+):)?("([^"]*)"|\(([^)]*)\)|[^\s]+)/gi)];
  const clauses: QueryTerm[][] = [];
  let joinNext = false;
  for (const token of tokens) {
    const raw = token[0];
    if (raw === "OR" || raw === "|") {
      joinNext = true;
      continue;
    }
    const key = (token[2] ?? "").toLowerCase();
    const value = token[4] ?? token[5] ?? token[3] ?? "";
    const term: QueryTerm =
      key !== "" && !OPERATORS.has(key)
        ? { key: "", value: `${key}:${value}`, negated: token[1] === "-" }
        : { key, value, negated: token[1] === "-" };
    const last = clauses.at(-1);
    if (joinNext && last !== undefined) last.push(term);
    else clauses.push([term]);
    joinNext = false;
  }
  return clauses;
}

function paginate<T>(
  items: readonly T[],
  token: JsonValue | undefined,
  size: number,
): { readonly page: T[]; readonly next: string | null } {
  let offset = 0;
  if (typeof token === "string" && token !== "") {
    const match = /^offset:(\d+)$/.exec(Buffer.from(token, "base64url").toString("utf8"));
    if (match === null) throw new ToolError("Invalid page token.");
    offset = Number(match[1]);
  }
  const limit = Number.isInteger(size) && size > 0 ? size : 1;
  const page = items.slice(offset, offset + limit);
  const next =
    offset + limit < items.length
      ? Buffer.from(`offset:${offset + limit}`).toString("base64url")
      : null;
  return { page, next };
}

function stringList(value: JsonValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function optionalAddress(value: JsonValue | undefined): string[] {
  return typeof value === "string" && value.trim() !== "" ? [value.trim()] : [];
}

/** `user@domain.tld` or `Display Name <user@domain.tld>`. */
function assertAddress(address: string): void {
  const angle = /<([^>]+)>\s*$/.exec(address);
  const email = (angle?.[1] ?? address).trim();
  if (!EMAIL.test(email)) throw new ToolError(`Invalid email address: ${address}`);
}

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function replySubject(thread: readonly MailMessage[]): string {
  const first = [...thread].sort((a, b) => a.date.localeCompare(b.date))[0];
  const subject = first?.subject ?? "";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
