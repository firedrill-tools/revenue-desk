// Throwaway API stub for the web UI's visual check (W4). NOT product code.
//
// Serves the built SPA (dist/web) and a small in-memory implementation of the
// API contract (src/contracts/api.ts): session, conversations, chat with the
// scripted refund scenario (buffered runs, resume replay, approvals, stop),
// runs, connections, settings and policies. Fictional data only.
//
//   pnpm build && node --import tsx test/support/web-stub/server.ts [port]

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createUIMessageStream, createUIMessageStreamResponse, readUIMessageStream } from "ai";
import { Hono } from "hono";
import type {
  ApprovalView,
  ChatUIMessage,
  ConnectionView,
  ConversationSummary,
  PolicyView,
  RunDetailView,
  RunSummaryView,
  SessionInfo,
  ToolCallView,
} from "../../../src/contracts/api.js";
import { CSRF_HEADER } from "../../../src/contracts/api.js";
import type { RunConnection, RunUsage } from "../../../src/contracts/events.js";
import {
  ACTION_CLASSES,
  type ApprovalMode,
  CONNECTION_KINDS,
  DEFAULT_POLICY,
  type IntegrationId,
  type WorkspaceSettings,
} from "../../../src/contracts/integration.js";
import {
  type Chunk,
  type Decision,
  refundScenario,
  type ScriptContext,
  shortScenario,
  stubId,
} from "./scenario.js";

const MODEL = "claude-sonnet-5";
const CSRF_TOKEN = randomUUID();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Conversation = Mutable<ConversationSummary> & { messages: ChatUIMessage[] };
type Run = {
  detail: RunDetailView;
  chunks: Chunk[];
  listeners: Set<(chunk: Chunk | null) => void>;
  done: boolean;
  abort: AbortController;
  waiters: Map<string, (decision: Decision) => void>;
};

const conversations = new Map<string, Conversation>();
const runs = new Map<string, Run>();

let settings: WorkspaceSettings = {
  companyName: "Kestrel Analytics, Inc.",
  agentName: "Revenue Desk",
  senderName: "Maya Lindqvist",
  emailSignature: "Maya Lindqvist\nRevenue Operations, Kestrel Analytics\nmaya@kestrel.test",
  internalEmailDomains: ["kestrel.test"],
  notifySlackChannel: "#billing",
  allowedSlackChannels: ["#billing", "#sales-ops", "#revenue"],
  internalCalendarIds: [],
  timezone: "America/New_York",
  currency: "USD",
  defaultModel: null,
  defaultEffort: null,
  updatedAt: new Date(Date.now() - 3 * DAY).toISOString(),
};

let policies: PolicyView[] = ACTION_CLASSES.map((actionClass) => ({
  actionClass,
  mode: DEFAULT_POLICY[actionClass],
  source: actionClass === "destructive" ? "environment" : "default",
  locked: actionClass === "destructive",
}));

const checkedAt = new Date(Date.now() - 4 * 60_000).toISOString();
let connections: ConnectionView[] = [
  {
    integration: "gmail",
    kind: "composio",
    profile: "composio",
    label: "Gmail",
    state: "connected",
    detail: "Connected as maya@kestrel.test.",
    endpointLabel: "backend.composio.dev",
    accountHint: "ca_…7Qe",
    missing: [],
    checkedAt,
    canConnect: false,
  },
  {
    integration: "google_calendar",
    kind: "composio",
    profile: "composio",
    label: "Google Calendar",
    state: "needs_auth",
    detail: "The Google Calendar connection needs to be signed in again.",
    endpointLabel: "backend.composio.dev",
    accountHint: null,
    missing: [],
    checkedAt,
    canConnect: true,
  },
  {
    integration: "hubspot",
    kind: "mcp",
    profile: "hubspot-mcp-0.4",
    label: "HubSpot",
    state: "connected",
    detail: "Portal 48213377 (test account).",
    endpointLabel: "api.hubapi.com",
    accountHint: "hub_…3377",
    missing: [],
    checkedAt,
    canConnect: false,
  },
  {
    integration: "stripe",
    kind: "api",
    profile: "stripe-api",
    label: "Stripe",
    state: "connected",
    detail: "Test mode key.",
    endpointLabel: "api.stripe.com",
    accountHint: "acct_…Dtest",
    missing: [],
    checkedAt,
    canConnect: false,
  },
  {
    integration: "quickbooks",
    kind: "api",
    profile: "quickbooks-api",
    label: "QuickBooks Online",
    state: "not_configured",
    detail: "QuickBooks Online is not configured.",
    endpointLabel: null,
    accountHint: null,
    missing: ["QBO_ACCESS_TOKEN", "QBO_REALM_ID"],
    checkedAt: null,
    canConnect: false,
  },
  {
    integration: "slack",
    kind: "api",
    profile: "slack-api",
    label: "Slack",
    state: "connected",
    detail: "Bot @revenue-desk in Kestrel.",
    endpointLabel: "slack.com",
    accountHint: "T04…KSTL",
    missing: [],
    checkedAt,
    canConnect: false,
  },
];

