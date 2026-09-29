// Throwaway API stub for the web UI's visual check (W4). NOT product code:
// scripted UI message chunks in the §6 order, fictional data only
// (Kestrel Analytics and its customers on .test domains). Nothing here calls a
// model or an external system.

import type { InferUIMessageChunk } from "ai";
import type { ApprovalView, ChatUIMessage, ToolCallView } from "../../../src/contracts/api.js";
import type { ApprovalDescriptor, RunUsage, ToolMetadata } from "../../../src/contracts/events.js";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";

export type Chunk = InferUIMessageChunk<ChatUIMessage>;

export type Decision = {
  approved: boolean;
  reason?: string;
  decidedBy: "user" | "timeout" | "stop";
};

export type ScriptContext = {
  readonly runId: string;
  readonly conversationId: string;
  readonly messageId: string;
  /** Milliseconds between streamed words; 0 builds history instantly. */
  readonly pace: number;
  /** Multiplies tool durations; 0 builds history instantly. */
  readonly timeScale: number;
  readonly model: string;
  emit(chunk: Chunk): void;
  pause(ms: number): Promise<void>;
  stopped(): boolean;
  waitForApproval(approvalId: string): Promise<Decision>;
  recordTool(call: ToolCallView): void;
  recordApproval(approval: ApprovalView): void;
  finish(status: "completed" | "cancelled", usage: RunUsage): void;
};

type ToolSpec = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly title: string;
  readonly metadata: ToolMetadata;
  readonly upstream: string;
  readonly input: JsonObject;
  readonly output: JsonValue;
  readonly durationMs: number;
};

let counter = 0;
export function stubId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}`;
}

async function writeText(
  ctx: ScriptContext,
  kind: "text" | "reasoning",
  text: string,
): Promise<void> {
  const id = stubId(kind);
  ctx.emit({ type: `${kind}-start`, id });
  for (const delta of text.match(/\S+\s*/g) ?? []) {
    if (ctx.stopped()) break;
    ctx.emit({ type: `${kind}-delta`, id, delta });
    await ctx.pause(ctx.pace);
  }
  ctx.emit({ type: `${kind}-end`, id });
}

async function startTool(ctx: ScriptContext, spec: ToolSpec): Promise<void> {
  ctx.emit({
    type: "tool-input-start",
    toolCallId: spec.toolCallId,
    toolName: spec.toolName,
    dynamic: true,
    title: spec.title,
    toolMetadata: spec.metadata,
  });
  const json = JSON.stringify(spec.input);
  const size = Math.max(8, Math.ceil(json.length / 3));
  for (let index = 0; index < json.length; index += size) {
    ctx.emit({
      type: "tool-input-delta",
      toolCallId: spec.toolCallId,
      inputTextDelta: json.slice(index, index + size),
    });
    await ctx.pause(ctx.pace);
  }
  ctx.emit({
    type: "tool-input-available",
    toolCallId: spec.toolCallId,
    toolName: spec.toolName,
    input: spec.input,
    dynamic: true,
    title: spec.title,
    toolMetadata: spec.metadata,
  });
}

function logRow(
  ctx: ScriptContext,
  spec: ToolSpec,
  startedAt: number,
  extra: Partial<ToolCallView> = {},
): ToolCallView {
  return {
    id: stubId("tc"),
    toolCallId: spec.toolCallId,
    runId: ctx.runId,
    integration: spec.metadata.integration,
    connectionKind: spec.metadata.connectionKind,
    toolName: spec.toolName,
    upstreamTool: spec.upstream,
    operation: spec.metadata.operation,
    actionClass: spec.metadata.actionClass,
    title: spec.title,
    status: "succeeded",
    decision: "auto",
    input: spec.input,
    output: spec.output,
    isError: false,
    error: null,
    httpStatus: spec.metadata.connectionKind === "api" ? 200 : null,
    idempotencyKey: null,
    approvalId: null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(startedAt + spec.durationMs).toISOString(),
    durationMs: spec.durationMs,
    ...extra,
  };
}

/** Runs tools concurrently: outputs arrive as each finishes, with progress ticks. */
async function runTools(ctx: ScriptContext, specs: readonly ToolSpec[]): Promise<void> {
  const started = Date.now();
  const pending = new Set(specs.map((spec) => spec.toolCallId));
  const done = specs.map(async (spec) => {
    await ctx.pause(spec.durationMs * ctx.timeScale);
    if (ctx.stopped()) return;
    pending.delete(spec.toolCallId);
    ctx.emit({ type: "tool-output-available", toolCallId: spec.toolCallId, output: spec.output });
    ctx.recordTool(logRow(ctx, spec, started));
  });
  const ticker = (async () => {
    while (pending.size > 0 && !ctx.stopped() && ctx.timeScale > 0) {
      await ctx.pause(1_000);
      for (const toolCallId of pending) {
        ctx.emit({
          type: "data-progress",
          data: { toolCallId, elapsedMs: Date.now() - started },
          transient: true,
        });
      }
    }
  })();
  await Promise.all(done);
  await ticker;
}

function metadata(
  integration: ToolMetadata["integration"],
  connectionKind: ToolMetadata["connectionKind"],
  operation: ToolMetadata["operation"],
  actionClass: ToolMetadata["actionClass"],
): ToolMetadata {
  return { integration, connectionKind, operation, actionClass };
}

const REFUND_REASONING =
  "Dana at Harbor & Pine says the September invoice was charged twice. I should read the email thread first, then look for two charges of the same amount on the same day in Stripe, check whether a refund already exists, and confirm the account owner in HubSpot before proposing anything. A refund moves money, so it needs approval.";

const FINAL_ANSWER = `Refunded the duplicate charge for **Harbor & Pine Outfitters**.

