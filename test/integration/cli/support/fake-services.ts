/**
 * Fakes behind the CLI's AskServices port (src/cli/ports.ts): a scripted
 * RunTurn that follows the AgentEvent ordering rules of
 * src/contracts/events.ts, an in-memory workspace that records every event,
 * and connection plans. Test code only; product code never selects them.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import type {
  AskServices,
  ConfigResult,
  ConnectionPlanRequest,
  ConversationRecord,
  EnvironmentRecord,
} from "../../../../src/cli/ports.js";
import { type AgentEnv, type ConfigProblem, EFFORT_LEVELS } from "../../../../src/contracts/env.js";
import type {
  AgentEvent,
  AgentEventType,
  ConnectionPlan,
  RunConnection,
  RunTurnInput,
  RunUsage,
} from "../../../../src/contracts/events.js";
import {
  ACTION_CLASSES,
  APPROVAL_MODES,
  type ApprovalMode,
  HEADLESS_ASK_DENIAL,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type PolicyOverrides,
  type WorkspaceSettings,
} from "../../../../src/contracts/integration.js";

export const SCENARIOS = [
  "reply",
  "tools",
  "noisy",
  "wait-for-stop",
  "ignore-stop",
  "model-error",
  "max-turns",
  "throw",
  "no-finish",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Written to stderr once a waiting scenario is ready for a signal. */
export const WAITING_MARKER = "fake-run: waiting for stop";

export const REPLY_TEXT =
  "Kestrel Analytics was charged twice on 2026-09-14; the second charge is a duplicate.";
export const TOOLS_REPLY = "The refund for the duplicate charge is ready for approval.";

export const USAGE: RunUsage = {
  costUsd: 0.0123,
  inputTokens: 1_200,
  outputTokens: 180,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  numTurns: 2,
  modelRequests: 2,
  durationMs: 2_400,
  durationApiMs: 2_000,
};

export const EXISTING_CONVERSATION: ConversationRecord = {
  id: "conv-existing",
  status: "idle",
  sdkSessionId: "sdk-session-previous",
};
export const BUSY_CONVERSATION: ConversationRecord = {
  id: "conv-busy",
  status: "running",
  sdkSessionId: null,
};

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  companyName: "Northwind Test Co",
  agentName: "Revenue Desk",
  senderName: "Billing",
  emailSignature: "",
  internalEmailDomains: ["northwind.test"],
  notifySlackChannel: "#billing",
  allowedSlackChannels: ["#billing"],
  timezone: "America/New_York",
  currency: "USD",
  defaultModel: null,
  defaultEffort: null,
  updatedAt: "2026-09-28T00:00:00.000Z",
};

export type FakeOptions = {
  readonly scenario: Scenario;
  readonly settings?: Partial<WorkspaceSettings>;
  readonly savedPolicy?: PolicyOverrides;
  /** Throw from loadServices(). */
  readonly failLoad?: boolean;
  /** Reject planConnections() with this message. */
  readonly failPlan?: string;
  /** planConnections() waits until its signal aborts. */
  readonly planWaitsForStop?: boolean;
  /** The recorder throws when it receives this event type. */
  readonly failRecordingAt?: AgentEventType;
  /** Appends every recorded event as a JSON line (for spawned processes). */
  readonly recordLog?: string;
  /** Called when a waiting scenario is ready for a signal. */
  readonly onWaiting?: () => void;
  /** Also write WAITING_MARKER to stderr (for spawned processes). */
  readonly announceWaiting?: boolean;
};

export type FakeServices = {
  readonly services: AskServices;
  readonly loadServices: () => Promise<AskServices>;
  readonly inputs: RunTurnInput[];
  readonly recorded: AgentEvent[];
  readonly created: { id: string; title: string; createdAt: string }[];
  readonly planRequests: ConnectionPlanRequest[];
  readonly state: { workspaceOpened: boolean; workspaceClosed: boolean };
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

class FakeSecret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [inspect.custom](): string {
    return "[redacted]";
  }
}

function text(environment: EnvironmentRecord, name: string): string | null {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? null : value;
}

