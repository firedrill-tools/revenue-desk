// Test harness for the database repositories and the HTTP server (W3).
//
// Everything is in process: a real SQLite file in a temporary state
// directory, the real Hono app reached through app.request, and fakes for
// what other workstreams provide (the agent core's runTurn, the integration
// definitions, the redactor). The approval gate is the policy's own
// (src/policy/approvals.ts) over the server's real SQLite store.
// Nothing here opens a socket or reaches a network.

import { type InferUIMessageChunk, readUIMessageStream, type UIMessageChunk } from "ai";
import type { Hono } from "hono";
import { type ChatUIMessage, CSRF_HEADER, SESSION_COOKIE } from "../../../src/contracts/api.js";
import type { AgentEnv, SecretValue } from "../../../src/contracts/env.js";
import type {
  AgentEvent,
  ApprovalDescriptor,
  ApprovalOutcome,
  RunConnection,
  RunTurn,
  RunTurnInput,
  ToolMetadata,
} from "../../../src/contracts/events.js";
import {
  type ConnectionResolution,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationDefinition,
  type IntegrationId,
  type ProbeResult,
  type ResolvedConnectionOf,
} from "../../../src/contracts/integration.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import type { RevenueDeskDatabase } from "../../../src/db/client.js";
import { USER_DENIAL_REASON } from "../../../src/policy/approvals.js";
import { createApp } from "../../../src/server/app.js";
import type { ComposioAuthorizer } from "../../../src/server/connections.js";
import type { Redact } from "../../../src/server/redaction.js";
import {
  createApiServices,
  prepareDatabase,
  type ServerDependencies,
} from "../../../src/server/runtime.js";
import type { ApiServices } from "../../../src/server/services.js";
import {
  cleanupAll,
  GONE_OWNER,
  LIVE_OWNER,
  onCleanup,
  openTestDatabase,
  probeOf,
  refundDescriptor,
  TEST_OWNERSHIP,
  TEST_SELF,
  tempStateDir,
} from "../db/support.js";

export const HOST = "127.0.0.1:4320";
export const ORIGIN = `http://${HOST}`;
export const TEST_SECRET = "sk_test_harnessSecretValue0001";

