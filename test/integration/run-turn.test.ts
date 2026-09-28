/**
 * runTurn on the real Claude Agent SDK (native CLI) against the scripted
 * loopback Messages API, with minimal in-test integrations of every
 * connection kind: Stripe as an API integration, HubSpot as a Streamable HTTP
 * MCP upstream, Gmail as a Composio-style session upstream. Every scenario
 * checks the AgentEvent contract (src/contracts/events.ts) on the whole
 * stream. Fails, never skips, without the native CLI.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRunTurn, MISSING_MODEL_KEY_MESSAGE } from "../../src/agent/run-turn.js";
import type { ModelSettings } from "../../src/contracts/env.js";
import type {
  AgentEvent,
  AgentMode,
  ConnectionPlan,
  RunTurnInput,
} from "../../src/contracts/events.js";
import {
  DEFAULT_POLICY,
  HEADLESS_ASK_DENIAL,
  type PolicyModes,
} from "../../src/contracts/integration.js";
import { idempotencyKeyFor } from "../../src/gateway/context.js";
import { approvalWaiters, createApprovalGate } from "../../src/policy/approvals.js";
import {
  BUSINESS_DATE,
  gmailConnection,
  hubspotHttpConnection,
  plansWith,
  type StripeCall,
  stripeConnection,
  TEST_SETTINGS,
  tempStateDir,
  testCatalog,
  testEnv,
} from "../helpers/agent-fixtures.js";
import { MemoryApprovalStore } from "../helpers/approval-store.js";
import { eventContractViolations, forCall, ofType } from "../helpers/event-contract.js";
import {
  type MessagesBody,
  type Responder,
  type ScriptedBlock,
  type ScriptedUsage,
  startMockAnthropic,
  toolResults,
} from "../support/mock-anthropic.js";
import {
  messageBodies,
  offeredTools,
  requireNativeSdkBinary,
  stepIndex,
  strayTraffic,
  systemText,
} from "../support/sdk-gate-support.js";
import { CRM_TOOLS, MAIL_TOOLS, startHttpUpstream } from "../support/upstream-mcp.js";

const KEY = `sk-ant-dummy-${"k".repeat(40)}`;
const CRM_TOKEN = `crm-upstream-${"t".repeat(24)}`;
const MAIL_TOKEN = `mail-upstream-${"m".repeat(24)}`;
const TIMEOUT = { timeout: 120_000 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  approvalWaiters().clear();
});

const use = (id: string, name: string, input: unknown): ScriptedBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const text = (value: string): ScriptedBlock => ({ type: "text", text: value });
const isMainLoop = (body: MessagesBody) => offeredTools(body).includes("mcp__stripe__list_charges");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A responder that answers main-loop requests step by step within the current prompt. */
function steps(...replies: (readonly ScriptedBlock[])[]): Responder {
  return (body) => {
    if (!isMainLoop(body)) return undefined;
    return replies[stepIndex(body)] ?? [text("(no more script)")];
  };
}

type AgentOptions = {
  readonly responder: Responder;
  readonly usage?: ScriptedUsage;
  readonly hubspotUrl?: string;
  readonly environment?: Record<string, string>;
};