| | Charge | Amount | Status |
|---|---|---|---|
| Kept | \`ch_3Q8hPine0001\` | $49.00 | Paid, invoice INV-2041 |
| Refunded | \`ch_3Q8hPine0002\` | $49.00 | Refund \`re_3Q8hPine0007\`, succeeded |

- Logged a note on the Harbor & Pine company record in HubSpot for Jordan Reyes, the account owner.
- Posted the refund to **#billing** in Slack.
- The reply to Dana is not drafted yet. Say the word and I will draft it in Gmail for you to review.`;

/** J2: refund a duplicate charge, with an approval for the refund. */
export async function refundScenario(ctx: ScriptContext): Promise<void> {
  const startedAt = Date.now();
  ctx.emit({
    type: "start",
    messageId: ctx.messageId,
    messageMetadata: { runId: ctx.runId, model: ctx.model, effort: "medium" },
  });
  ctx.emit({
    type: "data-notice",
    data: {
      level: "warning",
      code: "connection_unavailable",
      integration: "quickbooks",
      message:
        "QuickBooks Online is not connected, so this run cannot see invoices or payments recorded there.",
    },
  });

  // Step 1: read the inbox.
  ctx.emit({ type: "data-status", data: { phase: "requesting" }, transient: true });
  await ctx.pause(900 * ctx.timeScale);
  ctx.emit({ type: "start-step" });
  await writeText(ctx, "reasoning", REFUND_REASONING);
  const gmail: ToolSpec = {
    toolCallId: stubId("toolu"),
    toolName: "mcp__gmail__GMAIL_FETCH_EMAILS",
    title: "Search the billing inbox",
    metadata: metadata("gmail", "composio", "gmail.messages.list", "read"),
    upstream: "GMAIL_FETCH_EMAILS",
    input: { query: "from:harborpine.test newer_than:7d", max_results: 5 },
    output: {
      messages: [
        {
          id: "18f2c1a9e4b7d001",
          threadId: "18f2c1a9e4b7d000",
          from: "Dana Whitfield <dana@harborpine.test>",
          subject: "Charged twice for September?",
          date: "2026-09-27T15:42:10Z",
          snippet:
            "Hi, our card statement shows two charges of $49.00 from Kestrel on Sep 1. Can you check?",
        },
      ],
    },
    durationMs: 820,
  };
  await startTool(ctx, gmail);
  ctx.emit({ type: "finish-step" });
  await runTools(ctx, [gmail]);
  if (ctx.stopped()) return;

  // Step 2: cross-check three systems at once.
  ctx.emit({ type: "data-status", data: { phase: "requesting" }, transient: true });
  await ctx.pause(700 * ctx.timeScale);
  ctx.emit({ type: "start-step" });
  await writeText(
    ctx,
    "text",
    "Dana reports two $49.00 charges on September 1. I'll check HubSpot and Stripe.",
  );
  const reads: ToolSpec[] = [
    {
      toolCallId: stubId("toolu"),
      toolName: "mcp__hubspot__hubspot-search-objects",
      title: "Search HubSpot companies",
      metadata: metadata("hubspot", "mcp", "hubspot.objects.search", "read"),
      upstream: "hubspot-search-objects",
      input: {
        objectType: "companies",
        query: "harborpine.test",
        properties: ["name", "domain", "hubspot_owner_id"],
      },
      output: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total: 1,
              results: [
                {
                  id: "9920417763",
                  properties: {
                    name: "Harbor & Pine Outfitters",
                    domain: "harborpine.test",
                    hubspot_owner_id: "Jordan Reyes",
                  },
                },
              ],
            }),
          },
        ],
      },
      durationMs: 1_240,
    },
    {
      toolCallId: stubId("toolu"),
      toolName: "mcp__stripe__list_charges",
      title: "List Stripe charges",
      metadata: metadata("stripe", "api", "stripe.charges.list", "read"),
      upstream: "GET /v1/charges",
      input: { customer: "cus_KAharborpine", created_gte: "2026-09-01", limit: 10 },
      output: {
        data: [
          {
            id: "ch_3Q8hPine0001",
            amount: 4900,
            currency: "usd",
            status: "succeeded",
            created: "2026-09-01T09:02:11Z",
            invoice: "in_1Q8hPine2041",
          },
          {
            id: "ch_3Q8hPine0002",
            amount: 4900,
            currency: "usd",
            status: "succeeded",
            created: "2026-09-01T09:02:14Z",
            invoice: "in_1Q8hPine2041",
          },
        ],
        has_more: false,
      },
      durationMs: 5_600,
    },
    {
      toolCallId: stubId("toolu"),
      toolName: "mcp__stripe__list_refunds",
      title: "List Stripe refunds",
      metadata: metadata("stripe", "api", "stripe.refunds.list", "read"),
      upstream: "GET /v1/refunds",
      input: { charge: "ch_3Q8hPine0002" },
      output: { data: [], has_more: false },
      durationMs: 610,
    },
  ];
  for (const spec of reads) await startTool(ctx, spec);
  ctx.emit({ type: "finish-step" });
  await runTools(ctx, reads);
  if (ctx.stopped()) return;

  // Step 3: propose the refund (financial: asks).
  ctx.emit({ type: "data-status", data: { phase: "requesting" }, transient: true });
  await ctx.pause(800 * ctx.timeScale);
  ctx.emit({ type: "start-step" });
  await writeText(
    ctx,
    "text",
    "Stripe shows two identical $49.00 charges three seconds apart for the same invoice, and no refund yet. The second charge is the duplicate, so I'll refund it once you approve.",
  );
  const refund: ToolSpec = {
    toolCallId: stubId("toolu"),
    toolName: "mcp__stripe__create_refund",
    title: "Refund charge in Stripe",
    metadata: metadata("stripe", "api", "stripe.refunds.create", "financial"),
    upstream: "POST /v1/refunds",
    input: { charge: "ch_3Q8hPine0002", amount: 4900, reason: "duplicate" },
    output: {
      id: "re_3Q8hPine0007",
      object: "refund",
      amount: 4900,
      currency: "usd",
      charge: "ch_3Q8hPine0002",
      status: "succeeded",
    },
    durationMs: 930,
  };
  await startTool(ctx, refund);
  ctx.emit({ type: "finish-step" });

  const approvalId = stubId("apr");
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + 15 * 60_000).toISOString();
  const descriptor: ApprovalDescriptor = {
    actionClass: "financial",
    integration: "stripe",
    connectionKind: "api",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    consequence: "Refund $49.00 to Harbor & Pine Outfitters",
    facts: [
      { label: "Amount", value: "$49.00 USD" },
      { label: "Customer", value: "Harbor & Pine Outfitters (cus_KAharborpine)" },
      { label: "Charge", value: "ch_3Q8hPine0002" },
      { label: "Reason", value: "Duplicate of ch_3Q8hPine0001, same invoice" },
    ],
    amount: { amountMinor: 4900, currency: "USD" },
    recordIds: ["ch_3Q8hPine0002", "in_1Q8hPine2041"],
    expiresAt,
  };
  ctx.emit({
    type: "tool-approval-request",
    approvalId,
    toolCallId: refund.toolCallId,
    approvalDescriptor: descriptor,
    reason: descriptor.consequence,
  } as Chunk);
  const approvalView = (decision: Decision | null): ApprovalView => ({
    id: approvalId,
    runId: ctx.runId,
    conversationId: ctx.conversationId,
    toolCallId: refund.toolCallId,
    integration: "stripe",
    actionClass: "financial",
    operation: "stripe.refunds.create",
    consequence: descriptor.consequence,
    descriptor,
    status:
      decision === null
        ? "pending"
        : decision.approved
          ? "approved"
          : decision.decidedBy === "stop"
            ? "cancelled"
            : "denied",
    decidedBy: decision?.decidedBy ?? null,
    reason: decision?.reason ?? null,
    requestedAt: requestedAt.toISOString(),
    decidedAt: decision === null ? null : new Date().toISOString(),
    expiresAt,
  });
  ctx.recordApproval(approvalView(null));
  const decision = await ctx.waitForApproval(approvalId);
  ctx.recordApproval(approvalView(decision));
  ctx.emit({
    type: "tool-approval-response",
    approvalId,
    approved: decision.approved,
    ...(decision.reason ? { reason: decision.reason } : {}),
  });

  const usage = (turns: number): RunUsage => ({
    costUsd: 0.0412 + turns * 0.004,
    inputTokens: 18_420 + turns * 1_200,
    outputTokens: 1_184 + turns * 160,
    cacheReadTokens: 12_800,
    cacheCreationTokens: 3_150,
    numTurns: turns,
    modelRequests: turns,
    durationMs: Date.now() - startedAt,
    durationApiMs: Math.round((Date.now() - startedAt) * 0.62),
  });

  if (!decision.approved) {
    ctx.emit({ type: "tool-output-denied", toolCallId: refund.toolCallId });
    ctx.recordTool(
      logRow(ctx, refund, Date.now(), {
        status: "denied",
        decision: decision.decidedBy === "stop" ? "stopped" : "denied",
        output: null,
        approvalId,
        durationMs: null,
        finishedAt: new Date().toISOString(),
      }),
    );
    if (decision.decidedBy === "stop") {
      ctx.emit({ type: "abort", reason: "stopped" });
      ctx.finish("cancelled", usage(3));
      return;
    }
    ctx.emit({ type: "start-step" });
    await writeText(
      ctx,
      "text",
      `I did not refund the charge because the approval was declined${decision.reason ? `: ${decision.reason}` : "."} Nothing changed in Stripe.`,
    );
    ctx.emit({ type: "finish-step" });
    const final = usage(4);
    ctx.emit({ type: "data-usage", data: final });
    ctx.emit({
      type: "message-metadata",
      messageMetadata: {
        runId: ctx.runId,
        model: ctx.model,
        effort: "medium",
        status: "completed",
        usage: final,
      },
    });
    ctx.emit({ type: "finish", finishReason: "stop" });
    ctx.finish("completed", final);
    return;
  }

  await ctx.pause(refund.durationMs * ctx.timeScale);
  ctx.emit({ type: "tool-output-available", toolCallId: refund.toolCallId, output: refund.output });
  ctx.recordTool(
    logRow(ctx, refund, Date.now() - refund.durationMs, {
      decision: "approved",
      approvalId,
      idempotencyKey: "9b1f0c4e7a2d5b8c3e6f1a4d7b0c2e5f8a1d4b7c0e3f6a9b2c5d8e1f4a7b0c3d",
    }),
  );

  // Step 4: log it (internal writes: automatic).
  ctx.emit({ type: "data-status", data: { phase: "requesting" }, transient: true });
  await ctx.pause(700 * ctx.timeScale);
  ctx.emit({ type: "start-step" });
  const followUps: ToolSpec[] = [
    {
      toolCallId: stubId("toolu"),
      toolName: "mcp__hubspot__hubspot-batch-create-objects",
      title: "Create HubSpot note",
      metadata: metadata("hubspot", "mcp", "hubspot.notes.create", "internal_write"),
      upstream: "hubspot-batch-create-objects",
      input: {
        objectType: "notes",
        inputs: [
          {
            properties: {
              hs_note_body:
                "Refunded duplicate September charge ch_3Q8hPine0002 ($49.00), refund re_3Q8hPine0007.",
            },
            associations: [
              {
                to: { id: "9920417763" },
                types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }],
              },
            ],
          },
        ],
      },
      output: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "COMPLETE", results: [{ id: "71804426113" }] }),
          },
        ],
      },
      durationMs: 1_020,
    },
    {
      toolCallId: stubId("toolu"),
      toolName: "mcp__slack__SLACK_SEND_MESSAGE",
      title: "Post to #billing in Slack",
      metadata: metadata("slack", "composio", "slack.chat.post_message", "internal_write"),
      upstream: "SLACK_SEND_MESSAGE",
      input: {
        channel: "#billing",
        markdown_text:
          "Refunded $49.00 to Harbor & Pine Outfitters (duplicate of ch_3Q8hPine0001). Refund re_3Q8hPine0007.",
      },
      output: {
        successful: true,
        data: { ok: true, channel: "C07BILLING", ts: "1790604312.000200" },
        error: null,
      },
      durationMs: 480,
    },
  ];
  for (const spec of followUps) await startTool(ctx, spec);
  ctx.emit({ type: "finish-step" });
  await runTools(ctx, followUps);
  if (ctx.stopped()) return;

  ctx.emit({ type: "data-status", data: { phase: "requesting" }, transient: true });
  await ctx.pause(900 * ctx.timeScale);
  ctx.emit({ type: "start-step" });
  await writeText(ctx, "text", FINAL_ANSWER);
  ctx.emit({ type: "finish-step" });
  const final = usage(5);
  ctx.emit({ type: "data-usage", data: final });
  ctx.emit({
    type: "message-metadata",
    messageMetadata: {
      runId: ctx.runId,
      model: ctx.model,
      effort: "medium",
      status: "completed",
      usage: final,
    },
  });
  ctx.emit({ type: "finish", finishReason: "stop" });
  ctx.finish("completed", final);
}