function runConnections(): RunConnection[] {
  return connections.map((connection) => ({
    integration: connection.integration,
    kind: connection.kind,
    profile: connection.profile,
    availability: connection.state === "connected" ? "ready" : "unavailable",
    state: connection.state,
    detail: connection.state === "connected" ? null : connection.detail,
    endpointLabel: connection.endpointLabel,
  }));
}

function effectivePolicy(): RunDetailView["policy"] {
  return Object.fromEntries(
    policies.map((policy) => [policy.actionClass, policy.mode]),
  ) as RunDetailView["policy"];
}

function summarize(run: RunDetailView): RunSummaryView {
  const byKind = Object.fromEntries(CONNECTION_KINDS.map((kind) => [kind, 0])) as Record<
    (typeof CONNECTION_KINDS)[number],
    number
  >;
  for (const call of run.toolCalls) if (call.connectionKind) byKind[call.connectionKind] += 1;
  const count = (status: ApprovalView["status"]) =>
    run.approvals.filter((approval) => approval.status === status).length;
  const {
    stopReason: _s,
    terminalReason: _t,
    policy: _p,
    connections: _c,
    toolCalls: _tc,
    approvals: _a,
    ...rest
  } = run;
  return {
    ...rest,
    toolCallsByKind: byKind,
    approvals: { pending: count("pending"), approved: count("approved"), denied: count("denied") },
  };
}

function summaryOf(conversation: Conversation): ConversationSummary {
  const { messages: _messages, ...summary } = conversation;
  return summary;
}

// ---------------------------------------------------------------------------
// Running a script
// ---------------------------------------------------------------------------

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function reduce(chunks: readonly Chunk[]): Promise<ChatUIMessage | undefined> {
  let last: ChatUIMessage | undefined;
  const stream = new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  for await (const message of readUIMessageStream<ChatUIMessage>({ stream })) last = message;
  return last;
}

type StartOptions = { pace: number; timeScale: number; autoApprove?: boolean; startedAt?: number };

