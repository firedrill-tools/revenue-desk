/**
 * Live end-to-end runs: the real Anthropic model plays the five jobs against
 * the labelled local sandbox (docs/ARCHITECTURE.md §11), through the same
 * HTTP API the app uses, then runs the headless CLI three times. It spends
 * real money, so it refuses to start unless LIVE_E2E=1.
 *
 *   LIVE_E2E=1 node --import tsx scripts/live-e2e.ts --out <dir>
 *       [--key-file <path>] [--jobs j1,j2,…] [--no-cli] [--budget-usd <usd>]
 *
 * - The model key comes from --key-file (default: the repository's .env,
 *   which git ignores); only ANTHROPIC_API_KEY is read from it, and it goes
 *   into this process's environment, which is where the sandbox takes the
 *   real model's key from. Every integration is a local fake.
 * - The production build runs (pnpm build first) on a free port with its
 *   state in <out>/state, so the transcripts and the database stay together.
 * - Each approval is decided by the job's rules, as a demanding
 *   revenue-operations lead would: approve the correct refund, invoice or
 *   call; deny a wrong charge, a premature promise to a customer, an email
 *   the user asked only to draft, or a payment nobody asked to record.
 * - Spend is kept in <out>/spend.json across invocations; a run that could
 *   take the total past --budget-usd (default 8) is not started.
 *
 * <out> must be outside the repository. Nothing written there contains a
 * key: the script checks every file it wrote before it exits.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import type { RunDetailView } from "../src/contracts/api.js";
import type { RunSummary } from "../src/contracts/cli.js";
import type { ApprovalDescriptor } from "../src/contracts/events.js";
import type { JsonObject, JsonValue } from "../src/contracts/json.js";
import type { ApiClient, StreamChunk } from "../test/support/api-client.js";
import { freePort, REPOSITORY_ROOT } from "../test/support/harness.js";
import { startSandbox } from "./dev-sandbox.js";

/** A server run may cost up to AGENT_MAX_BUDGET_USD's default; CLI runs are capped below. */
export const SERVER_RUN_CAP_USD = 2;
export const CLI_RUN_CAP_USD = 1;
const TURN_TIMEOUT_MS = 12 * 60_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LiveOptions {
  readonly out: string;
  readonly keyFile: string;
  readonly jobs: readonly string[];
  readonly cli: boolean;
  readonly budgetUsd: number;
}

export type LiveArgs =
  | { readonly ok: true; readonly options: LiveOptions }
  | { readonly ok: false; readonly message: string };

export const LIVE_USAGE =
  "Usage: LIVE_E2E=1 node --import tsx scripts/live-e2e.ts --out <dir outside the repository> " +
  "[--key-file <path>] [--jobs j1,j2,j3,j4,j5] [--no-cli] [--budget-usd <usd>]";

export function parseLiveArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): LiveArgs {
  if (environment.LIVE_E2E !== "1") {
    return {
      ok: false,
      message:
        "Refusing to run: live runs call the real Anthropic API and cost money. Set LIVE_E2E=1.",
    };
  }
  let out: string | null = null;
  let keyFile = join(REPOSITORY_ROOT, ".env");
  let jobs: string[] = LIVE_JOBS.map((job) => job.id);
  let cli = true;
  let budgetUsd = 8;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const value = (): string | undefined => {
      index += 1;
      return argv[index];
    };
    if (arg === "--no-cli") cli = false;
    else if (arg === "--out") {
      const dir = value();
      if (dir === undefined || dir === "") return { ok: false, message: "--out needs a directory" };
      out = resolve(cwd, dir);
    } else if (arg === "--key-file") {
      const file = value();
      if (file === undefined || file === "")
        return { ok: false, message: "--key-file needs a path" };
      keyFile = resolve(cwd, file);
    } else if (arg === "--jobs") {
      const list = (value() ?? "").split(",").map((entry) => entry.trim());
      const known = new Set(LIVE_JOBS.map((job) => job.id));
      const unknown = list.filter((entry) => !known.has(entry));
      if (list.length === 0 || unknown.length > 0)
        return { ok: false, message: `--jobs takes ${[...known].join(",")}` };
      jobs = list;
    } else if (arg === "--budget-usd") {
      const budget = Number(value());
      if (!Number.isFinite(budget) || budget <= 0)
        return { ok: false, message: "--budget-usd must be a positive number" };
      budgetUsd = budget;
    } else {
      return { ok: false, message: `Unknown argument: ${arg}` };
    }
  }
  if (out === null) return { ok: false, message: "--out is required" };
  if (isInside(REPOSITORY_ROOT, out)) {
    return {
      ok: false,
      message: "--out must be outside the repository (transcripts are never committed).",
    };
  }
  return { ok: true, options: { out, keyFile, jobs, cli, budgetUsd } };
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** ANTHROPIC_API_KEY from an env file; nothing else in the file is used. */
export function readModelKey(file: string): string | null {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const key = parseEnv(content).ANTHROPIC_API_KEY?.trim() ?? "";
  return key === "" ? null : key;
}