/** Any other prompt: a short answer, after a model retry notice when asked for. */
export async function shortScenario(ctx: ScriptContext, prompt: string): Promise<void> {
  const startedAt = Date.now();
  ctx.emit({
    type: "start",
    messageId: ctx.messageId,
    messageMetadata: { runId: ctx.runId, model: ctx.model, effort: "medium" },
  });
  if (/retry/i.test(prompt)) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      ctx.emit({
        type: "data-status",
        data: { phase: "retrying", attempt, maxAttempts: 10, retryInMs: 2_000, errorStatus: 529 },
        transient: true,
      });
      await ctx.pause(2_500 * ctx.timeScale);
    }
  }
  ctx.emit({ type: "data-status", data: { phase: "requesting" }, transient: true });
  await ctx.pause(1_200 * ctx.timeScale);
  ctx.emit({ type: "start-step" });
  await writeText(
    ctx,
    "text",
    "This stub only scripts the duplicate-charge refund. Pick **Refund a duplicate charge** to see reads across Composio, MCP and API tools and an approval.",
  );
  ctx.emit({ type: "finish-step" });
  const usage: RunUsage = {
    costUsd: 0.0061,
    inputTokens: 4_210,
    outputTokens: 96,
    cacheReadTokens: 0,
    cacheCreationTokens: 3_900,
    numTurns: 1,
    modelRequests: 1,
    durationMs: Date.now() - startedAt,
    durationApiMs: Date.now() - startedAt,
  };
  ctx.emit({ type: "data-usage", data: usage });
  ctx.emit({
    type: "message-metadata",
    messageMetadata: {
      runId: ctx.runId,
      model: ctx.model,
      effort: "medium",
      status: "completed",
      usage,
    },
  });
  ctx.emit({ type: "finish", finishReason: "stop" });
  ctx.finish("completed", usage);
}