async function agent(options: AgentOptions) {
  requireNativeSdkBinary();
  const state = tempStateDir("revenue-desk-run-");
  cleanups.push(state.cleanup);
  const mock = await startMockAnthropic(KEY, options.responder, {
    ...(options.usage === undefined ? {} : { usage: () => options.usage as ScriptedUsage }),
  });
  cleanups.push(() => mock.close());
  const crm = await startHttpUpstream({ token: CRM_TOKEN, tools: CRM_TOOLS, name: "crm" });
  const mail = await startHttpUpstream({ token: MAIL_TOKEN, tools: MAIL_TOOLS, name: "mail" });
  cleanups.push(
    () => crm.close(),
    () => mail.close(),
  );
  const stripeCalls: StripeCall[] = [];
  const composioRequests: { toolkits: readonly string[]; access: string }[] = [];
  const stderr: string[] = [];
  const runTurn = createRunTurn({
    catalog: testCatalog({
      stripeCalls,
      composio: async (toolkits, access) => {
        composioRequests.push({ toolkits, access });
        return {
          transport: "http",
          url: mail.url,
          headers: { Authorization: `Bearer ${MAIL_TOKEN}` },
        };
      },
    }),
    version: "0.0.0-test",
    progressIntervalMs: 50,
    connectTimeoutMs: 3_000,
    onStderr: (line) => stderr.push(line),
  });
  const env = testEnv({
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: mock.url,
    AGENT_STATE_DIR: state.dir,
    HTTP_PROXY: mock.url,
    HTTPS_PROXY: mock.url,
    NO_PROXY: "127.0.0.1,localhost",
    CLAUDE_CODE_MAX_RETRIES: "0",
    ...options.environment,
  });
  const store = new MemoryApprovalStore();
  const gate = createApprovalGate({ store });
  const plans: ConnectionPlan[] = plansWith([
    { integration: "stripe", status: "available", connection: stripeConnection() },
    {
      integration: "hubspot",
      status: "available",
      connection: hubspotHttpConnection(options.hubspotUrl ?? crm.url, CRM_TOKEN),
    },
    { integration: "gmail", status: "available", connection: gmailConnection() },
  ]);
  let runs = 0;
  const input = (
    overrides: {
      readonly prompt?: string;
      readonly mode?: AgentMode;
      readonly policy?: PolicyModes;
      readonly model?: Partial<ModelSettings>;
      readonly resumeSessionId?: string | null;
      readonly signal?: AbortSignal;
      readonly env?: typeof env;
    } = {},
  ): RunTurnInput => {
    runs += 1;
    const common = {
      runId: `run_${runs}`,
      conversationId: "conv_1",
      source: "ui" as const,
      prompt: overrides.prompt ?? "Ana at Acme says she was charged twice. Sort it out.",
      resumeSessionId: overrides.resumeSessionId ?? null,
      env: overrides.env ?? env,
      model: {
        model: "claude-sonnet-5",
        effort: "medium" as const,
        thinkingDisplay: "summarized" as const,
        maxTurns: 8,
        maxBudgetUsd: 2,
        ...overrides.model,
      },
      settings: TEST_SETTINGS,
      policy: overrides.policy ?? DEFAULT_POLICY,
      businessDate: BUSINESS_DATE,
      connections: plans,
      signal: overrides.signal ?? new AbortController().signal,
    };
    return (overrides.mode ?? "interactive") === "headless"
      ? { ...common, mode: "headless" }
      : { ...common, mode: "interactive", approvals: gate };
  };
  /** Runs one turn, calling onEvent for each event as it arrives. */
  const run = async (
    turn: RunTurnInput,
    onEvent: (event: AgentEvent, events: readonly AgentEvent[]) => void | Promise<void> = () => {},
  ) => {
    const events: AgentEvent[] = [];
    for await (const event of runTurn(turn)) {
      events.push(event);
      await onEvent(event, events);
    }
    return events;
  };
  const mainBodies = () => messageBodies(mock.requests).filter(isMainLoop);
  return {
    mock,
    crm,
    mail,
    stripeCalls,
    composioRequests,
    stderr,
    store,
    gate,
    env,
    input,
    run,
    mainBodies,
  };
}

function finished(events: readonly AgentEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "run.finished") throw new Error("the stream did not end with run.finished");
  return last;
}

function expectContract(events: readonly AgentEvent[], stderr: readonly string[] = []) {
  expect(eventContractViolations(events), stderr.join("")).toEqual([]);
}