export {
  cleanupAll,
  GONE_OWNER,
  LIVE_OWNER,
  openTestDatabase,
  probeOf,
  refundDescriptor,
  TEST_OWNERSHIP,
  TEST_SELF,
  tempStateDir,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function secret(value: string): SecretValue {
  return {
    reveal: () => value,
    toString: () => "[redacted]",
    toJSON: () => "[redacted]",
  };
}

export function testEnv(stateDir: string, runtime: Partial<AgentEnv["runtime"]> = {}): AgentEnv {
  return {
    model: {
      apiKey: secret("sk-ant-test-0000000000"),
      baseUrl: null,
      model: "claude-sonnet-5",
      effort: "medium",
      thinkingDisplay: null,
      maxTurns: 30,
      maxBudgetUsd: 2,
    },
    runtime: {
      port: 0,
      stateDir,
      policyOverrides: {},
      businessDate: "2026-09-28",
      approvalTimeoutMs: 900_000,
      sandbox: false,
      dotenvPath: null,
      ...runtime,
    },
    passthrough: {
      HTTP_PROXY: null,
      HTTPS_PROXY: null,
      NO_PROXY: null,
      CLAUDE_CODE_MAX_RETRIES: null,
    },
    composio: { apiKey: null, userId: null, baseUrl: "https://backend.composio.dev" },
    hubspot: { accessToken: null, apiBaseUrl: null, mcpUrl: null, mcpToken: null, command: null },
    stripe: {
      secretKey: null,
      allowLive: false,
      apiBaseUrl: "https://api.stripe.com",
      apiVersion: null,
    },
    quickbooks: {
      accessToken: null,
      realmId: null,
      apiBaseUrl: "https://sandbox-quickbooks.api.intuit.com",
      minorVersion: null,
    },
    slack: { botToken: null, apiBaseUrl: "https://slack.com" },
  };
}

/** Replaces the test secret and bearer tokens, like the real redactor. */
export const testRedact: Redact = (text) =>
  text
    .split(TEST_SECRET)
    .join("[redacted]")
    .replace(/\bBearer\s+\S+/g, "Bearer [redacted]");

// ---------------------------------------------------------------------------
// Integration definitions (fakes of W2's, with scripted configuration and probes)
// ---------------------------------------------------------------------------

export type FakeConfiguration = "configured" | "not_configured" | "invalid";

export type FakeIntegrationOptions = {
  /** Default: not_configured. */
  readonly configuration?: Partial<Record<IntegrationId, FakeConfiguration>>;
  /** Default: connected. An Error makes the probe throw. */
  readonly probes?: Partial<Record<IntegrationId, ProbeResult | Error>>;
};

export const CONNECTIONS: { readonly [I in IntegrationId]: ResolvedConnectionOf<I> } = {
  gmail: {
    integration: "gmail",
    kind: "composio",
    profile: "composio",
    endpointLabel: "backend.composio.dev",
    composio: {
      apiKey: secret(TEST_SECRET),
      userId: "user_test",
      baseUrl: "https://backend.composio.dev",
      toolkit: "gmail",
    },
  },
  google_calendar: {
    integration: "google_calendar",
    kind: "composio",
    profile: "composio",
    endpointLabel: "backend.composio.dev",
    composio: {
      apiKey: secret(TEST_SECRET),
      userId: "user_test",
      baseUrl: "https://backend.composio.dev",
      toolkit: "googlecalendar",
    },
  },
  hubspot: {
    integration: "hubspot",
    kind: "mcp",
    profile: "hubspot-mcp-0.4",
    endpointLabel: "127.0.0.1",
    mcp: { transport: "http", url: "http://127.0.0.1:9/mcp", token: null },
  },
  stripe: {
    integration: "stripe",
    kind: "api",
    profile: "stripe-api",
    endpointLabel: "api.stripe.com",
    api: {
      baseUrl: "https://api.stripe.com",
      secretKey: secret(TEST_SECRET),
      keyMode: "test",
      apiVersion: null,
    },
  },
  quickbooks: {
    integration: "quickbooks",
    kind: "api",
    profile: "quickbooks-api",
    endpointLabel: "sandbox-quickbooks.api.intuit.com",
    api: {
      baseUrl: "https://sandbox-quickbooks.api.intuit.com",
      accessToken: secret(TEST_SECRET),
      realmId: "9130",
      minorVersion: null,
    },
  },
  slack: {
    integration: "slack",
    kind: "api",
    profile: "slack-api",
    endpointLabel: "slack.com",
    api: { baseUrl: "https://slack.com", botToken: secret(TEST_SECRET) },
  },
};

export const MISSING_VARS = {
  gmail: ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID"],
  google_calendar: ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID"],
  hubspot: ["HUBSPOT_ACCESS_TOKEN"],
  stripe: ["STRIPE_SECRET_KEY"],
  quickbooks: ["QBO_ACCESS_TOKEN", "QBO_REALM_ID"],
  slack: ["SLACK_BOT_TOKEN"],
} as const satisfies { readonly [I in IntegrationId]: readonly string[] };

export type FakeIntegrations = {
  readonly definitions: readonly IntegrationDefinition[];
  /** How many times each probe ran. */
  readonly probeCalls: Map<IntegrationId, number>;
};

export function fakeIntegrations(options: FakeIntegrationOptions = {}): FakeIntegrations {
  const probeCalls = new Map<IntegrationId, number>();
  const definition = <I extends IntegrationId>(id: I): IntegrationDefinition<I> => ({
    id,
    label: INTEGRATIONS[id].label,
    kind: INTEGRATIONS[id].kind,
    profile: { id: INTEGRATIONS[id].profile, integration: id, tools: {} },
    resolve(): ConnectionResolution<I> {
      const configuration = options.configuration?.[id] ?? "not_configured";
      if (configuration === "configured")
        return { status: "configured", connection: CONNECTIONS[id] };
      if (configuration === "invalid") {
        return {
          status: "invalid",
          problems: [{ variable: "STRIPE_SECRET_KEY", message: "Live keys are refused." }],
        };
      }
      return { status: "not_configured", missing: MISSING_VARS[id] };
    },
    classify: () => null,
    async probe(): Promise<ProbeResult> {
      probeCalls.set(id, (probeCalls.get(id) ?? 0) + 1);
      const probe = options.probes?.[id];
      if (probe instanceof Error) throw probe;
      return (
        probe ?? {
          state: "connected",
          detail: `${INTEGRATIONS[id].label} connected`,
          accountHint: null,
        }
      );
    },
  });
  return {
    definitions: INTEGRATION_IDS.map((id) => definition(id) as IntegrationDefinition),
    probeCalls,
  };
}

export { STOP_REASON } from "../../../src/policy/approvals.js";

// ---------------------------------------------------------------------------
// A scripted agent core: a fake runTurn that yields AgentEvents in the order
// the real core does and uses the approval gate the way it does.
// ---------------------------------------------------------------------------

export type Script = (input: RunTurnInput) => AsyncGenerator<AgentEvent, void, void>;

export type ScriptedCore = {
  readonly runTurn: RunTurn;
  readonly inputs: RunTurnInput[];
};

export function scriptedCore(script: Script): ScriptedCore {
  const inputs: RunTurnInput[] = [];
  return {
    inputs,
    runTurn: (input) => {
      inputs.push(input);
      return script(input);
    },
  };
}

export function runConnections(input: RunTurnInput): RunConnection[] {
  return input.connections.map((plan) => {
    const info = INTEGRATIONS[plan.integration];
    return plan.status === "available"
      ? {
          integration: plan.integration,
          kind: info.kind,
          profile: info.profile,
          availability: "ready",
          state: "connected",
          detail: null,
          endpointLabel: plan.connection.endpointLabel,
        }
      : {
          integration: plan.integration,
          kind: info.kind,
          profile: info.profile,
          availability: "unavailable",
          state: plan.state,
          detail: plan.detail,
          endpointLabel: null,
        };
  });
}

export const ev = {
  started(input: RunTurnInput): AgentEvent {
    return {
      type: "run.started",
      runId: input.runId,
      conversationId: input.conversationId,
      source: input.source,
      mode: input.mode,
      model: input.model.model,
      effort: input.model.effort,
      startedAt: new Date().toISOString(),
      connections: runConnections(input),
    };
  },
  *text(id: string, text: string): Generator<AgentEvent> {
    yield { type: "text.start", id };
    for (const delta of text.match(/\S+\s*/g) ?? []) yield { type: "text.delta", id, delta };
    yield { type: "text.end", id };
  },
  *reasoning(id: string, text: string): Generator<AgentEvent> {
    yield { type: "reasoning.start", id };
    for (const delta of text.match(/\S+\s*/g) ?? []) yield { type: "reasoning.delta", id, delta };
    yield { type: "reasoning.end", id };
  },
  *toolInput(call: ToolCallScript): Generator<AgentEvent> {
    yield {
      type: "tool.input.start",
      toolCallId: call.id,
      toolName: call.toolName,
      title: call.title,
      tool: call.tool,
    };
    const json = JSON.stringify(call.input);
    const size = Math.max(4, Math.ceil(json.length / 3));
    for (let index = 0; index < json.length; index += size) {
      yield {
        type: "tool.input.delta",
        toolCallId: call.id,
        inputTextDelta: json.slice(index, index + size),
      };
    }
    yield {
      type: "tool.input.available",
      toolCallId: call.id,
      toolName: call.toolName,
      title: call.title,
      input: call.input,
      tool: call.tool,
    };
  },
  output(
    toolCallId: string,
    output: JsonObject,
    extra: Partial<AgentEvent & { type: "tool.output" }> = {},
  ): AgentEvent {
    return {
      type: "tool.output",
      toolCallId,
      output,
      truncated: false,
      isError: false,
      error: null,
      durationMs: 42,
      execution: { upstreamTool: "POST /v1/refunds", httpStatus: 200, idempotencyKey: "idem_1" },
      ...extra,
    } as AgentEvent;
  },
  usage(costUsd = 0.0123): AgentEvent {
    return {
      type: "usage",
      costUsd,
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      numTurns: 2,
      modelRequests: 2,
      durationMs: 5000,
      durationApiMs: 4000,
    };
  },
  finished(
    status: "completed" | "failed" | "cancelled" | "timed_out",
    extra: {
      stopReason?: string | null;
      error?: { code: "model_error" | "internal"; message: string } | null;
    } = {},
  ): AgentEvent {
    return {
      type: "run.finished",
      status,
      finishedAt: new Date().toISOString(),
      stopReason: extra.stopReason ?? null,
      terminalReason: status === "completed" ? "completed" : null,
      reply: null,
      error: extra.error ?? null,
    };
  },
};

export type ToolCallScript = {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly input: JsonObject;
  readonly tool: ToolMetadata | null;
};

export const REFUND_CALL: ToolCallScript = {
  id: "toolu_refund_1",
  toolName: "mcp__stripe__create_refund",
  title: "Refund charge in Stripe",
  input: { charge: "ch_dup_0002", amount: 4900, reason: "duplicate" },
  tool: {
    integration: "stripe",
    connectionKind: "api",
    operation: "stripe.refunds.create",
    actionClass: "financial",
  },
};

export const LOOKUP_CALL: ToolCallScript = {
  id: "toolu_lookup_1",
  toolName: "mcp__stripe__list_charges",
  title: "List charges in Stripe",
  input: { customer: "cus_kestrel" },
  tool: {
    integration: "stripe",
    connectionKind: "api",
    operation: "stripe.charges.list",
    actionClass: "read",
  },
};

/**
 * Asks for approval the way the core does: open() (persist + register) first,
 * then approval.requested, then the decision's approval.resolved.
 */
export async function* askApproval(
  input: RunTurnInput,
  toolCallId: string,
  approvalId: string,
  descriptor: ApprovalDescriptor,
): AsyncGenerator<AgentEvent, ApprovalOutcome, void> {
  if (input.mode !== "interactive") throw new Error("askApproval needs an interactive run");
  const pending = await input.approvals.open(
    {
      approvalId,
      runId: input.runId,
      conversationId: input.conversationId,
      toolCallId,
      descriptor,
    },
    input.signal,
  );
  yield { type: "approval.requested", approvalId, toolCallId, descriptor };
  const outcome = await pending.decision;
  yield {
    type: "approval.resolved",
    approvalId,
    toolCallId,
    approved: outcome.approved,
    decidedBy: outcome.decidedBy,
    reason: outcome.reason,
  };
  return outcome;
}

/** The J2 refund turn: read, text, a refund held for approval, then the closing text. */
export const refundScript: Script = async function* (input) {
  yield ev.started(input);
  yield { type: "session", sdkSessionId: "sess_refund" };
  yield { type: "status", status: { phase: "requesting" } };
  yield { type: "step.start" };
  yield* ev.reasoning("r1", "Two identical charges on one invoice; the second is a duplicate.");
  yield* ev.text("t1", "I found a duplicate $49.00 charge. I'll refund it once you approve.");
  yield* ev.toolInput(REFUND_CALL);
  yield { type: "step.finish" };
  const outcome = yield* askApproval(input, REFUND_CALL.id, "apr_refund_1", refundDescriptor());
  if (outcome.approved) {
    yield { type: "tool.progress", toolCallId: REFUND_CALL.id, elapsedMs: 250 };
    yield ev.output(REFUND_CALL.id, { id: "re_1", status: "succeeded", amount: 4900 });
  } else {
    yield {
      type: "tool.denied",
      toolCallId: REFUND_CALL.id,
      decision:
        outcome.decidedBy === "stop"
          ? "stopped"
          : outcome.decidedBy === "timeout"
            ? "timed_out"
            : "denied",
      reason: outcome.reason ?? USER_DENIAL_REASON,
    };
    if (outcome.decidedBy === "stop") {
      yield ev.finished("cancelled", { stopReason: "user" });
      return;
    }
  }
  yield { type: "step.start" };
  yield* ev.text(
    "t2",
    outcome.approved ? "Refunded $49.00 (re_1)." : "I did not refund the charge.",
  );
  yield { type: "step.finish" };
  yield ev.usage();
  yield ev.finished("completed");
};

/** A turn that answers with one text block. */
export const answerScript: Script = async function* (input) {
  yield ev.started(input);
  yield { type: "step.start" };
  yield* ev.text("t1", `You said: ${input.prompt}`);
  yield { type: "step.finish" };
  yield ev.usage(0.001);
  yield ev.finished("completed");
};

/** A turn that waits until released (or stopped), for concurrency tests. */
export function heldScript(): { script: Script; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    release: resolve,
    script: async function* (input) {
      yield ev.started(input);
      yield { type: "step.start" };
      await Promise.race([
        promise,
        new Promise<void>((done) =>
          input.signal.addEventListener("abort", () => done(), { once: true }),
        ),
      ]);
      yield* ev.text("t1", "Done waiting.");
      yield { type: "step.finish" };
      yield input.signal.aborted
        ? ev.finished("cancelled", { stopReason: "user" })
        : ev.finished("completed");
    },
  };
}