function startRun(conversation: Conversation, prompt: string, options: StartOptions): Run {
  const runId = stubId("run");
  const startedAt = options.startedAt ?? Date.now();
  const detail: RunDetailView = {
    id: runId,
    conversationId: conversation.id,
    source: conversation.source,
    mode: "interactive",
    status: "running",
    model: MODEL,
    effort: "medium",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    usage: null,
    toolCallsByKind: { composio: 0, mcp: 0, api: 0 },
    failedToolCalls: 0,
    approvals: [],
    error: null,
    stopReason: null,
    terminalReason: null,
    policy: effectivePolicy(),
    connections: runConnections(),
    toolCalls: [],
  };
  const run: Run = {
    detail,
    chunks: [],
    listeners: new Set(),
    done: false,
    abort: new AbortController(),
    waiters: new Map(),
  };
  runs.set(runId, run);
  conversation.activeRunId = runId;
  conversation.status = "running";

  const context: ScriptContext = {
    runId,
    conversationId: conversation.id,
    messageId: stubId("msg"),
    pace: options.pace,
    timeScale: options.timeScale,
    model: MODEL,
    emit(chunk) {
      run.chunks.push(chunk);
      for (const listener of run.listeners) listener(chunk);
    },
    pause: (ms) => pause(ms, run.abort.signal),
    stopped: () => run.abort.signal.aborted,
    waitForApproval(approvalId) {
      if (options.autoApprove) return Promise.resolve({ approved: true, decidedBy: "user" });
      conversation.status = "awaiting_approval";
      conversation.pendingApprovals = 1;
      return new Promise((resolve) => {
        const settle = (decision: Decision) => {
          run.waiters.delete(approvalId);
          conversation.status = "running";
          conversation.pendingApprovals = 0;
          resolve(decision);
        };
        run.waiters.set(approvalId, settle);
        run.abort.signal.addEventListener(
          "abort",
          () => settle({ approved: false, decidedBy: "stop", reason: "The run was stopped." }),
          { once: true },
        );
      });
    },
    recordTool(call: ToolCallView) {
      run.detail = {
        ...run.detail,
        toolCalls: [
          ...run.detail.toolCalls.filter((item) => item.toolCallId !== call.toolCallId),
          call,
        ],
      };
    },
    recordApproval(approval: ApprovalView) {
      run.detail = {
        ...run.detail,
        approvals: [...run.detail.approvals.filter((item) => item.id !== approval.id), approval],
      };
    },
    finish(status, usage: RunUsage) {
      run.detail = {
        ...run.detail,
        status,
        usage,
        finishedAt: new Date(startedAt + usage.durationMs).toISOString(),
        terminalReason: status === "completed" ? "completed" : "aborted_tools",
        stopReason: status === "cancelled" ? "user" : null,
      };
      conversation.totalCostUsd += usage.costUsd;
    },
  };

  const script = /charged twice|duplicate/i.test(prompt)
    ? refundScenario(context)
    : shortScenario(context, prompt);
  void script
    .catch((error: unknown) => {
      context.emit({
        type: "error",
        errorText: error instanceof Error ? error.message : "The run failed.",
      });
    })
    .finally(async () => {
      if (run.abort.signal.aborted && run.detail.status === "running") {
        context.emit({ type: "abort", reason: "stopped" });
        run.detail = {
          ...run.detail,
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          stopReason: "user",
          terminalReason: "aborted_tools",
        };
      }
      run.done = true;
      for (const listener of run.listeners) listener(null);
      const message = await reduce(run.chunks);
      if (message) conversation.messages.push(message);
      conversation.activeRunId = null;
      conversation.status = "idle";
      conversation.pendingApprovals = 0;
      conversation.updatedAt = new Date(options.startedAt ?? Date.now()).toISOString();
    });
  return run;
}

function streamRun(run: Run): Response {
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) =>
      new Promise<void>((resolve) => {
        for (const chunk of run.chunks) writer.write(chunk);
        if (run.done) return resolve();
        const listener = (chunk: Chunk | null) => {
          if (chunk === null) {
            run.listeners.delete(listener);
            resolve();
          } else writer.write(chunk);
        };
        run.listeners.add(listener);
      }),
  });
  return createUIMessageStreamResponse({ stream });
}

// ---------------------------------------------------------------------------
// Seed: a few conversations, one with the full refund history
// ---------------------------------------------------------------------------

function userMessage(text: string): ChatUIMessage {
  return { id: stubId("msg"), role: "user", parts: [{ type: "text", text }] };
}

function addConversation(
  title: string,
  updatedAgoMs: number,
  extra: Partial<Conversation> = {},
): Conversation {
  const at = new Date(Date.now() - updatedAgoMs).toISOString();
  const conversation: Conversation = {
    id: stubId("conv"),
    title,
    source: "ui",
    status: "idle",
    activeRunId: null,
    pendingApprovals: 0,
    pendingConsequence: null,
    totalCostUsd: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    messages: [],
    ...extra,
  };
  conversations.set(conversation.id, conversation);
  return conversation;
}