describe("runTurn on the real Claude Agent SDK", () => {
  it(
    "reads across API, MCP and Composio, writes internally without asking, and replies",
    TIMEOUT,
    async () => {
      const a = await agent({
        responder: steps(
          [
            { type: "thinking", thinking: "Look in all three systems first.", signature: "sig_0" },
            text("Checking Gmail, HubSpot and Stripe."),
            use("toolu_charges", "mcp__stripe__list_charges", { customer: "cus_123", limit: 10 }),
            use("toolu_crm", "mcp__hubspot__search_contacts", { query: "ana@acme.test" }),
            use("toolu_mail", "mcp__gmail__GMAIL_FETCH_EMAILS", { query: "from:ana@acme.test" }),
          ],
          [
            use("toolu_note", "mcp__hubspot__create_note", {
              contact_id: "101",
              body: "Duplicate charge ch_2 under review.",
            }),
            use("toolu_draft", "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT", {
              recipient_email: "ana@acme.test",
              subject: "Your duplicate charge",
              body: "We are looking into it.",
            }),
          ],
          [text("Ana was charged twice (ch_1 and ch_2, $49.00 each). I drafted a reply.")],
        ),
      });
      const turn = a.input();
      const events = await a.run(turn);
      expectContract(events, a.stderr);

      const started = events[0];
      expect(started).toMatchObject({
        type: "run.started",
        runId: turn.runId,
        conversationId: "conv_1",
        source: "ui",
        mode: "interactive",
        model: "claude-sonnet-5",
        effort: "medium",
      });
      if (started?.type !== "run.started") throw new Error("no run.started");
      expect(
        started.connections.map((connection) => [connection.integration, connection.availability]),
      ).toEqual([
        ["gmail", "ready"],
        ["google_calendar", "unavailable"],
        ["hubspot", "ready"],
        ["stripe", "ready"],
        ["quickbooks", "unavailable"],
        ["slack", "unavailable"],
      ]);
      expect(ofType(events, "session")).toHaveLength(1);
      expect(ofType(events, "step.start")).toHaveLength(3);
      expect(
        ofType(events, "reasoning.delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe("Look in all three systems first.");

      expect(forCall(events, "toolu_charges")[0]).toEqual({
        type: "tool.input.start",
        toolCallId: "toolu_charges",
        toolName: "mcp__stripe__list_charges",
        title: "List charges in Stripe",
        tool: {
          integration: "stripe",
          connectionKind: "api",
          operation: "stripe.charges.list",
          actionClass: "read",
        },
      });
      expect(
        ofType(events, "tool.input.available").map((event) => event.tool?.connectionKind),
      ).toEqual(["api", "mcp", "composio", "mcp", "composio"]);
      const outputs = new Map(
        ofType(events, "tool.output").map((event) => [event.toolCallId, event]),
      );
      expect(outputs.get("toolu_charges")).toMatchObject({
        isError: false,
        truncated: false,
        output: { data: [{ id: "ch_1" }, { id: "ch_2" }] },
        execution: {
          upstreamTool: "GET /v1/charges",
          // A read reports its status; it sends no idempotency key, so none is recorded.
          httpStatus: 200,
          idempotencyKey: null,
        },
      });
      // MCP and Composio calls send no idempotency key and report no HTTP status.
      expect(outputs.get("toolu_crm")?.execution).toMatchObject({
        upstreamTool: "search_contacts",
        httpStatus: null,
        idempotencyKey: null,
      });
      expect(outputs.get("toolu_mail")?.execution).toMatchObject({
        upstreamTool: "GMAIL_FETCH_EMAILS",
        httpStatus: null,
        idempotencyKey: null,
      });
      expect(outputs.get("toolu_note")?.output).toMatchObject({ note_id: "n_1" });
      expect(outputs.size).toBe(5);
      expect(ofType(events, "approval.requested")).toEqual([]);

      const usage = ofType(events, "usage")[0];
      expect(usage?.costUsd).toBeGreaterThan(0);
      expect(usage).toMatchObject({ modelRequests: 3, inputTokens: 36, outputTokens: 18 });
      expect(finished(events)).toMatchObject({
        status: "completed",
        error: null,
        stopReason: null,
        terminalReason: "completed",
        reply: "Ana was charged twice (ch_1 and ch_2, $49.00 each). I drafted a reply.",
      });

      const system = systemText(a.mainBodies()[0] as MessagesBody);
      expect(system).toContain("Today's business date is Monday, 2026-09-28");
      expect(system).toContain("Company: Kestrel Analytics");
      expect(system).not.toContain("mcp__");
      expect(strayTraffic(a.mock.requests)).toEqual([]);
      const wire = JSON.stringify(a.mock.requests) + JSON.stringify(events);
      for (const secret of [CRM_TOKEN, MAIL_TOKEN, "s".repeat(24)])
        expect(wire).not.toContain(secret);
      expect(a.crm.calls.map((call) => call.tool)).toEqual(["search_contacts", "create_note"]);
      expect(a.mail.calls.map((call) => call.tool)).toEqual([
        "GMAIL_FETCH_EMAILS",
        "GMAIL_CREATE_EMAIL_DRAFT",
      ]);
    },
  );

  it(
    "holds a refund for approval with nothing running meanwhile, then runs it once",
    TIMEOUT,
    async () => {
      const a = await agent({
        responder: steps(
          [
            text("I will refund the duplicate charge ch_2 of $49.00."),
            use("toolu_refund", "mcp__stripe__create_refund", {
              charge: "ch_2",
              amount: 4900,
              reason: "duplicate",
            }),
          ],
          [text("Refunded $49.00 (re_1).")],
        ),
      });
      const turn = a.input();
      const events = await a.run(turn, async (event) => {
        if (event.type !== "approval.requested") return;
        const requests = a.mock.requests.length;
        await sleep(400);
        expect(a.mock.requests.length).toBe(requests);
        expect(a.stripeCalls).toEqual([]);
        expect(a.store.rows.get(event.approvalId)?.status).toBe("pending");
        expect(a.gate.decide(event.approvalId, { approved: true })).toBe("accepted");
      });
      expectContract(events, a.stderr);
      const requested = ofType(events, "approval.requested")[0];
      expect(requested?.descriptor).toMatchObject({
        consequence: "Refund $49.00 of ch_2",
        actionClass: "financial",
        integration: "stripe",
        connectionKind: "api",
        amount: { amountMinor: 4900, currency: "USD" },
      });
      expect(
        forCall(events, "toolu_refund")
          .map((event) => event.type)
          .filter((type) => type !== "tool.input.delta"),
      ).toEqual([
        "tool.input.start",
        "tool.input.available",
        "approval.requested",
        "approval.resolved",
        // The gateway announces the call as it starts executing it.
        "tool.progress",
        "tool.output",
      ]);
      const key = idempotencyKeyFor(turn.runId, "toolu_refund");
      expect(a.stripeCalls).toEqual([
        {
          tool: "create_refund",
          args: { charge: "ch_2", amount: 4900, reason: "duplicate" },
          key,
        },
      ]);
      expect(ofType(events, "tool.output")[0]?.execution).toMatchObject({
        httpStatus: 200,
        idempotencyKey: key,
      });
      expect(ofType(events, "approval.resolved")[0]).toMatchObject({
        approved: true,
        decidedBy: "user",
      });
      expect(finished(events)).toMatchObject({
        status: "completed",
        reply: "Refunded $49.00 (re_1).",
      });
    },
  );

  it("reports a declined send to the model, which does not retry it", TIMEOUT, async () => {
    const a = await agent({
      responder: steps(
        [use("toolu_send", "mcp__gmail__GMAIL_SEND_DRAFT", { draft_id: "r_1" })],
        [text("You declined sending the draft, so it was not sent.")],
      ),
    });
    const events = await a.run(a.input(), (event) => {
      if (event.type === "approval.requested") {
        a.gate.decide(event.approvalId, { approved: false, reason: "Not yet" });
      }
    });
    expectContract(events, a.stderr);
    const denial = "The user declined this action: Not yet. It was not run; do not retry it.";
    expect(ofType(events, "tool.denied")).toEqual([
      { type: "tool.denied", toolCallId: "toolu_send", decision: "denied", reason: denial },
    ]);
    expect(a.mail.calls).toEqual([]);
    const lastBody = a.mainBodies().at(-1) as MessagesBody;
    expect(toolResults(lastBody)).toContainEqual({ id: "toolu_send", text: denial, isError: true });
    expect(a.store.rows.values().next().value).toMatchObject({
      status: "denied",
      settlement: { decidedBy: "user", reason: "Not yet" },
    });
    expect(finished(events).status).toBe("completed");
  });

  it(
    "stops while an approval is pending: cancelled, nothing run, no further model request",
    TIMEOUT,
    async () => {
      const a = await agent({
        responder: steps(
          [use("toolu_refund", "mcp__stripe__create_refund", { charge: "ch_2", amount: 4900 })],
          [text("should never be requested")],
        ),
      });
      const stop = new AbortController();
      let stoppedAt = 0;
      const events = await a.run(a.input({ signal: stop.signal }), (event) => {
        if (event.type === "approval.requested") {
          stoppedAt = Date.now();
          stop.abort("user");
        }
      });
      expect(Date.now() - stoppedAt).toBeLessThan(5_000);
      expectContract(events, a.stderr);
      expect(ofType(events, "approval.resolved")[0]).toMatchObject({
        approved: false,
        decidedBy: "stop",
      });
      expect(ofType(events, "tool.denied")[0]).toMatchObject({
        toolCallId: "toolu_refund",
        decision: "stopped",
      });
      expect(finished(events)).toMatchObject({
        status: "cancelled",
        stopReason: "user",
        error: { code: "cancelled" },
      });
      expect(a.stripeCalls).toEqual([]);
      expect(a.mainBodies()).toHaveLength(1);
      expect([...a.store.rows.values()].map((row) => row.status)).toEqual(["cancelled"]);
    },
  );

  it(
    "rejects invalid arguments before any approval, and the model can correct them",
    TIMEOUT,
    async () => {
      const a = await agent({
        responder: steps(
          [use("toolu_bad", "mcp__stripe__create_refund", { charge: "ch_2", amount: "49.00" })],
          [text("The amount must be in minor units; I will not refund without it.")],
        ),
      });
      const events = await a.run(a.input());
      expectContract(events, a.stderr);
      expect(ofType(events, "approval.requested")).toEqual([]);
      expect(a.store.rows.size).toBe(0);
      expect(a.stripeCalls).toEqual([]);
      const denied = ofType(events, "tool.denied")[0];
      expect(denied).toMatchObject({ toolCallId: "toolu_bad", decision: "rejected" });
      expect(denied?.reason).toContain("`amount` must be integer");
      const result = toolResults(a.mainBodies().at(-1) as MessagesBody).find(
        (entry) => entry.id === "toolu_bad",
      );
      expect(result?.isError).toBe(true);
      expect(result?.text).toContain("Invalid arguments");
      expect(finished(events).status).toBe("completed");
    },
  );

  it("rejects a tool that was never offered", TIMEOUT, async () => {
    const a = await agent({
      responder: steps(
        [use("toolu_ghost", "mcp__stripe__delete_customer", { customer: "cus_1" })],
        [text("That is not something I can do.")],
      ),
    });
    const events = await a.run(a.input());
    expectContract(events, a.stderr);
    expect(forCall(events, "toolu_ghost")[0]).toMatchObject({
      title: "mcp__stripe__delete_customer",
      tool: null,
    });
    expect(ofType(events, "tool.denied")[0]).toMatchObject({
      toolCallId: "toolu_ghost",
      decision: "rejected",
      reason: expect.stringContaining("No such tool available"),
    });
  });

  it("denies ask actions in headless mode and policy denials anywhere", TIMEOUT, async () => {
    const a = await agent({
      responder: steps(
        [
          use("toolu_refund", "mcp__stripe__create_refund", { charge: "ch_2" }),
          use("toolu_send", "mcp__gmail__GMAIL_SEND_DRAFT", { draft_id: "r_1" }),
        ],
        [text("Both actions need a person.")],
      ),
    });
    const events = await a.run(
      a.input({ mode: "headless", policy: { ...DEFAULT_POLICY, outbound: "deny" } }),
    );
    expectContract(events, a.stderr);
    expect(events[0]).toMatchObject({ mode: "headless" });
    const denials = new Map(
      ofType(events, "tool.denied").map((event) => [event.toolCallId, event]),
    );
    expect(denials.get("toolu_refund")).toMatchObject({
      decision: "policy_denied",
      reason: HEADLESS_ASK_DENIAL,
    });
    expect(denials.get("toolu_send")?.decision).toBe("policy_denied");
    expect(a.stripeCalls).toEqual([]);
    expect(a.store.rows.size).toBe(0);
    // With outbound denied, the Composio session is created without send tools.
    expect(a.composioRequests).toEqual([{ toolkits: ["gmail"], access: "draft" }]);
  });

  it("times an approval out and carries on", TIMEOUT, async () => {
    const a = await agent({
      environment: { AGENT_APPROVAL_TIMEOUT_MS: "1000" },
      responder: steps(
        [use("toolu_refund", "mcp__stripe__create_refund", { charge: "ch_2" })],
        [text("No one approved the refund in time.")],
      ),
    });
    const events = await a.run(a.input());
    expectContract(events, a.stderr);
    expect(ofType(events, "approval.resolved")[0]).toMatchObject({ decidedBy: "timeout" });
    expect(ofType(events, "tool.denied")[0]).toMatchObject({
      decision: "timed_out",
      reason: "Not approved within 1 minute; the action was not run.",
    });
    expect([...a.store.rows.values()][0]?.status).toBe("expired");
    expect(finished(events).status).toBe("completed");
  });

  it("fails with max_turns at the turn limit", TIMEOUT, async () => {
    const a = await agent({
      responder: (body) =>
        isMainLoop(body)
          ? [use(`toolu_${stepIndex(body)}`, "mcp__stripe__list_charges", { customer: "cus_1" })]
          : undefined,
    });
    const events = await a.run(a.input({ model: { maxTurns: 1 } }));
    expectContract(events, a.stderr);
    expect(finished(events)).toMatchObject({
      status: "failed",
      terminalReason: "max_turns",
      error: { code: "max_turns" },
    });
    expect(ofType(events, "usage")).toHaveLength(1);
  });

  it(
    "fails with budget_exceeded at the spending limit and still logs the call that ran",
    TIMEOUT,
    async () => {
      const a = await agent({
        usage: {
          input_tokens: 200_000,
          output_tokens: 40_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        responder: steps(
          [use("toolu_charges", "mcp__stripe__list_charges", { customer: "cus_1" })],
          [text("unreachable")],
        ),
      });
      const events = await a.run(a.input({ model: { maxBudgetUsd: 0.01 } }));
      expectContract(events, a.stderr);
      expect(finished(events)).toMatchObject({
        status: "failed",
        error: { code: "budget_exceeded" },
      });
      expect(ofType(events, "usage")[0]?.costUsd).toBeGreaterThan(0.01);
      // The SDK ran the call before it stopped for the budget; the action log still has it.
      expect(a.stripeCalls.map((call) => call.tool)).toEqual(["list_charges"]);
      expect(ofType(events, "tool.output").map((event) => event.toolCallId)).toEqual([
        "toolu_charges",
      ]);
    },
  );

  it("fails with model_error on an API error, without turning it into text", TIMEOUT, async () => {
    const a = await agent({
      responder: (body) =>
        isMainLoop(body)
          ? {
              httpStatus: 529,
              message: "Overloaded",
              errorType: "overloaded_error",
              headers: { "x-should-retry": "false" },
            }
          : undefined,
    });
    const events = await a.run(a.input());
    expectContract(events, a.stderr);
    expect(ofType(events, "text.delta")).toEqual([]);
    expect(finished(events)).toMatchObject({
      status: "failed",
      reply: null,
      error: { code: "model_error", message: expect.stringContaining("529") },
    });
  });

  it("resumes the SDK session and reports each run's own usage", TIMEOUT, async () => {
    const a = await agent({
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      responder: (body) => (isMainLoop(body) ? [text(`Reply ${stepIndex(body)}.`)] : undefined),
    });
    const first = await a.run(a.input({ prompt: "First question." }));
    const session = ofType(first, "session")[0]?.sdkSessionId;
    expect(session).toBeDefined();
    const second = await a.run(
      a.input({ prompt: "Second question.", resumeSessionId: session ?? null }),
    );
    expectContract(first, a.stderr);
    expectContract(second, a.stderr);
    expect(ofType(second, "session")[0]?.sdkSessionId).toBe(session);
    const firstUsage = ofType(first, "usage")[0];
    const secondUsage = ofType(second, "usage")[0];
    expect(secondUsage?.inputTokens).toBe(firstUsage?.inputTokens);
    expect(secondUsage?.costUsd).toBeCloseTo(firstUsage?.costUsd ?? -1, 6);
    // The resumed request carries the first exchange.
    expect(JSON.stringify(a.mainBodies().at(-1)?.messages)).toContain("First question.");
  });

  it("marks an unreachable MCP upstream unavailable and tells the model", TIMEOUT, async () => {
    const a = await agent({
      hubspotUrl: "http://127.0.0.1:9/mcp",
      responder: steps([text("HubSpot is unavailable right now.")]),
    });
    const events = await a.run(a.input());
    expectContract(events, a.stderr);
    const started = events[0];
    if (started?.type !== "run.started") throw new Error("no run.started");
    expect(
      started.connections.find((connection) => connection.integration === "hubspot"),
    ).toMatchObject({
      availability: "unavailable",
      state: "error",
    });
    const body = a.mainBodies()[0] as MessagesBody;
    expect(offeredTools(body).some((name) => name.startsWith("mcp__hubspot__"))).toBe(false);
    expect(systemText(body)).toContain("- HubSpot: HubSpot could not be reached for this run");
    expect(finished(events).status).toBe("completed");
  });

  it("stops the run when the consumer stops reading", TIMEOUT, async () => {
    const a = await agent({
      responder: steps([use("toolu_refund", "mcp__stripe__create_refund", { charge: "ch_2" })]),
    });
    const seen: AgentEvent[] = [];
    const events = await a
      .run(a.input(), (event, all) => {
        seen.push(event);
        if (event.type === "approval.requested") throw new StopReading(all.length);
      })
      .catch((error: unknown) => {
        if (error instanceof StopReading) return seen;
        throw error;
      });
    expect(events.at(-1)?.type).toBe("approval.requested");
    expect([...a.store.rows.values()].map((row) => row.status)).toEqual(["cancelled"]);
    expect(a.stripeCalls).toEqual([]);
  });
});

class StopReading extends Error {
  constructor(readonly at: number) {
    super("stop reading");
  }
}

describe("runTurn that ends before the SDK starts", () => {
  function headlessInput(env: ReturnType<typeof testEnv>, signal: AbortSignal): RunTurnInput {
    return {
      runId: "run_x",
      conversationId: "conv_x",
      source: "cli",
      prompt: "hello",
      resumeSessionId: null,
      env,
      model: {
        model: "claude-sonnet-5",
        effort: "medium",
        thinkingDisplay: "omitted",
        maxTurns: 3,
        maxBudgetUsd: 1,
      },
      settings: TEST_SETTINGS,
      policy: DEFAULT_POLICY,
      businessDate: BUSINESS_DATE,
      connections: plansWith([
        { integration: "stripe", status: "available", connection: stripeConnection() },
      ]),
      signal,
      mode: "headless",
    };
  }

  async function collectRun(input: RunTurnInput): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of createRunTurn({ catalog: testCatalog() })(input)) events.push(event);
    return events;
  }

  it("fails with config_missing when there is no model key", async () => {
    const state = tempStateDir();
    cleanups.push(state.cleanup);
    const events = await collectRun(
      headlessInput(testEnv({ AGENT_STATE_DIR: state.dir }), new AbortController().signal),
    );
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.finished"]);
    expect(finished(events)).toMatchObject({
      status: "failed",
      error: { code: "config_missing", message: MISSING_MODEL_KEY_MESSAGE },
    });
  });

  it("is cancelled or timed out when its signal was already aborted", async () => {
    const state = tempStateDir();
    cleanups.push(state.cleanup);
    const env = testEnv({ AGENT_STATE_DIR: state.dir, ANTHROPIC_API_KEY: KEY });
    const cancelled = await collectRun(headlessInput(env, AbortSignal.abort("shutdown")));
    expect(cancelled.map((event) => event.type)).toEqual(["run.started", "run.finished"]);
    expect(finished(cancelled)).toMatchObject({ status: "cancelled", stopReason: "shutdown" });
    const timedOut = await collectRun(headlessInput(env, AbortSignal.abort("timeout")));
    expect(finished(timedOut)).toMatchObject({
      status: "timed_out",
      stopReason: "timeout",
      error: { code: "timeout" },
    });
  });
});