// ---------------------------------------------------------------------------
// The server under test
// ---------------------------------------------------------------------------

export type TestServerOptions = {
  readonly script?: Script;
  readonly runTurn?: RunTurn;
  readonly integrations?: FakeIntegrationOptions;
  readonly runtime?: Partial<AgentEnv["runtime"]>;
  readonly authorizeComposio?: ComposioAuthorizer;
  readonly maxConcurrentRuns?: number;
  readonly stopGraceMs?: number;
  readonly stateDir?: string;
  /** Run ownership seams. Default TEST_OWNERSHIP: LIVE_OWNER runs, GONE_OWNER does not. */
  readonly ownership?: ServerDependencies["ownership"];
};

export type TestServer = {
  readonly app: Hono;
  readonly services: ApiServices;
  readonly database: RevenueDeskDatabase;
  readonly core: ScriptedCore | null;
  /** The approval gate (src/policy/approvals.ts) over this server's approvals table. */
  readonly gate: ApiServices["approvals"];
  readonly integrations: FakeIntegrations;
  readonly logs: string[];
  /** A request with a loopback Host and, for mutations, the session cookie, CSRF token and JSON. */
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /** fetch() routed into the app with the session headers, for the AI SDK transport. */
  readonly fetch: typeof globalThis.fetch;
  createConversation(title?: string): Promise<string>;
};