async function seed(): Promise<void> {
  const textOnly = (
    conversation: Conversation,
    prompt: string,
    answer: string,
    costUsd: number,
  ) => {
    conversation.messages.push(userMessage(prompt), {
      id: stubId("msg"),
      role: "assistant",
      metadata: { runId: stubId("run"), model: MODEL, effort: "medium", status: "completed" },
      parts: [{ type: "step-start" }, { type: "text", text: answer, state: "done" }],
    });
    conversation.totalCostUsd = costUsd;
  };
  textOnly(
    addConversation("Why was Tidewater charged twice?", 16 * DAY),
    "Why was Tidewater charged twice?",
    "Tidewater was billed once in Stripe; the second line on their statement is a pending authorisation that expired on the 14th.",
    0.034,
  );
  textOnly(
    addConversation("Closed-won handoff: Meridian Labs", 9 * DAY),
    "Hand off the Meridian Labs deal.",
    "Created QuickBooks invoice 1187 for Meridian Labs ($12,400.00), sent it after your approval, and posted the handoff to #sales-ops.",
    0.121,
  );
  textOnly(
    addConversation("Weekly revenue digest", 3 * DAY, { source: "cli" }),
    "Post the weekly digest.",
    "Posted the digest to #revenue: 4 new deals ($38,200), $21,940 collected, 1 refund ($49.00).",
    0.052,
  );
  textOnly(
    addConversation("Overdue invoices over 60 days", 5 * HOUR, {
      status: "awaiting_approval",
      pendingApprovals: 1,
    }),
    "List overdue invoices over 60 days.",
    "Copperleaf Studios is 64 days overdue on INV-1142 ($3,600.00). I proposed a call with Theo for Thursday.",
    0.047,
  );

  const refund = addConversation("Refund the duplicate charge for Harbor & Pine", 26 * HOUR);
  const prompt = "Harbor & Pine says they were charged twice for September. Refund the duplicate.";
  refund.messages.push(userMessage(prompt));
  const run = startRun(refund, prompt, {
    pace: 0,
    timeScale: 0,
    autoApprove: true,
    startedAt: Date.now() - 26 * HOUR,
  });
  await new Promise<void>((resolve) => {
    const check = () =>
      run.done && refund.activeRunId === null ? resolve() : setTimeout(check, 10);
    check();
  });
  // Seeded history has realistic durations rather than the instant build.
  run.detail = {
    ...run.detail,
    usage: run.detail.usage
      ? { ...run.detail.usage, durationMs: 31_400, durationApiMs: 19_800 }
      : null,
    finishedAt: new Date(Date.now() - 26 * HOUR + 31_400).toISOString(),
  };
  const last = refund.messages.at(-1);
  if (last?.metadata?.usage)
    last.metadata = { ...last.metadata, usage: { ...last.metadata.usage, durationMs: 31_400 } };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = new Hono();

app.use("/api/*", async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PATCH") {
    if (c.req.header(CSRF_HEADER) !== CSRF_TOKEN) {
      return c.json(
        { error: { code: "csrf_failed", message: "The session expired. Reload the page." } },
        403,
      );
    }
  }
  await next();
});

app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "revenue-desk", version: "0.0.0-stub" }),
);
app.get("/api/session", (c) => {
  const session: SessionInfo = {
    csrfToken: CSRF_TOKEN,
    version: "0.0.0-stub",
    mode: "normal",
    model: MODEL,
    effort: "medium",
    businessDate: "2026-09-28",
    approvalTimeoutMs: 900_000,
    modelConfigured: true,
  };
  return c.json(session);
});

app.get("/api/conversations", (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase();
  const items = [...conversations.values()]
    .filter((conversation) => conversation.archivedAt === null)
    .filter((conversation) => q === "" || conversation.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summaryOf);
  return c.json({ items, nextCursor: null });
});

app.post("/api/conversations", async (c) => {
  const body = (await c.req.json()) as { title?: string };
  const conversation = addConversation(body.title ?? "", 0);
  return c.json({ conversation: summaryOf(conversation) }, 201);
});

app.get("/api/conversations/:id", (c) => {
  const conversation = conversations.get(c.req.param("id"));
  if (!conversation)
    return c.json({ error: { code: "not_found", message: "No such conversation." } }, 404);
  const active = conversation.activeRunId ? runs.get(conversation.activeRunId) : undefined;
  return c.json({
    conversation: summaryOf(conversation),
    messages: conversation.messages,
    pendingApprovals: active
      ? active.detail.approvals.filter((approval) => approval.status === "pending")
      : [],
  });
});

app.patch("/api/conversations/:id", async (c) => {
  const conversation = conversations.get(c.req.param("id"));
  if (!conversation)
    return c.json({ error: { code: "not_found", message: "No such conversation." } }, 404);
  const body = (await c.req.json()) as { title?: string; archived?: boolean };
  if (body.title !== undefined) conversation.title = body.title;
  if (body.archived !== undefined)
    conversation.archivedAt = body.archived ? new Date().toISOString() : null;
  return c.json({ conversation: summaryOf(conversation) });
});