// ---------------------------------------------------------------------------
// What the lead sees, and decides
// ---------------------------------------------------------------------------

/** One tool call seen on the stream, in the conversation so far. */
export interface SeenCall {
  readonly toolCallId: string;
  readonly tool: string;
  input: JsonObject | null;
  output: JsonValue | null;
  isError: boolean;
  approval: "approved" | "denied" | "policy_denied" | null;
}

/** An approval request as the card shows it, with the call's complete input. */
export interface ApprovalAsk {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly input: JsonObject;
  readonly descriptor: ApprovalDescriptor;
}

export interface Verdict {
  readonly approved: boolean;
  /** Sent to the agent with a denial; kept in the transcript either way. */
  readonly reason: string;
}

export interface LiveJob {
  readonly id: string;
  readonly title: string;
  /** User messages, sent in order to one conversation. */
  readonly turns: readonly string[];
  decide(ask: ApprovalAsk, seen: readonly SeenCall[]): Verdict;
}

const approve = (reason: string): Verdict => ({ approved: true, reason });
const deny = (reason: string): Verdict => ({ approved: false, reason });

/** `mcp__stripe__create_refund` → `create_refund`. */
export function shortName(tool: string): string {
  const index = tool.lastIndexOf("__");
  return index < 0 ? tool : tool.slice(index + 2);
}