export function createTestServer(options: TestServerOptions = {}): TestServer {
  const stateDir = options.stateDir ?? tempStateDir();
  const database = openTestDatabase(stateDir);
  const integrations = fakeIntegrations(options.integrations);
  const core = options.runTurn === undefined ? scriptedCore(options.script ?? answerScript) : null;
  const runTurn = options.runTurn ?? (core as ScriptedCore).runTurn;
  const logs: string[] = [];
  const services = createApiServices({
    db: database.db,
    env: testEnv(stateDir, options.runtime),
    runTurn,
    integrations: integrations.definitions,
    redact: testRedact,
    authorizeComposio:
      options.authorizeComposio ??
      (async () => {
        throw new Error("Connect was not expected in this test");
      }),
    version: "0.0.0-test",
    log: (line) => logs.push(line),
    ...(options.maxConcurrentRuns === undefined
      ? {}
      : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    ownership: options.ownership ?? TEST_OWNERSHIP,
  });
  prepareDatabase(services);
  const app = createApp({ version: "0.0.0-test", api: services });
  // Waiters live on globalThis: settle this server's leftovers so the next
  // test can reuse approval ids.
  onCleanup(() => {
    for (const id of services.approvals.pendingIds())
      services.approvals.decide(id, { approved: false });
  });
  const sessionHeaders = {
    host: HOST,
    origin: ORIGIN,
    cookie: `${SESSION_COOKIE}=${services.secrets.sessionId}`,
    [CSRF_HEADER]: services.secrets.csrfToken,
  };

  const request: TestServer["request"] = async (method, path, body, headers = {}) => {
    const mutating = method !== "GET" && method !== "HEAD";
    return app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(mutating ? { ...sessionHeaders, "content-type": "application/json" } : { host: HOST }),
        ...headers,
      },
      ...(mutating ? { body: body === undefined ? "{}" : JSON.stringify(body) } : {}),
    });
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(sessionHeaders)) headers.set(key, value);
    return app.request(new URL(url, ORIGIN).toString(), { ...init, headers });
  };

  return {
    app,
    services,
    database,
    core,
    gate: services.approvals,
    integrations,
    logs,
    request,
    fetch,
    async createConversation(title) {
      const response = await request(
        "POST",
        "/api/conversations",
        title === undefined ? {} : { title },
      );
      if (response.status !== 201) throw new Error(`create conversation: ${response.status}`);
      const body = (await response.json()) as { conversation: { id: string } };
      return body.conversation.id;
    },
  };
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