app.post("/api/chat", async (c) => {
  const body = (await c.req.json()) as { conversationId: string; message: ChatUIMessage };
  const conversation = conversations.get(body.conversationId);
  if (!conversation)
    return c.json({ error: { code: "not_found", message: "No such conversation." } }, 404);
  if (conversation.activeRunId)
    return c.json(
      {
        error: { code: "run_active", message: "This conversation already has a run in progress." },
      },
      409,
    );
  conversation.messages.push(body.message);
  const prompt = body.message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ");
  const pace = Number(process.env.STUB_PACE_MS ?? 35);
  const timeScale = Number(process.env.STUB_TIME_SCALE ?? 1);
  return streamRun(startRun(conversation, prompt, { pace, timeScale }));
});

app.get("/api/chat/:id/stream", (c) => {
  const conversation = conversations.get(c.req.param("id"));
  const run = conversation?.activeRunId ? runs.get(conversation.activeRunId) : undefined;
  if (!run || run.done) return c.body(null, 204);
  return streamRun(run);
});

app.post("/api/approvals/:id", async (c) => {
  const body = (await c.req.json()) as { approved: boolean; reason?: string };
  for (const run of runs.values()) {
    const settle = run.waiters.get(c.req.param("id"));
    if (settle) {
      settle({
        approved: body.approved,
        decidedBy: "user",
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return c.json({ status: "accepted", approvalId: c.req.param("id") });
    }
  }
  return c.json({ error: { code: "not_found", message: "No pending approval has this id." } }, 404);
});

app.post("/api/runs/:id/stop", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: { code: "not_found", message: "No such run." } }, 404);
  if (run.done)
    return c.json({ error: { code: "run_not_active", message: "The run is not running." } }, 409);
  run.abort.abort("user");
  return c.json({ runId: run.detail.id, status: "stopping" }, 202);
});

app.get("/api/runs", (c) => {
  const status = c.req.query("status");
  const source = c.req.query("source");
  const items = [...runs.values()]
    .map((run) => summarize(run.detail))
    .filter(
      (run) => (status ? run.status === status : true) && (source ? run.source === source : true),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return c.json({ items, nextCursor: null });
});

app.get("/api/runs/:id", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: { code: "not_found", message: "No such run." } }, 404);
  return c.json(run.detail);
});

app.get("/api/connections", (c) => c.json({ items: connections }));
app.post("/api/connections/:integration/check", async (c) => {
  await new Promise((resolve) => setTimeout(resolve, 900));
  const integration = c.req.param("integration") as IntegrationId;
  connections = connections.map((connection) =>
    connection.integration === integration && connection.state !== "not_configured"
      ? { ...connection, checkedAt: new Date().toISOString() }
      : connection,
  );
  const connection = connections.find((item) => item.integration === integration);
  return connection
    ? c.json({ connection })
    : c.json({ error: { code: "not_found", message: "Unknown integration." } }, 404);
});
app.post("/api/connections/:integration/connect", (c) =>
  c.json({ redirectUrl: "https://connect.composio.dev/link/stub-google-calendar" }),
);

app.get("/api/settings", (c) => c.json({ settings }));
app.patch("/api/settings", async (c) => {
  const patch = (await c.req.json()) as Partial<WorkspaceSettings>;
  settings = { ...settings, ...patch, updatedAt: new Date().toISOString() };
  return c.json({ settings });
});
app.get("/api/policies", (c) => c.json({ policies }));
app.patch("/api/policies", async (c) => {
  const body = (await c.req.json()) as {
    modes: Partial<Record<(typeof ACTION_CLASSES)[number], ApprovalMode>>;
  };
  policies = policies.map((policy) => {
    const mode = body.modes[policy.actionClass];
    return mode && !policy.locked ? { ...policy, mode, source: "saved" } : policy;
  });
  return c.json({ policies });
});

app.all("/api/*", (c) =>
  c.json({ error: { code: "not_found", message: "Unknown API route" } }, 404),
);

const webRoot = fileURLToPath(new URL("../../../dist/web", import.meta.url));
if (!existsSync(`${webRoot}/index.html`))
  throw new Error("Run pnpm build (or vite build) first: dist/web is missing.");
app.use("/*", serveStatic({ root: webRoot }));
app.get("/*", serveStatic({ root: webRoot, path: "index.html" }));

await seed();
const port = Number(process.argv[2] ?? 4399);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  process.stderr.write(`web stub on http://127.0.0.1:${info.port}\n`);
});