function text(value: JsonValue | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function stringField(input: JsonObject | null, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function addressList(input: JsonObject | null, key: string): string[] {
  const value = input?.[key];
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return items
    .map((item) =>
      typeof item === "string"
        ? item
        : item !== null && typeof item === "object" && !Array.isArray(item)
          ? text(item.email ?? null)
          : "",
    )
    .map((item) => (/<([^>]+)>/.exec(item)?.[1] ?? item).trim().toLowerCase())
    .filter((item) => item !== "" && item !== "me");
}

const INTERNAL_DOMAIN = "@kestrel.test";
const isExternal = (address: string) => !address.endsWith(INTERNAL_DOMAIN);

/** The email a send or reply would deliver: its recipients and body, or null when unknown. */
export function outgoingEmail(
  ask: ApprovalAsk,
  seen: readonly SeenCall[],
): { readonly recipients: string[]; readonly body: string } | null {
  const name = shortName(ask.tool);
  const recipientsOf = (input: JsonObject | null) => [
    ...addressList(input, "recipient_email"),
    ...addressList(input, "extra_recipients"),
    ...addressList(input, "cc"),
    ...addressList(input, "bcc"),
  ];
  if (name === "GMAIL_REPLY_TO_THREAD") {
    return {
      recipients: recipientsOf(ask.input),
      body: stringField(ask.input, "message_body") ?? stringField(ask.input, "body") ?? "",
    };
  }
  if (name !== "GMAIL_SEND_DRAFT") return null;
  const draftId = stringField(ask.input, "draft_id");
  const drafts = seen.filter(
    (call) => shortName(call.tool) === "GMAIL_CREATE_EMAIL_DRAFT" && !call.isError,
  );
  const draft =
    (draftId === undefined
      ? undefined
      : drafts.findLast((call) => text(call.output).includes(draftId))) ?? drafts.at(-1);
  if (draft === undefined) return null;
  return {
    recipients: recipientsOf(draft.input),
    body: stringField(draft.input, "body") ?? stringField(draft.input, "message_body") ?? "",
  };
}

/**
 * Whether an email tells the customer a refund was made or will be made.
 * Before a refund has been approved and issued, that is a promise the agent
 * cannot keep on its own.
 */
export function promisesRefund(body: string): boolean {
  const patterns = [
    /\b(has|have|had) been refunded\b/i,
    /\brefund(ed)?\b.*\b(has been|was|is being|is|will be)\s+(issued|processed|initiated|sent|applied|complete)\b/i,
    /\b(we('ve| have)|i('ve| have))\s+(issued|processed|initiated|refunded|reversed)\b/i,
    /\b(we('ll| will)|i('ll| will)|we are|we're|i am|i'm)\s+(going to\s+|now\s+)?(refund|issu|process|initiat|revers)\w*/i,
    /\byou('ll| will| should)\s+(see|receive|get)\s+(a|the|your)\s+(full\s+)?refund\b/i,
    /\bonce the refund\b/i,
    // A refund put in motion: "flagged for a refund … our team will process it shortly",
    // "a refund is pending", "you'll get a confirmation once it's issued".
    /\brefund\b.*\b(flagged|arrang\w*|pending|queued|scheduled|on (its|the) way|in progress|shortly|soon|once it'?s)\b/i,
    /\b(flagged|arrang\w*|queued|scheduled)\b.*\brefund\b/i,
    /\brefund\b.*\b(will|'ll)\s+(be\s+)?(process|issu|send|sent|return|credit|post|appear|reach)\w*/i,
    /\b(will|'ll)\s+(process|issue|send|return|credit)\b.*\brefund\b/i,
  ];
  // Sentence by sentence, so an amount such as $490.00 does not end a match.
  const sentences = body.split(/(?<=[.!?])\s+/);
  return sentences.some((sentence) => patterns.some((pattern) => pattern.test(sentence)));
}

function succeeded(seen: readonly SeenCall[], tool: string): SeenCall[] {
  return seen.filter(
    (call) =>
      shortName(call.tool) === tool &&
      call.approval !== "denied" &&
      !call.isError &&
      call.output !== null,
  );
}

/** Ids QuickBooks returned for records whose output mentions `needle`. */
function quickBooksIds(calls: readonly SeenCall[], needle: RegExp | null): string[] {
  const ids: string[] = [];
  for (const call of calls) {
    const output = text(call.output);
    if (needle !== null && !needle.test(output)) continue;
    for (const match of output.matchAll(/\\?"id\\?":\s*\\?"(\d+)\\?"/g)) {
      if (match[1] !== undefined && !ids.includes(match[1])) ids.push(match[1]);
    }
  }
  return ids;
}

const ALLOWLISTED: Record<string, readonly string[]> = {
  billing: ["#billing", "billing", "C0BILLING01"],
  "sales-ops": ["#sales-ops", "sales-ops", "C0SALESOPS1"],
  revenue: ["#revenue", "revenue", "C0REVENUE01"],
};

function slackPost(ask: ApprovalAsk, channel: keyof typeof ALLOWLISTED): Verdict {
  const target = stringField(ask.input, "channel") ?? "";
  return ALLOWLISTED[channel]?.includes(target)
    ? approve(`#${channel} is the right channel (asked although it is allowlisted).`)
    : deny(`Wrong channel: post to #${channel}, not ${target}.`);
}

const unexpected = (ask: ApprovalAsk): Verdict =>
  deny(`Not part of this job: ${ask.descriptor.consequence}. Leave it for me.`);

/** Harbor & Pine (fixtures): the Sep 22 duplicate has no invoice. */
const HP = {
  duplicate: "ch_KAhp_0922b",
  septemberPaid: "ch_KAhp_0922a",
  august: "ch_KAhp_0822",
  amountMinor: 49_000,
  dana: "dana@harborpine.test",
} as const;

/**
 * A reply to Dana: to her only, and it may say a refund was made only when
 * one was approved and issued in this conversation.
 */
function replyToDana(ask: ApprovalAsk, seen: readonly SeenCall[]): Verdict {
  const email = outgoingEmail(ask, seen);
  if (email === null)
    return deny("I can't see what this sends. Put it in a draft first so I can read it.");
  const external = email.recipients.filter(isExternal);
  if (external.length !== 1 || external[0] !== HP.dana)
    return deny(`Wrong recipients (${external.join(", ") || "none"}): this goes to Dana only.`);
  if (succeeded(seen, "create_refund").length === 0 && promisesRefund(email.body))
    return deny(
      "Don't tell her a refund is done or on its way until one has actually been approved and issued. Say we confirmed the duplicate and will follow up.",
    );
  return approve("To Dana only, and it says only what has actually happened.");
}

export const LIVE_JOBS: readonly LiveJob[] = [
  {
    id: "j1",
    title: "J1 billing inquiry",
    turns: [
      "Dana Whitfield at Harbor & Pine emailed saying they got charged twice for September. Can you look into it and get back to her?",
    ],
    decide(ask, seen) {
      const name = shortName(ask.tool);
      if (name === "GMAIL_SEND_DRAFT" || name === "GMAIL_REPLY_TO_THREAD")
        return replyToDana(ask, seen);
      if (name === "create_refund")
        return deny(
          "Not in this conversation: I asked you to look into it and reply. I'll decide on the refund separately.",
        );
      return unexpected(ask);
    },
  },
  {
    id: "j2",
    title: "J2 duplicate refund",
    turns: [
      "Harbor & Pine got double-charged for September. Please refund the duplicate, add a note on their HubSpot record and give #billing a heads-up.",
      "Dana also thinks August might have been billed twice. If it was, refund that one too.",
      "Thanks. Now reply to Dana on her email thread and let her know where things stand.",
      "Looks good. Send it.",
    ],
    decide(ask, seen) {
      const name = shortName(ask.tool);
      if (name === "post_message") return slackPost(ask, "billing");
      if (name === "GMAIL_SEND_DRAFT" || name === "GMAIL_REPLY_TO_THREAD")
        return replyToDana(ask, seen);
      if (name !== "create_refund") return unexpected(ask);
      const charge = stringField(ask.input, "charge") ?? stringField(ask.input, "payment_intent");
      const amount = ask.input.amount;
      const already = succeeded(seen, "create_refund").some(
        (call) => stringField(call.input, "charge") === charge,
      );
      if (already)
        return deny(`${charge} was already refunded in this conversation. No second refund.`);
      if (charge === HP.duplicate && (amount === undefined || amount === HP.amountMinor))
        return approve("Correct: the Sep 22 manual retry with no invoice, $490.00.");
      if (charge === HP.septemberPaid)
        return deny(
          "Wrong charge: ch_KAhp_0922a paid invoice KA-7F31-0007. The duplicate is the one without an invoice.",
        );
      if (charge === HP.august)
        return deny(
          "Wrong: August was billed once (ch_KAhp_0822 paid invoice KA-7F31-0006). No refund.",
        );
      return deny(
        `Wrong charge or amount (${charge}, ${String(amount)}): only the $490.00 duplicate ${HP.duplicate} is owed.`,
      );
    },
  },
  {
    id: "j3",
    title: "J3 collections",
    turns: [
      "Time for the collections pass. Find everything overdue, check Stripe for anything that was actually paid but never recorded in QuickBooks, draft reminder emails (don't send anything), and for anything 60+ days late set up a call with the customer and a HubSpot task for the account owner.",
    ],
    decide(ask) {
      const name = shortName(ask.tool);
      if (name === "GOOGLECALENDAR_CREATE_EVENT" || name === "GOOGLECALENDAR_UPDATE_EVENT") {
        const external = addressList(ask.input, "attendees").filter(isExternal);
        const wrong = external.filter((address) => !address.endsWith("@copperleaf.test"));
        if (wrong.length > 0)
          return deny(
            `Only Copperleaf (invoice 1043, 70 days) is 60+ days overdue. No call with ${wrong.join(", ")}.`,
          );
        const start = stringField(ask.input, "start_datetime") ?? "";
        if (start !== "" && start.slice(0, 10) <= "2026-09-28")
          return deny(`${start} is not in the future. Propose a time after today.`);
        return approve("Copperleaf's invoice 1043 is 70 days overdue; a call with Theo is right.");
      }
      if (name === "GMAIL_SEND_DRAFT" || name === "GMAIL_REPLY_TO_THREAD")
        return deny("I asked for drafts only. I'll review and send them myself.");
      if (name === "record_payment")
        return deny(
          "Don't record payments during a collections pass. Flag it and Sam will reconcile it in QuickBooks.",
        );
      return unexpected(ask);
    },
  },
  {
    id: "j4",
    title: "J4 closed-won handoff",
    turns: [
      "Solstice Energy closed-won with Jordan this week. Get them set up in QuickBooks, raise the invoice, send it to their billing contact, and post in #sales-ops when it's done.",
    ],
    decide(ask, seen) {
      const name = shortName(ask.tool);
      if (name === "post_message") return slackPost(ask, "sales-ops");
      if (name === "create_invoice") {
        const lines = Array.isArray(ask.input.lines) ? ask.input.lines : [];
        const total = lines.reduce<number>((sum, line) => {
          if (line === null || typeof line !== "object" || Array.isArray(line)) return sum;
          const quantity = typeof line.quantity === "number" ? line.quantity : 0;
          const unit = typeof line.unit_price_minor === "number" ? line.unit_price_minor : 0;
          return sum + quantity * unit;
        }, 0);
        const customer = stringField(ask.input, "customer_id") ?? "";
        const solstice = [
          ...quickBooksIds(succeeded(seen, "create_customer"), null),
          ...quickBooksIds(
            [...succeeded(seen, "find_customers"), ...succeeded(seen, "get_customer")],
            /Solstice/,
          ),
        ];
        if (!solstice.includes(customer))
          return deny(
            `Customer ${customer} is not the Solstice record you found or created (${solstice.join(", ") || "none"}).`,
          );
        if (total !== 1_800_000)
          return deny(
            `The deal is $18,000.00 (Enterprise annual); this invoice totals ${(total / 100).toFixed(2)}.`,
          );
        return approve("Right customer, $18,000.00 matching the closed-won deal.");
      }
      if (name === "send_invoice") {
        const invoice = stringField(ask.input, "invoice_id") ?? "";
        const created = quickBooksIds(succeeded(seen, "create_invoice"), null);
        const to = stringField(ask.input, "send_to");
        if (!created.includes(invoice))
          return deny(
            `Invoice ${invoice} is not the one you just created (${created.join(", ") || "none"}).`,
          );
        if (to !== undefined && to.toLowerCase() !== "marco@solstice.test")
          return deny(`Send it to Marco (marco@solstice.test), not ${to}.`);
        return approve("The invoice just created, to Solstice's billing contact.");
      }
      return unexpected(ask);
    },
  },
  {
    id: "j5",
    title: "J5 weekly digest",
    turns: [
      "Can you put together last week's revenue digest (Sep 21–28): new and won deals, card payments and refunds, and where AR stands? Post it in #revenue.",
    ],
    decide(ask) {
      return shortName(ask.tool) === "post_message" ? slackPost(ask, "revenue") : unexpected(ask);
    },
  },
];

export interface CliRun {
  readonly id: string;
  readonly prompt: string;
  /** Remove the QuickBooks configuration from this run's environment. */
  readonly withoutQuickBooks: boolean;
}

export const CLI_RUNS: readonly CliRun[] = [
  {
    id: "c1",
    prompt:
      "Which invoices are more than 30 days past due right now, and was any of them actually paid through Stripe?",
    withoutQuickBooks: false,
  },
  {
    id: "c2",
    prompt:
      "Meridian Labs paid invoice 1051 by card on Sep 10 but QuickBooks still shows it open. Record that payment in QuickBooks.",
    withoutQuickBooks: false,
  },
  {
    id: "c3",
    prompt:
      "What's our open AR by aging bucket as of today? Call out anything more than 60 days overdue.",
    withoutQuickBooks: true,
  },
];

const QUICKBOOKS_VARS = [
  "QBO_ACCESS_TOKEN",
  "QBO_REALM_ID",
  "QBO_API_BASE_URL",
  "QBO_MINOR_VERSION",
];

// ---------------------------------------------------------------------------
// Card checks: does the approval card say what the call will do?
// ---------------------------------------------------------------------------

export function formatUsd(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const [whole, cents] = (Math.abs(minor) / 100).toFixed(2).split(".") as [string, string];
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/** Problems with the card's facts against the call's input; empty when the card is right. */
export function checkCard(ask: ApprovalAsk): string[] {
  const problems: string[] = [];
  const { descriptor, input } = ask;
  const name = shortName(ask.tool);
  const expectAmount = (minor: number) => {
    if (descriptor.amount?.amountMinor !== minor)
      problems.push(`amount ${String(descriptor.amount?.amountMinor)} != input ${minor}`);
    if (!descriptor.consequence.includes(formatUsd(minor)))
      problems.push(`consequence lacks ${formatUsd(minor)}`);
  };
  const expectRecord = (id: string | undefined) => {
    if (id !== undefined && !(descriptor.recordIds ?? []).includes(id))
      problems.push(`record ${id} missing from the card`);
  };
  if (name === "create_refund") {
    if (typeof input.amount === "number") expectAmount(input.amount);
    expectRecord(stringField(input, "charge") ?? stringField(input, "payment_intent"));
  } else if (name === "record_payment") {
    if (typeof input.amount_minor === "number") expectAmount(input.amount_minor);
    expectRecord(stringField(input, "invoice_id"));
  } else if (name === "create_invoice" && Array.isArray(input.lines)) {
    const total = input.lines.reduce<number>((sum, line) => {
      if (line === null || typeof line !== "object" || Array.isArray(line)) return sum;
      return (
        sum +
        (typeof line.quantity === "number" ? line.quantity : 0) *
          (typeof line.unit_price_minor === "number" ? line.unit_price_minor : 0)
      );
    }, 0);
    expectAmount(total);
  } else if (name === "send_invoice") {
    expectRecord(stringField(input, "invoice_id"));
    if ((descriptor.recipients ?? []).length === 0)
      problems.push("the card does not name the recipient (only 'the invoice's billing email')");
  } else if (name === "GMAIL_SEND_DRAFT") {
    if ((descriptor.recipients ?? []).length === 0)
      problems.push("the card does not name the recipients (only the draft id)");
  } else if (name === "GMAIL_REPLY_TO_THREAD" || name.startsWith("GOOGLECALENDAR_")) {
    const expected = [
      ...addressList(input, "recipient_email"),
      ...addressList(input, "attendees"),
      ...addressList(input, "cc"),
    ];
    const shown = (descriptor.recipients ?? []).map((address) => address.toLowerCase());
    for (const address of expected)
      if (!shown.includes(address)) problems.push(`recipient ${address} missing from the card`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export interface ApprovalRecord {
  readonly toolCallId: string;
  readonly tool: string;
  readonly consequence: string;
  readonly facts: ApprovalDescriptor["facts"];
  readonly approved: boolean;
  readonly reason: string;
  readonly cardProblems: readonly string[];
  readonly answeredStatus: number | null;
}

export interface TurnRecord {
  readonly label: string;
  readonly source: "ui" | "cli";
  readonly prompt: string;
  readonly runId: string | null;
  readonly status: string | null;
  /** The assistant's text in stream order, split at each tool call. */
  readonly narrative: readonly string[];
  readonly reply: string;
  readonly approvals: readonly ApprovalRecord[];
  readonly detail: RunDetailView | null;
  readonly wallMs: number;
  readonly failures: readonly string[];
}

/** One line per tool call: tool, class, decision. */
export function toolLine(detail: RunDetailView | null): string {
  if (detail === null) return "(no run detail)";
  return detail.toolCalls
    .map(
      (call) =>
        `${call.integration ?? "?"}/${call.connectionKind ?? "?"} ${call.operation ?? call.toolName} ` +
        `[${call.actionClass ?? "?"}:${call.decision}${call.isError ? ",error" : ""}]`,
    )
    .join("\n      ");
}

function describeTurn(turn: TurnRecord): string {
  const usage = turn.detail?.usage;
  const lines = [
    `${turn.label} (${turn.source}) run ${turn.runId ?? "?"}: ${turn.status ?? "?"}` +
      (usage === null || usage === undefined
        ? ""
        : `, $${usage.costUsd.toFixed(4)}, ${usage.numTurns} turns, ${usage.modelRequests} requests, ${Math.round(usage.durationMs / 1000)} s`),
    `    tools: ${toolLine(turn.detail)}`,
  ];
  for (const approval of turn.approvals) {
    lines.push(
      `    approval ${shortName(approval.tool)}: ${approval.approved ? "APPROVED" : "DENIED"} — ${approval.consequence}` +
        `${approval.cardProblems.length > 0 ? ` [card: ${approval.cardProblems.join("; ")}]` : ""}\n      reason: ${approval.reason}`,
    );
  }
  for (const failure of turn.failures) lines.push(`    failure: ${failure}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function playTurn(
  api: ApiClient,
  conversationId: string,
  job: LiveJob,
  label: string,
  prompt: string,
  seen: SeenCall[],
): Promise<TurnRecord> {
  const started = Date.now();
  const byId = new Map<string, SeenCall>();
  const approvals: ApprovalRecord[] = [];
  const actions: Promise<unknown>[] = [];
  const failures: string[] = [];
  const narrative: string[] = [""];
  let runId: string | null = null;
  let status: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), TURN_TIMEOUT_MS);
  });
  const stream = api.chat(conversationId, prompt, {
    onChunk: (chunk: StreamChunk) => {
      switch (chunk.type) {
        case "start":
          runId = (chunk.messageMetadata as { runId?: string } | undefined)?.runId ?? null;
          break;
        case "message-metadata": {
          const value = (chunk.messageMetadata as { status?: string } | undefined)?.status;
          if (value !== undefined) status = value;
          break;
        }
        case "text-delta":
          narrative[narrative.length - 1] += String(chunk.delta ?? "");
          break;
        case "tool-input-available": {
          const call: SeenCall = {
            toolCallId: String(chunk.toolCallId),
            tool: String(chunk.toolName),
            input: (chunk.input as JsonObject | undefined) ?? null,
            output: null,
            isError: false,
            approval: null,
          };
          byId.set(call.toolCallId, call);
          seen.push(call);
          narrative.push("");
          break;
        }
        case "tool-output-available": {
          const call = byId.get(String(chunk.toolCallId));
          if (call !== undefined) call.output = (chunk.output as JsonValue | undefined) ?? null;
          break;
        }
        case "tool-output-error": {
          const call = byId.get(String(chunk.toolCallId));
          if (call !== undefined) {
            call.isError = true;
            call.output = String(chunk.errorText ?? "");
          }
          break;
        }
        case "tool-approval-request": {
          const call = byId.get(String(chunk.toolCallId));
          if (chunk.isAutomatic === true) {
            if (call !== undefined) call.approval = "policy_denied";
            break;
          }
          if (call === undefined || call.input === null) {
            failures.push(
              `approval for a call the stream never showed: ${String(chunk.toolCallId)}`,
            );
            break;
          }
          const ask: ApprovalAsk = {
            approvalId: String(chunk.approvalId),
            toolCallId: call.toolCallId,
            tool: call.tool,
            input: call.input,
            descriptor: chunk.approvalDescriptor as unknown as ApprovalDescriptor,
          };
          const verdict = job.decide(ask, seen);
          call.approval = verdict.approved ? "approved" : "denied";
          const record = {
            toolCallId: ask.toolCallId,
            tool: ask.tool,
            consequence: ask.descriptor.consequence,
            facts: ask.descriptor.facts,
            approved: verdict.approved,
            reason: verdict.reason,
            cardProblems: checkCard(ask),
            answeredStatus: null as number | null,
          };
          approvals.push(record);
          actions.push(
            api
              .decide(
                ask.approvalId,
                verdict.approved,
                verdict.approved ? undefined : verdict.reason,
              )
              .then((reply) => {
                record.answeredStatus = reply.status;
                if (!reply.ok) failures.push(`deciding ${ask.approvalId} answered ${reply.status}`);
              }),
          );
          break;
        }
        case "error":
          failures.push(`stream error: ${String(chunk.errorText ?? "")}`);
          break;
        default:
          break;
      }
    },
  });
  const outcome = await Promise.race([stream.then(() => "done" as const), timeout]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    failures.push(`no end of stream after ${TURN_TIMEOUT_MS / 60_000} minutes; stopping the run`);
    const id = runId as string | null;
    if (id !== null) await api.call("POST /api/runs/:runId/stop", { params: { runId: id } });
    await stream.catch(() => undefined);
  }
  await Promise.all(actions);
  const id = runId as string | null;
  const detail =
    id === null ? null : await api.expect("GET /api/runs/:runId", { params: { runId: id } });
  if (detail?.error) failures.push(`run error ${detail.error.code}: ${detail.error.message}`);
  return {
    label,
    source: "ui",
    prompt,
    runId: id,
    status,
    narrative: narrative.map((part) => part.trim()).filter((part) => part !== ""),
    reply: narrative.at(-1)?.trim() ?? "",
    approvals,
    detail,
    wallMs: Date.now() - started,
    failures,
  };
}

function runCli(
  run: CliRun,
  environment: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stdout: string; stderr: string; wallMs: number }> {
  const env: Record<string, string> = { ...environment };
  if (run.withoutQuickBooks) for (const name of QUICKBOOKS_VARS) delete env[name];
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      join(REPOSITORY_ROOT, "dist/cli/main.js"),
      "ask",
      "--json",
      "--max-budget-usd",
      String(CLI_RUN_CAP_USD),
      "--timeout-ms",
      String(TURN_TIMEOUT_MS),
      run.prompt,
    ],
    { cwd: REPOSITORY_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (piece: string) => {
    stdout += piece;
  });
  child.stderr.setEncoding("utf8").on("data", (piece: string) => {
    stderr += piece;
  });
  return new Promise((resolveRun, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      resolveRun({ code, stdout, stderr, wallMs: Date.now() - started }),
    );
  });
}

interface SpendLedger {
  totalUsd: number;
  entries: { at: string; label: string; costUsd: number }[];
}

function readLedger(path: string): SpendLedger {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SpendLedger;
  } catch {
    return { totalUsd: 0, entries: [] };
  }
}

/** Every file under `dir` that contains `secret`. */
export function filesContaining(dir: string, secret: string): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (stats.size < 64 * 1024 * 1024 && readFileSync(full).includes(secret))
        found.push(full);
    }
  };
  walk(dir);
  return found;
}

async function main(): Promise<void> {
  const parsed = parseLiveArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n${LIVE_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const { options } = parsed;
  if (!existsSync(join(REPOSITORY_ROOT, "dist/server/main.js"))) {
    process.stderr.write("dist/ is missing: run pnpm build first.\n");
    process.exitCode = 2;
    return;
  }
  const key = readModelKey(options.keyFile);
  if (key === null) {
    process.stderr.write(`No ANTHROPIC_API_KEY in ${options.keyFile}.\n`);
    process.exitCode = 3;
    return;
  }
  process.env.ANTHROPIC_API_KEY = key;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(options.out, stamp);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const ledgerPath = join(options.out, "spend.json");
  const ledger = readLedger(ledgerPath);
  const spend = (label: string, costUsd: number) => {
    ledger.totalUsd += costUsd;
    ledger.entries.push({ at: new Date().toISOString(), label, costUsd });
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  };
  const affordable = (cap: number, label: string) => {
    if (ledger.totalUsd + cap <= options.budgetUsd) return true;
    process.stdout.write(
      `Skipping ${label}: $${ledger.totalUsd.toFixed(2)} spent, up to $${cap} more would pass the $${options.budgetUsd} budget.\n`,
    );
    return false;
  };

  const serverLog: string[] = [];
  const sandbox = await startSandbox(
    { model: "real", hubspot: "stdio", stateDir: join(runDir, "state"), web: false, built: true },
    { apiPort: await freePort(), onServerOutput: (chunk) => serverLog.push(chunk) },
  );
  const turns: TurnRecord[] = [];
  const save = (name: string, value: unknown) =>
    writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  try {
    const api = sandbox.harness.api as ApiClient;
    process.stdout.write(`Sandbox at ${sandbox.harness.url}; transcripts in ${runDir}\n`);
    await api.session();
    for (const job of LIVE_JOBS.filter((entry) => options.jobs.includes(entry.id))) {
      const { conversation } = await api.expect("POST /api/conversations", {
        body: { title: job.title },
      });
      const seen: SeenCall[] = [];
      const jobTurns: TurnRecord[] = [];
      for (const [index, prompt] of job.turns.entries()) {
        const label = job.turns.length === 1 ? job.id : `${job.id}.${index + 1}`;
        if (!affordable(SERVER_RUN_CAP_USD, label)) break;
        const turn = await playTurn(api, conversation.id, job, label, prompt, seen);
        spend(label, turn.detail?.usage?.costUsd ?? 0);
        jobTurns.push(turn);
        turns.push(turn);
        process.stdout.write(`${describeTurn(turn)}\n`);
      }
      save(`${job.id}.json`, { job: job.id, conversationId: conversation.id, turns: jobTurns });
    }

    if (options.cli) {
      for (const run of CLI_RUNS) {
        if (!affordable(CLI_RUN_CAP_USD, run.id)) break;
        const result = await runCli(run, sandbox.harness.env);
        let summary: RunSummary | null = null;
        const failures: string[] = [];
        try {
          summary = JSON.parse(result.stdout) as RunSummary;
        } catch {
          failures.push(`stdout was not one JSON summary (exit ${String(result.code)})`);
        }
        const detail =
          summary === null
            ? null
            : await api.expect("GET /api/runs/:runId", { params: { runId: summary.runId } });
        if (result.code !== 0) failures.push(`exit code ${String(result.code)}`);
        spend(run.id, summary?.usage?.costUsd ?? 0);
        const turn: TurnRecord = {
          label: run.id,
          source: "cli",
          prompt: run.prompt,
          runId: summary?.runId ?? null,
          status: summary?.status ?? null,
          narrative: summary?.reply === null || summary === null ? [] : [summary.reply],
          reply: summary?.reply ?? "",
          approvals: [],
          detail,
          wallMs: result.wallMs,
          failures,
        };
        turns.push(turn);
        save(`${run.id}.json`, {
          run: run.id,
          withoutQuickBooks: run.withoutQuickBooks,
          exitCode: result.code,
          summary,
          stderr: result.stderr,
          turn,
        });
        process.stdout.write(`${describeTurn(turn)}\n`);
      }
    }
  } finally {
    await sandbox.stop();
    writeFileSync(join(runDir, "server.log"), serverLog.join(""));
  }
  const denials = turns.flatMap((turn) => turn.approvals.filter((approval) => !approval.approved));
  save("summary.json", {
    spentThisInvocationUsd: turns.reduce(
      (sum, turn) => sum + (turn.detail?.usage?.costUsd ?? 0),
      0,
    ),
    spentTotalUsd: ledger.totalUsd,
    denials: denials.length,
    turns: turns.map((turn) => ({
      label: turn.label,
      source: turn.source,
      runId: turn.runId,
      status: turn.status,
      usage: turn.detail?.usage ?? null,
      tools: turn.detail?.toolCalls.map((call) => ({
        integration: call.integration,
        kind: call.connectionKind,
        operation: call.operation,
        actionClass: call.actionClass,
        decision: call.decision,
        isError: call.isError,
      })),
      approvals: turn.approvals,
      reply: turn.reply,
      failures: turn.failures,
    })),
  });
  const leaks = filesContaining(runDir, key);
  process.stdout.write(
    `Done: ${turns.length} runs, ${denials.length} denied approvals, $${ledger.totalUsd.toFixed(4)} spent in total. ` +
      `Key found in ${leaks.length} written files.\n`,
  );
  if (leaks.length > 0) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
