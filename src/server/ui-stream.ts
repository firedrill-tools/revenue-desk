// AI SDK v7 UI message stream with server-held approvals (spike S1).
//
// The approval pattern the real /api/chat will use, proven end to end on a
// fixed script:
//   1. The tool call is streamed as a dynamic tool part (tool-input-start with
//      dynamic:true, tool-input-delta, tool-input-available).
//   2. tool-approval-request is written and the SAME response stays open while
//      the server waits for POST /api/.../approvals/:id.
//   3. The server writes tool-approval-response (the only source of truth for
//      the decision), then tool-output-available or tool-output-denied.
// The client never calls addToolApprovalResponse and never uses
// sendAutomaticallyWhen, so a decision can never replay the turn.
//
// Everything under /api/spike/* is scaffolding for spike S1 and is removed when
// the real /api/chat route lands; ApprovalWaiters and the chunk helpers are
// meant to be reused by it.

import { randomUUID } from "node:crypto";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageStreamOnEndCallback,
  type UIMessageStreamWriterWithOutcome,
} from "ai";
import { type Context, Hono } from "hono";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Stream contract shared with the web client (web/src/lib/chat.ts parses it).
// ---------------------------------------------------------------------------

/** How a tool call reaches its system; shown as a neutral chip in the UI. */
export type ConnectionKind = "composio" | "mcp" | "api";

/** Approval policy classes (docs/ARCHITECTURE.md §7). */
export type ActionClass = "read" | "internal_write" | "outbound" | "financial" | "destructive";

/** Sent as `toolMetadata` on tool-input-start and tool-input-available. */
export type ToolMetadata = {
  integration: string;
  connectionKind: ConnectionKind;
  operation: string;
  actionClass: ActionClass;
};

/**
 * Sent as `approvalDescriptor` on tool-approval-request; the reducer stores it
 * as `approval.descriptor`. It holds the facts the approval card shows.
 */
export type ApprovalDescriptor = {
  actionClass: ActionClass;
  integration: string;
  /** The exact consequence, e.g. "Refund $49.00 to Kestrel Analytics". */
  consequence: string;
  facts: Array<{ label: string; value: string }>;
};

export type ChatMessageMetadata = { runId: string; model: string };
export type ChatUIMessage = UIMessage<ChatMessageMetadata>;
type ChatStreamWriter = UIMessageStreamWriterWithOutcome<ChatUIMessage>;

// ---------------------------------------------------------------------------
// Approval waiters: a pending approval holds the stream open until a decision.
// ---------------------------------------------------------------------------

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
  decidedBy: "user" | "timeout" | "stop";
};

export type DecideOutcome = "accepted" | "unknown" | "already_decided";

/**
 * In-process registry of approvals that a running stream is waiting on.
 * A waiter settles exactly once: by decide() (the user), by its timeout, or by
 * its abort signal (Stop or client disconnect). Timeout and stop deny.
 */
export class ApprovalWaiters {
  readonly #pending = new Map<string, (decision: ApprovalDecision) => void>();
  // Recently settled ids, so a late or repeated decision gets 409, not 404.
  readonly #settled = new Map<string, ApprovalDecision>();
  readonly #settledLimit: number;