/** The subset of the configuration rules the CLI's behaviour depends on. */
export function fakeLoadConfig(
  environment: EnvironmentRecord,
  options: { readonly cwd: string } = { cwd: process.cwd() },
): ConfigResult {
  const problems: ConfigProblem[] = [];
  const effortText = text(environment, "AGENT_EFFORT");
  const effort = EFFORT_LEVELS.find((level) => level === (effortText ?? "medium"));
  if (effort === undefined) {
    problems.push({
      variable: "AGENT_EFFORT",
      message: "must be low, medium, high, xhigh or max.",
    });
  }
  const policyOverrides: { [C in (typeof ACTION_CLASSES)[number]]?: ApprovalMode } = {};
  const policyText = text(environment, "AGENT_POLICY");
  if (policyText !== null) {
    try {
      const parsed: unknown = JSON.parse(policyText);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      for (const [key, mode] of Object.entries(parsed)) {
        const actionClass = ACTION_CLASSES.find((known) => known === key);
        const approvalMode = APPROVAL_MODES.find((known) => known === mode);
        if (actionClass === undefined || approvalMode === undefined) throw new Error("bad entry");
        policyOverrides[actionClass] = approvalMode;
      }
    } catch {
      problems.push({ variable: "AGENT_POLICY", message: "must be a JSON object of modes." });
    }
  }
  if (problems.length > 0 || effort === undefined) return { ok: false, problems };

  const apiKey = text(environment, "ANTHROPIC_API_KEY");
  const env: AgentEnv = {
    model: {
      apiKey: apiKey === null ? null : new FakeSecret(apiKey),
      baseUrl: null,
      model: text(environment, "AGENT_MODEL") ?? "claude-sonnet-5",
      effort,
      thinkingDisplay: null,
      maxTurns: 30,
      maxBudgetUsd: 2,
    },
    runtime: {
      port: 4320,
      stateDir: resolve(options.cwd, text(environment, "AGENT_STATE_DIR") ?? "./data"),
      policyOverrides,
      businessDate: text(environment, "AGENT_BUSINESS_DATE"),
      approvalTimeoutMs: 900_000,
      sandbox: false,
      dotenvPath: text(environment, "DOTENV_PATH"),
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
      secretKey: new FakeSecret("sk_test_fakeStripeKey0000000000"),
      allowLive: false,
      apiBaseUrl: "http://127.0.0.1:4242",
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
  return { ok: true, env };
}

export function fakeRedactor(env: AgentEnv): (text: string) => string {
  const secrets = [env.model.apiKey?.reveal(), env.stripe.secretKey?.reveal()].filter(
    (value): value is string => value !== undefined && value.length >= 8,
  );
  return (input) => {
    let output = input;
    for (const secret of secrets) output = output.split(secret).join("[redacted]");
    return output.replace(/\bsk_(?:test|live)_[A-Za-z0-9]{6,}/g, "[redacted]");
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export function fakePlans(env: AgentEnv): ConnectionPlan[] {
  return INTEGRATION_IDS.map((integration): ConnectionPlan => {
    const secretKey = env.stripe.secretKey;
    if (integration === "stripe" && secretKey !== null) {
      return {
        integration,
        status: "available",
        connection: {
          integration,
          kind: "api",
          profile: "stripe-api",
          endpointLabel: "127.0.0.1",
          api: { baseUrl: env.stripe.apiBaseUrl, secretKey, keyMode: "test", apiVersion: null },
        },
      };
    }
    return {
      integration,
      status: "unavailable",
      state: "not_configured",
      detail: `${INTEGRATIONS[integration].label} is not configured.`,
    };
  });
}

function runConnections(plans: readonly ConnectionPlan[]): RunConnection[] {
  return plans.map((plan) => ({
    integration: plan.integration,
    kind: INTEGRATIONS[plan.integration].kind,
    profile: INTEGRATIONS[plan.integration].profile,
    availability: plan.status === "available" ? "ready" : "unavailable",
    state: plan.status === "available" ? "connected" : plan.state,
    detail: plan.status === "available" ? null : plan.detail,
    endpointLabel: plan.status === "available" ? plan.connection.endpointLabel : null,
  }));
}

// ---------------------------------------------------------------------------
// The scripted run
// ---------------------------------------------------------------------------

function* textBlock(id: string, chunks: readonly string[]): Generator<AgentEvent> {
  yield { type: "text.start", id };
  for (const delta of chunks) yield { type: "text.delta", id, delta };
  yield { type: "text.end", id };
}

function started(input: RunTurnInput): AgentEvent {
  return {
    type: "run.started",
    runId: input.runId,
    conversationId: input.conversationId,
    source: input.source,
    mode: input.mode,
    model: input.model.model,
    effort: input.model.effort,
    startedAt: "2026-09-28T15:00:00.100Z",
    connections: runConnections(input.connections),
  };
}

function finished(
  status: "completed" | "failed" | "cancelled" | "timed_out",
  extra: {
    reply?: string | null;
    error?: { code: "model_error" | "max_turns" | "cancelled" | "timeout"; message: string };
  } = {},
): AgentEvent {
  return {
    type: "run.finished",
    status,
    finishedAt: "2026-09-28T15:00:02.500Z",
    stopReason: status === "completed" ? "end_turn" : null,
    terminalReason: status === "completed" ? "completed" : null,
    reply: extra.reply ?? null,
    error: extra.error ?? null,
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function* scriptedRun(
  scenario: Scenario,
  input: RunTurnInput,
  onWaiting: () => void,
): AsyncGenerator<AgentEvent> {
  yield started(input);
  yield { type: "session", sdkSessionId: "sdk-session-new" };
  yield { type: "status", status: { phase: "requesting" } };
  yield { type: "step.start" };

  switch (scenario) {
    case "reply":
    case "noisy": {
      const noisy = scenario === "noisy";
      if (noisy) {
        console.log("noisy: console.log during the run");
        console.info("noisy: console.info");
        console.table([{ noisy: true }]);
        process.stdout.write("noisy: process.stdout.write\n");
      }
      yield* textBlock("text-1", [
        "Kestrel Analytics was charged twice ",
        "on 2026-09-14; ",
        "the second charge is a duplicate.",
      ]);
      if (noisy) console.dir({ noisy: "console.dir" });
      yield { type: "step.finish" };
      yield { type: "usage", ...USAGE };
      yield finished("completed", { reply: REPLY_TEXT });
      return;
    }
    case "tools": {
      yield* textBlock("text-1", ["Checking Stripe."]);
      const read = {
        integration: "stripe",
        connectionKind: "api",
        operation: "stripe.charges.list",
        actionClass: "read",
      } as const;
      const refund = {
        integration: "stripe",
        connectionKind: "api",
        operation: "stripe.refunds.create",
        actionClass: "financial",
      } as const;
      yield {
        type: "tool.input.start",
        toolCallId: "toolu_charges",
        toolName: "mcp__stripe__list_charges",
        title: "List charges in Stripe",
        tool: read,
      };
      yield {
        type: "tool.input.delta",
        toolCallId: "toolu_charges",
        inputTextDelta: '{"customer":"cus_1"}',
      };
      yield {
        type: "tool.input.available",
        toolCallId: "toolu_charges",
        toolName: "mcp__stripe__list_charges",
        title: "List charges in Stripe",
        input: { customer: "cus_1" },
        tool: read,
      };
      yield {
        type: "tool.input.start",
        toolCallId: "toolu_refund",
        toolName: "mcp__stripe__create_refund",
        title: "Refund charge in Stripe",
        tool: refund,
      };
      yield {
        type: "tool.input.available",
        toolCallId: "toolu_refund",
        toolName: "mcp__stripe__create_refund",
        title: "Refund $49.00 to Kestrel Analytics",
        input: { charge: "ch_2", amount: 4900 },
        tool: refund,
      };
      yield { type: "step.finish" };
      yield {
        type: "tool.output",
        toolCallId: "toolu_charges",
        output: { data: [] },
        truncated: false,
        isError: false,
        error: null,
        durationMs: 120,
        execution: { upstreamTool: "GET /v1/charges", httpStatus: 200, idempotencyKey: null },
      };
      const mode = input.policy.financial;
      if (mode === "auto") {
        yield {
          type: "tool.output",
          toolCallId: "toolu_refund",
          output: { id: "re_1" },
          truncated: false,
          isError: false,
          error: null,
          durationMs: 340,
          execution: {
            upstreamTool: "POST /v1/refunds",
            httpStatus: 200,
            idempotencyKey: "idem-1",
          },
        };
      } else {
        const reason =
          mode === "ask" ? HEADLESS_ASK_DENIAL : "Financial actions are denied by policy.";
        yield {
          type: "tool.denied",
          toolCallId: "toolu_refund",
          decision: "policy_denied",
          reason,
        };
      }
      yield { type: "step.start" };
      yield* textBlock("text-2", [TOOLS_REPLY]);
      yield { type: "step.finish" };
      yield { type: "usage", ...USAGE };
      yield finished("completed", { reply: TOOLS_REPLY });
      return;
    }
    case "wait-for-stop": {
      yield { type: "text.start", id: "text-1" };
      yield { type: "text.delta", id: "text-1", delta: "Working" };
      onWaiting();
      await aborted(input.signal);
      yield { type: "text.end", id: "text-1" };
      yield { type: "step.finish" };
      const timedOut = input.signal.reason === "timeout";
      yield finished(timedOut ? "timed_out" : "cancelled", {
        error: timedOut
          ? { code: "timeout", message: "The run reached its time limit." }
          : { code: "cancelled", message: "The run was stopped." },
      });
      return;
    }
    case "ignore-stop":
      onWaiting();
      await new Promise<never>(() => undefined);
      return;
    case "model-error":
      yield finished("failed", {
        error: { code: "model_error", message: "The model claude-x is not available." },
      });
      return;
    case "max-turns":
      yield finished("failed", {
        error: { code: "max_turns", message: "The run reached its limit of 30 turns." },
      });
      return;
    case "throw":
      throw new Error(`upstream rejected key ${input.env.model.apiKey?.reveal() ?? "none"}`);
    case "no-finish":
      return;
  }
}

// ---------------------------------------------------------------------------
// The services
// ---------------------------------------------------------------------------

export function createFakeServices(options: FakeOptions): FakeServices {
  const inputs: RunTurnInput[] = [];
  const recorded: AgentEvent[] = [];
  const created: { id: string; title: string; createdAt: string }[] = [];
  const planRequests: ConnectionPlanRequest[] = [];
  const state = { workspaceOpened: false, workspaceClosed: false };
  const conversations = new Map<string, ConversationRecord>([
    [EXISTING_CONVERSATION.id, EXISTING_CONVERSATION],
    [BUSY_CONVERSATION.id, BUSY_CONVERSATION],
  ]);
  const onWaiting = () => {
    if (options.announceWaiting === true) process.stderr.write(`${WAITING_MARKER}\n`);
    options.onWaiting?.();
  };

  const services: AskServices = {
    loadConfig: fakeLoadConfig,
    createRedactor: fakeRedactor,
    openWorkspace() {
      state.workspaceOpened = true;
      return {
        settings: () => ({ ...DEFAULT_SETTINGS, ...options.settings }),
        savedPolicy: () => options.savedPolicy ?? {},
        findConversation: (id) => conversations.get(id) ?? null,
        createConversation(conversation) {
          created.push({ ...conversation });
          const record: ConversationRecord = {
            id: conversation.id,
            status: "idle",
            sdkSessionId: null,
          };
          conversations.set(record.id, record);
          return record;
        },
        beginRun(input) {
          inputs.push(input);
          return {
            record(event) {
              if (event.type === options.failRecordingAt) throw new Error("disk I/O error");
              recorded.push(event);
              if (options.recordLog !== undefined) {
                appendFileSync(options.recordLog, `${JSON.stringify(event)}\n`);
              }
            },
          };
        },
        close() {
          state.workspaceClosed = true;
        },
      };
    },
    async planConnections(request) {
      planRequests.push(request);
      if (options.failPlan !== undefined) throw new Error(options.failPlan);
      if (options.planWaitsForStop === true) {
        onWaiting();
        await aborted(request.signal);
      }
      return fakePlans(request.env);
    },
    runTurn: (input) => scriptedRun(options.scenario, input, onWaiting),
  };

  return {
    services,
    loadServices: async () => {
      if (options.failLoad === true) throw new Error("Cannot find module '../agent/run-turn.js'");
      return services;
    },
    inputs,
    recorded,
    created,
    planRequests,
    state,
  };
}