export type ChatChunk = InferUIMessageChunk<ChatUIMessage>;

export function userMessage(id: string, text: string): ChatUIMessage & { role: "user" } {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/** Parses an SSE body into chunks; asserts the [DONE] terminator. */
export async function readSse(response: Response): Promise<{ chunks: ChatChunk[]; done: boolean }> {
  const text = await response.text();
  const events = text.split("\n\n").filter((event) => event.length > 0);
  const chunks: ChatChunk[] = [];
  let done = false;
  for (const event of events) {
    const data = event.replace(/^data: /, "");
    if (data === "[DONE]") done = true;
    else chunks.push(JSON.parse(data) as ChatChunk);
  }
  return { chunks, done };
}

/** Reduces chunks with the AI SDK's reducer (the one useChat runs); returns the final message. */
export async function reduce(
  chunks: readonly UIMessageChunk[],
  message?: ChatUIMessage,
): Promise<ChatUIMessage | undefined> {
  let last: ChatUIMessage | undefined;
  for await (const snapshot of readUIMessageStream<ChatUIMessage>({
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    ...(message === undefined ? {} : { message }),
  })) {
    last = snapshot;
  }
  return last;
}

/** Chunk types in order, with consecutive repeats (deltas) collapsed. */
export function chunkTypes(chunks: readonly { readonly type: string }[]): string[] {
  return chunks.map((chunk) => chunk.type).filter((type, index, all) => type !== all[index - 1]);
}

/** Resolves when `predicate` holds, polling every few milliseconds (at most `timeoutMs`). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