  constructor(options: { settledLimit?: number } = {}) {
    this.#settledLimit = options.settledLimit ?? 500;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  wait(
    approvalId: string,
    options: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<ApprovalDecision> {
    if (this.#pending.has(approvalId) || this.#settled.has(approvalId)) {
      return Promise.reject(new Error(`Approval ${approvalId} is already registered`));
    }
    const { signal, timeoutMs } = options;

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision): void => {
        if (this.#pending.get(approvalId) !== settle) return;
        this.#pending.delete(approvalId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#remember(approvalId, decision);
        resolve(decision);
      };
      const onAbort = (): void =>
        settle({ approved: false, reason: "The run was stopped.", decidedBy: "stop" });
      const timer = setTimeout(
        () =>
          settle({
            approved: false,
            reason: `No decision within ${describeDuration(timeoutMs)}.`,
            decidedBy: "timeout",
          }),
        timeoutMs,
      );

      this.#pending.set(approvalId, settle);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  decide(approvalId: string, decision: { approved: boolean; reason?: string }): DecideOutcome {
    const settle = this.#pending.get(approvalId);
    if (settle) {
      settle({
        approved: decision.approved,
        ...(decision.reason ? { reason: decision.reason } : {}),
        decidedBy: "user",
      });
      return "accepted";
    }
    return this.#settled.has(approvalId) ? "already_decided" : "unknown";
  }

  #remember(approvalId: string, decision: ApprovalDecision): void {
    this.#settled.set(approvalId, decision);
    if (this.#settled.size > this.#settledLimit) {
      const oldest = this.#settled.keys().next().value;
      if (oldest !== undefined) this.#settled.delete(oldest);
    }
  }
}

function describeDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} seconds`;
  return `${ms} ms`;
}

// ---------------------------------------------------------------------------
// Chunk helpers (reusable by the AgentEvent -> UIMessageChunk mapping).
// ---------------------------------------------------------------------------

/** Resolves after `ms`, or immediately once `signal` aborts. Never rejects. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Splits text into word-sized deltas that keep their trailing whitespace. */
export function toDeltas(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

async function writeBlock(
  writer: ChatStreamWriter,
  kind: "text" | "reasoning",
  text: string,
  pacing: { delayMs: number; signal: AbortSignal | undefined },
): Promise<void> {
  const id = `${kind}_${randomUUID()}`;
  writer.write({ type: `${kind}-start`, id });
  for (const delta of toDeltas(text)) {
    if (pacing.signal?.aborted) break;
    writer.write({ type: `${kind}-delta`, id, delta });
    await pause(pacing.delayMs, pacing.signal);
  }
  writer.write({ type: `${kind}-end`, id });
}

// ---------------------------------------------------------------------------
// The fixed spike script: a financial action held for approval.
// Fictional data only; nothing here calls a model or an external system.
// ---------------------------------------------------------------------------

export const SPIKE_MODEL = "scripted";
export const SPIKE_TOOL_NAME = "stripe_create_refund";
export const SPIKE_TOOL_TITLE = "Refund Stripe charge";

export const SPIKE_TOOL_METADATA: ToolMetadata = {
  integration: "stripe",
  connectionKind: "api",
  operation: "refunds.create",
  actionClass: "financial",
};

export const SPIKE_TOOL_INPUT = {
  charge: "ch_spike_duplicate_0002",
  amount: 4900,
  currency: "usd",
  reason: "duplicate",
} as const;

export const SPIKE_APPROVAL_DESCRIPTOR: ApprovalDescriptor = {
  actionClass: "financial",
  integration: "stripe",
  consequence: "Refund $49.00 to Kestrel Analytics",
  facts: [
    { label: "Amount", value: "$49.00 USD" },
    { label: "Customer", value: "Kestrel Analytics, Inc." },
    { label: "Charge", value: "ch_spike_duplicate_0002" },
    { label: "Reason", value: "Duplicate charge" },
  ],
};

export const SPIKE_TOOL_OUTPUT = {
  id: "re_spike_0001",
  object: "refund",
  status: "succeeded",
  amount: 4900,
  currency: "usd",
  charge: "ch_spike_duplicate_0002",
} as const;

const SPIKE_REASONING =
  "The customer reports two charges for one invoice. Two charges of $49.00 were made " +
  "on the same day for the same invoice, so the second one is a duplicate. A refund is " +
  "a financial action and needs approval.";

const SPIKE_INTRO =
  "I found two identical $49.00 charges for Kestrel Analytics on the same invoice. " +
  "I'll refund the duplicate charge once you approve it.";

function closingText(decision: ApprovalDecision): string {
  if (decision.approved) {
    return `Refunded $49.00 to Kestrel Analytics (refund ${SPIKE_TOOL_OUTPUT.id}). The original charge is unchanged.`;
  }
  if (decision.decidedBy === "timeout") {
    return "I did not refund the charge because no decision arrived in time.";
  }
  return decision.reason
    ? `I did not refund the charge because the approval was declined: ${decision.reason}`
    : "I did not refund the charge because the approval was declined.";
}

export type SpikeScriptOptions = {
  waiters: ApprovalWaiters;
  approvalTimeoutMs: number;
  /** Delay between deltas, so the UI visibly streams. 0 in tests. */
  chunkDelayMs: number;
  /** Aborts on Stop or client disconnect; a pending approval is then denied. */
  signal?: AbortSignal | undefined;
};

/**
 * Writes the fixed script. The chunk order mirrors what the Agent SDK mapping
 * produces: the assistant message holding tool_use ends its step before
 * canUseTool runs, so finish-step precedes tool-approval-request.
 */
export async function writeSpikeScript(
  writer: ChatStreamWriter,
  options: SpikeScriptOptions,
): Promise<void> {
  const { signal } = options;
  const pacing = { delayMs: options.chunkDelayMs, signal };
  const toolCallId = `call_${randomUUID()}`;
  const approvalId = `apr_${randomUUID()}`;

  writer.write({
    type: "start",
    messageMetadata: { runId: `run_${randomUUID()}`, model: SPIKE_MODEL },
  });
  writer.write({ type: "start-step" });
  await writeBlock(writer, "reasoning", SPIKE_REASONING, pacing);
  await writeBlock(writer, "text", SPIKE_INTRO, pacing);

  writer.write({
    type: "tool-input-start",
    toolCallId,
    toolName: SPIKE_TOOL_NAME,
    dynamic: true,
    title: SPIKE_TOOL_TITLE,
    toolMetadata: SPIKE_TOOL_METADATA,
  });
  for (const fragment of toJsonFragments(SPIKE_TOOL_INPUT)) {
    writer.write({ type: "tool-input-delta", toolCallId, inputTextDelta: fragment });
    await pause(pacing.delayMs, signal);
  }
  writer.write({
    type: "tool-input-available",
    toolCallId,
    toolName: SPIKE_TOOL_NAME,
    input: SPIKE_TOOL_INPUT,
    dynamic: true,
    title: SPIKE_TOOL_TITLE,
    toolMetadata: SPIKE_TOOL_METADATA,
  });
  writer.write({ type: "finish-step" });

  writer.write({
    type: "tool-approval-request",
    approvalId,
    toolCallId,
    approvalDescriptor: SPIKE_APPROVAL_DESCRIPTOR,
    reason: SPIKE_APPROVAL_DESCRIPTOR.consequence,
  });
  const decision = await options.waiters.wait(approvalId, {
    timeoutMs: options.approvalTimeoutMs,
    signal,
  });

  // Always answer the request before the output: tool-output-denied alone
  // leaves approval.approved undefined, and Confirmation then renders nothing.
  writer.write({
    type: "tool-approval-response",
    approvalId,
    approved: decision.approved,
    ...(decision.reason ? { reason: decision.reason } : {}),
  });
  if (decision.approved) {
    writer.write({ type: "tool-output-available", toolCallId, output: SPIKE_TOOL_OUTPUT });
  } else {
    writer.write({ type: "tool-output-denied", toolCallId });
  }

  if (decision.decidedBy === "stop") {
    writer.write({ type: "abort", reason: "stopped" });
    writer.setOutcome({ status: "aborted" });
    return;
  }

  writer.write({ type: "start-step" });
  await writeBlock(writer, "text", closingText(decision), pacing);
  writer.write({ type: "finish-step" });
  writer.write({ type: "finish", finishReason: "stop" });
  writer.setOutcome({ status: "completed" });
}

/** Streams JSON the way a model does: a few fragments that only parse once joined. */
function toJsonFragments(value: unknown): string[] {
  const json = JSON.stringify(value);
  const size = Math.max(8, Math.ceil(json.length / 5));
  const fragments: string[] = [];
  for (let index = 0; index < json.length; index += size) {
    fragments.push(json.slice(index, index + size));
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// HTTP routes.
// ---------------------------------------------------------------------------

export const SPIKE_CHAT_PATH = "/api/spike/chat";
export const SPIKE_APPROVALS_PATH = "/api/spike/approvals";

export type SpikeRoutesOptions = {
  waiters?: ApprovalWaiters;
  /** Default 5 minutes. */
  approvalTimeoutMs?: number;
  /** Default 30 ms. */
  chunkDelayMs?: number;
  /** Receives the server-side reduction of the response (what W3 persists). */
  onRunEnd?: UIMessageStreamOnEndCallback<ChatUIMessage>;
};

const chatRequestSchema = z.object({
  conversationId: z.string().min(1).max(200),
  message: z.object({
    id: z.string().max(200),
    role: z.literal("user"),
    parts: z.array(z.looseObject({ type: z.string() })).max(50),
  }),
});

const approvalRequestSchema = z.strictObject({
  approved: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function apiError(c: Context, status: 400 | 403 | 404 | 409 | 415, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/**
 * Minimal mutation guard for the spike: JSON only, and a browser Origin must
 * match the Host. The real routes add the per-boot CSRF cookie and header.
 */
function rejectUnsafeMutation(c: Context): Response | undefined {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return apiError(c, 415, "unsupported_media_type", "Send the request body as application/json.");
  }
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost === undefined || originHost !== c.req.header("host")) {
      return apiError(c, 403, "forbidden_origin", "Cross-origin requests are not allowed.");
    }
  }
  return undefined;
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createSpikeRoutes(options: SpikeRoutesOptions = {}): Hono {
  const waiters = options.waiters ?? new ApprovalWaiters();
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 5 * 60_000;
  const chunkDelayMs = options.chunkDelayMs ?? 30;
  const app = new Hono();

  app.post(SPIKE_CHAT_PATH, async (c) => {
    const rejected = rejectUnsafeMutation(c);
    if (rejected) return rejected;
    const parsed = chatRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Expected {conversationId, message}.");
    }

    // Aborts when the client disconnects (@hono/node-server) or stops.
    const signal = c.req.raw.signal;
    const stream = createUIMessageStream<ChatUIMessage>({
      execute: ({ writer }) =>
        writeSpikeScript(writer, { waiters, approvalTimeoutMs, chunkDelayMs, signal }),
      onError: (error) => {
        process.stderr.write(
          `spike chat stream failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return "The run failed.";
      },
      // Passing onEnd also runs the AI SDK reducer on the server, so a chunk
      // sequence the client would reject fails here too.
      onEnd: async (event) => {
        await options.onRunEnd?.(event);
      },
    });
    return createUIMessageStreamResponse({ stream });
  });

  app.post(`${SPIKE_APPROVALS_PATH}/:approvalId`, async (c) => {
    const rejected = rejectUnsafeMutation(c);
    if (rejected) return rejected;
    const approvalId = c.req.param("approvalId");
    if (!APPROVAL_ID_PATTERN.test(approvalId)) {
      return apiError(c, 404, "not_found", "No pending approval has this id.");
    }
    const parsed = approvalRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Expected {approved: boolean, reason?: string}.");
    }

    const outcome = waiters.decide(approvalId, {
      approved: parsed.data.approved,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    });
    if (outcome === "unknown") {
      return apiError(c, 404, "not_found", "No pending approval has this id.");
    }
    if (outcome === "already_decided") {
      return apiError(c, 409, "already_decided", "This approval was already decided.");
    }
    return c.json({ status: "accepted" });
  });

  return app;
}
