/**
 * S2 gate: the real Claude Agent SDK (and its native CLI) against a scripted
 * loopback Messages API, with the tool gateway's two in-process server kinds:
 * an API server (createSdkMcpServer + tool() + zod) and filtering MCP proxies
 * (a hand-built McpServer instance with raw JSON-schema handlers) in front of
 * a Streamable HTTP upstream and a stdio upstream. No model, no network
 * beyond 127.0.0.1. Fails, never skips, without the native CLI.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanUseTool,
  type Options,
  type PermissionResult,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApiServer, defineApiTool } from "../../src/gateway/api-server.js";
import {
  connectUpstream,
  createFilteringProxy,
  type FilteringProxy,
} from "../../src/gateway/mcp-proxy.js";
import type { GatewayCallEvent } from "../../src/gateway/types.js";
import {
  type MessagesBody,
  type MockAnthropic,
  type Responder,
  type ScriptedBlock,
  startMockAnthropic,
  toolResults,
} from "../support/mock-anthropic.js";
import {
  messageBodies,
  offeredTool,
  offeredTools,
  requireNativeSdkBinary,
  sdkTestEnvironment,
  stepIndex,
  strayTraffic,
  systemText,
} from "../support/sdk-gate-support.js";
import {
  CRM_INSTRUCTIONS,
  CRM_TOOLS,
  type HttpUpstream,
  MAIL_TOOLS,
  readCallLog,
  startHttpUpstream,
  stdioUpstreamConfig,
} from "../support/upstream-mcp.js";

const KEY = `sk-ant-dummy-${"k".repeat(40)}`; // never a real key
const MAIL_TOKEN = `mail-upstream-${"t".repeat(24)}`;
const MODEL = "claude-sonnet-5";
const USAGE = {
  input_tokens: 1_000,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const S = "mcp__stripe__";
const G = "mcp__gmail__";
const H = "mcp__hubspot__";
const READS = [`${S}list_charges`, `${G}GMAIL_FETCH_EMAILS`, `${H}search_contacts`];
const OFFERED = [
  `${G}GMAIL_CREATE_EMAIL_DRAFT`,
  `${G}GMAIL_FETCH_EMAILS`,
  `${G}GMAIL_SEND_DRAFT`,
  `${H}create_note`,
  `${H}search_contacts`,
  `${S}create_refund`,
  `${S}list_charges`,
].sort();

const THINKING = "Check the inbox, the CRM and the charges before touching money.";
const INTRO = "Looking this up in Gmail, HubSpot and Stripe.";
const FINAL = "Refunded the duplicate charge ch_2 and noted it in HubSpot; the email was not sent.";
const DENIED = "The user declined this action.";

const use = (id: string, name: string, input: unknown): ScriptedBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const isMainLoop = (body: MessagesBody) => offeredTools(body).includes(`${S}list_charges`);

const refundScript: Responder = (body) => {
  if (!isMainLoop(body)) return undefined;
  switch (stepIndex(body)) {
    case 0:
      return [
        { type: "thinking", thinking: THINKING, signature: "sig_step0" },
        { type: "text", text: INTRO },
        use("toolu_mail_fetch", `${G}GMAIL_FETCH_EMAILS`, {
          query: "from:ana@acme.test",
          max_results: 5,
        }),
        use("toolu_crm_search", `${H}search_contacts`, { query: "ana@acme.test", limit: 1 }),
        use("toolu_charges", `${S}list_charges`, { customer: "cus_123", limit: 10 }),
      ];
    case 1:
      return [
        use("toolu_refund", `${S}create_refund`, { charge: "ch_2", amount: 4900 }),
        use("toolu_note", `${H}create_note`, {
          contact_id: "101",
          body: "Refunded duplicate charge ch_2.",
          associations: [{ object_type: "deal", id: "555" }],
        }),
        use("toolu_send", `${G}GMAIL_SEND_DRAFT`, { draft_id: "r_1" }),
        use("toolu_delete", `${G}GMAIL_DELETE_MESSAGE`, { message_id: "m_1" }),
      ];
    default:
      return [{ type: "text", text: FINAL }];
  }
};

/** A permission request parked in canUseTool until the test settles it. */
interface PendingApproval {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly options: Parameters<CanUseTool>[2];
  readonly requestedAt: number;
  settle(result: PermissionResult): void;
}

class Inbox<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((value: T) => void)[] = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.items.push(value);
  }

  next(ended: Promise<unknown>): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return Promise.race([
      new Promise<T>((resolve) => this.waiters.push(resolve)),
      ended.then(() => {
        throw new Error("the run ended while an approval was still expected");
      }),
    ]);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  readonly mock: MockAnthropic;
  readonly mail: HttpUpstream;
  readonly gmail: FilteringProxy;
  readonly hubspot: FilteringProxy;
  readonly crmLog: string;
  readonly stripeCalls: { tool: string; args: Record<string, unknown> }[];
  readonly events: GatewayCallEvent[];
  readonly stderr: string[];
  options(canUseTool: CanUseTool): Options;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(responder: Responder): Promise<Harness> {
  // Each real-SDK test fails (never skips) with a clear message when the native CLI is missing.
  requireNativeSdkBinary();
  const state = realpathSync(mkdtempSync(join(tmpdir(), "revenue-desk-s2-")));
  cleanups.push(() => rmSync(state, { recursive: true, force: true }));
  const mock = await startMockAnthropic(KEY, responder, { usage: () => USAGE });
  cleanups.push(() => mock.close());
  const mail = await startHttpUpstream({ token: MAIL_TOKEN, tools: MAIL_TOOLS, name: "mail" });
  cleanups.push(() => mail.close());
  const mailUpstream = await connectUpstream({
    transport: "http",
    url: mail.url,
    headers: { Authorization: `Bearer ${MAIL_TOKEN}` },
  });
  cleanups.push(() => mailUpstream.close());
  const crmLog = join(state, "crm-calls.jsonl");
  const crmUpstream = await connectUpstream(
    stdioUpstreamConfig({ fixture: "crm", callLog: crmLog, instructions: CRM_INSTRUCTIONS }),
  );
  cleanups.push(() => crmUpstream.close());

  const events: GatewayCallEvent[] = [];
  const observer = (event: GatewayCallEvent) => events.push(event);
  const gmail = createFilteringProxy({
    name: "gmail",
    upstream: mailUpstream,
    allow: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_DRAFT"],
    observer,
  });
  const hubspot = createFilteringProxy({
    name: "hubspot",
    upstream: crmUpstream,
    allow: ["search_contacts", "create_note", "get_owner"],
    ...(crmUpstream.instructions === undefined ? {} : { instructions: crmUpstream.instructions }),
    observer,
  });

  const stripeCalls: { tool: string; args: Record<string, unknown> }[] = [];
  const stripeTools = [
    defineApiTool({
      name: "list_charges",
      description: "List a Stripe customer's charges, newest first.",
      input: {
        customer: z.string().describe("Stripe customer id, cus_…"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      readOnly: true,
      run: async (args) => {
        stripeCalls.push({ tool: "list_charges", args });
        return {
          data: [
            { id: "ch_1", amount: 4900, currency: "usd", created: 1_790_000_000 },
            { id: "ch_2", amount: 4900, currency: "usd", created: 1_790_000_060 },
          ],
          has_more: false,
        };
      },
    }),
    defineApiTool({
      name: "create_refund",
      description: "Refund a Stripe charge, fully or partly.",
      input: {
        charge: z.string(),
        amount: z.number().int().positive().optional().describe("Minor units"),
        reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
      },
      readOnly: false,
      run: async (args) => {
        stripeCalls.push({ tool: "create_refund", args });
        return { id: "re_1", object: "refund", status: "succeeded", ...args };
      },
    }),
  ];

  const stderr: string[] = [];
  const work = join(state, "work");
  mkdirSync(work, { recursive: true });
  const env = sdkTestEnvironment({ mockUrl: mock.url, apiKey: KEY, stateDir: state });
  return {
    mock,
    mail,
    gmail,
    hubspot,
    crmLog,
    stripeCalls,
    events,
    stderr,
    options: (canUseTool) => ({
      model: MODEL,
      effort: "medium",
      thinking: { type: "adaptive", display: "summarized" },
      cwd: work,
      settingSources: [],
      tools: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      permissionMode: "default",
      // No allowedTools: every call reaches canUseTool, the single policy point.
      // (Bare allowedTools entries skip canUseTool and make the SDK warn
      // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED.)
      maxTurns: 6,
      systemPrompt: "You are Revenue Desk's gateway test subject.",
      // Fresh server instances for this query(): an instance serves one query() at a time.
      mcpServers: {
        stripe: createApiServer({ name: "stripe", tools: stripeTools, observer }),
        gmail: gmail.serverConfig(),
        hubspot: hubspot.serverConfig(),
      },
      canUseTool,
      env,
      stderr: (data) => stderr.push(data),
    }),
  };
}

async function collect(prompt: string, options: Options) {
  const messages: SDKMessage[] = [];
  let error: unknown;
  try {
    for await (const message of query({ prompt, options })) messages.push(message);
  } catch (caught) {
    error = caught;
  }
  return { messages, error };
}

function streamDeltas(messages: readonly SDKMessage[], type: "text_delta" | "thinking_delta") {
  return messages
    .flatMap((message) => (message.type === "stream_event" ? [message.event] : []))
    .flatMap((event) =>
      event.type === "content_block_delta" && event.delta.type === type ? [event.delta] : [],
    )
    .map((delta) => ("text" in delta ? delta.text : "thinking" in delta ? delta.thinking : ""));
}

describe("tool gateway on the real Claude Agent SDK (scripted loopback model)", () => {
  it("finds the native Claude CLI for this platform", () => {
    expect(requireNativeSdkBinary()).toMatch(/claude(\.exe)?$/);
  });

  it("offers, calls, pauses and denies tools across API and proxied MCP servers", {
    timeout: 120_000,
  }, async () => {
    const h = await harness(refundScript);
    expect(h.gmail.tools.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_SEND_DRAFT",
    ]);
    expect(h.hubspot.missing).toEqual(["get_owner"]);

    const approvals = new Inbox<PendingApproval>();
    const autoAllowed: { toolName: string; mcpServer: unknown }[] = [];
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (READS.includes(toolName)) {
        autoAllowed.push({ toolName, mcpServer: options.mcpServer });
        return { behavior: "allow", updatedInput: input };
      }
      return new Promise<PermissionResult>((settle) => {
        approvals.push({ toolName, input, options, requestedAt: Date.now(), settle });
      });
    };
    const run = collect("Ana says she was charged twice. Sort it out.", h.options(canUseTool));

    const handled: { toolName: string; requestedAt: number; settledAt: number }[] = [];
    const seenOptions: Record<string, unknown>[] = [];
    for (let count = 0; count < 3; count += 1) {
      const approval = await approvals.next(run);
      seenOptions.push({ ...approval.options, signal: typeof approval.options.signal });
      if (approval.toolName === `${S}create_refund`) {
        // Paused: the SDK waits on this promise; nothing executes or reaches the model.
        const requests = h.mock.requests.length;
        await sleep(500);
        try {
          expect(h.mock.requests.length).toBe(requests);
          expect(h.stripeCalls.map((call) => call.tool)).toEqual(["list_charges"]);
        } catch (failure) {
          approval.settle({ behavior: "deny", message: "test failed", interrupt: true });
          throw failure;
        }
        approval.settle({
          behavior: "allow",
          updatedInput: { ...approval.input, reason: "duplicate" },
        });
      } else if (approval.toolName === `${H}create_note`) {
        approval.settle({ behavior: "allow", updatedInput: approval.input });
      } else {
        approval.settle({ behavior: "deny", message: DENIED });
      }
      handled.push({
        toolName: approval.toolName,
        requestedAt: approval.requestedAt,
        settledAt: Date.now(),
      });
    }
    const { messages, error } = await run;
    // SDK_GATE_TRANSCRIPT=<file> saves every SDK message and recorded request, for inspecting shapes.
    if (process.env.SDK_GATE_TRANSCRIPT) {
      writeFileSync(
        process.env.SDK_GATE_TRANSCRIPT,
        JSON.stringify({ messages, requests: h.mock.requests, handled, seenOptions }, null, 1),
      );
    }
    expect(error, h.stderr.join("")).toBeUndefined();

    // Reads were allowed at once, exactly three writes waited, and the filtered tool never got that far.
    expect(autoAllowed).toEqual(
      expect.arrayContaining([
        { toolName: `${S}list_charges`, mcpServer: { name: "stripe", source: "sdk" } },
        { toolName: `${G}GMAIL_FETCH_EMAILS`, mcpServer: { name: "gmail", source: "sdk" } },
        { toolName: `${H}search_contacts`, mcpServer: { name: "hubspot", source: "sdk" } },
      ]),
    );
    expect(autoAllowed).toHaveLength(3);
    expect(handled.map((entry) => entry.toolName).sort()).toEqual(
      [`${G}GMAIL_SEND_DRAFT`, `${H}create_note`, `${S}create_refund`].sort(),
    );
    const refundAsk = seenOptions.find((entry) => entry.toolUseID === "toolu_refund");
    expect(refundAsk).toMatchObject({ mcpServer: { name: "stripe", source: "sdk" } });
    const noteAsk = seenOptions.find((entry) => entry.toolUseID === "toolu_note");
    expect(noteAsk).toMatchObject({ mcpServer: { name: "hubspot", source: "sdk" } });

    // Only loopback Messages API traffic, always with the dummy key; the upstream token never left.
    expect(strayTraffic(h.mock.requests)).toEqual([]);
    expect(h.mock.requests.every((request) => request.usedExpectedCredential)).toBe(true);
    expect(JSON.stringify(h.mock.requests)).not.toContain(MAIL_TOKEN);
    expect(JSON.stringify(messages)).not.toContain(MAIL_TOKEN);
    expect(h.mail.unauthorized).toBe(0);

    const bodies = messageBodies(h.mock.requests);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(isMainLoop(body)).toBe(true);
      expect(offeredTools(body)).toEqual(OFFERED);
      expect(body.model).toBe(MODEL);
    }
    const first = bodies[0] as MessagesBody;
    // Proxied tools reach the model with the upstream JSON schema byte for byte.
    expect(offeredTool(first, `${G}GMAIL_FETCH_EMAILS`)?.input_schema).toEqual(
      MAIL_TOOLS[0]?.tool.inputSchema,
    );
    expect(offeredTool(first, `${H}create_note`)?.input_schema).toEqual(
      CRM_TOOLS[1]?.tool.inputSchema,
    );
    // The API tool's zod shape became a JSON schema.
    expect(offeredTool(first, `${S}create_refund`)?.input_schema).toMatchObject({
      type: "object",
      properties: {
        charge: { type: "string" },
        amount: { type: "integer", exclusiveMinimum: 0, description: "Minor units" },
        reason: { type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] },
      },
      required: ["charge"],
    });
    // Forwarded MCP instructions reach the model's context.
    expect(JSON.stringify(first)).toContain(CRM_INSTRUCTIONS);
    expect(systemText(first)).toContain("You are Revenue Desk's gateway test subject.");

    const results = new Map(
      toolResults(bodies[2] as MessagesBody).map((entry) => [entry.id, entry]),
    );
    expect(results.get("toolu_mail_fetch")).toMatchObject({ isError: false });
    expect(JSON.parse(results.get("toolu_mail_fetch")?.text ?? "{}")).toMatchObject({
      messages: [{ id: "m_1" }],
      received: { query: "from:ana@acme.test", max_results: 5 },
    });
    expect(JSON.parse(results.get("toolu_crm_search")?.text ?? "{}")).toMatchObject({
      results: [{ id: "101" }],
      received: { query: "ana@acme.test", limit: 1 },
    });
    expect(JSON.parse(results.get("toolu_charges")?.text ?? "{}")).toMatchObject({
      data: [{ id: "ch_1" }, { id: "ch_2" }],
    });
    expect(JSON.parse(results.get("toolu_refund")?.text ?? "{}")).toEqual({
      id: "re_1",
      object: "refund",
      status: "succeeded",
      charge: "ch_2",
      amount: 4900,
      reason: "duplicate",
    });
    expect(results.get("toolu_note")).toMatchObject({ isError: false });
    expect(results.get("toolu_send")).toEqual({ id: "toolu_send", isError: true, text: DENIED });
    expect(results.get("toolu_delete")).toMatchObject({
      isError: true,
      text: expect.stringContaining("No such tool available"),
    });

    // Calls reached each Tool with the model's arguments (and the approver's edit), and nothing else did.
    expect(h.stripeCalls).toEqual([
      { tool: "list_charges", args: { customer: "cus_123", limit: 10 } },
      { tool: "create_refund", args: { charge: "ch_2", amount: 4900, reason: "duplicate" } },
    ]);
    expect(h.mail.calls).toEqual([
      { tool: "GMAIL_FETCH_EMAILS", arguments: { query: "from:ana@acme.test", max_results: 5 } },
    ]);
    expect(readCallLog(h.crmLog)).toEqual([
      { tool: "search_contacts", arguments: { query: "ana@acme.test", limit: 1 } },
      {
        tool: "create_note",
        arguments: {
          contact_id: "101",
          body: "Refunded duplicate charge ch_2.",
          associations: [{ object_type: "deal", id: "555" }],
        },
      },
    ]);
    expect(h.events.map((event) => `${event.kind}:${event.server}:${event.tool}`).sort()).toEqual(
      [
        "api:stripe:create_refund",
        "api:stripe:list_charges",
        "mcp:gmail:GMAIL_FETCH_EMAILS",
        "mcp:hubspot:create_note",
        "mcp:hubspot:search_contacts",
      ].sort(),
    );

    // The SDK stream: init with every server connected, thinking and text deltas, then a costed result.
    const init = messages.find(
      (message) => message.type === "system" && message.subtype === "init",
    );
    expect(init).toMatchObject({
      model: MODEL,
      permissionMode: "default",
      tools: expect.arrayContaining(OFFERED),
      mcp_servers: expect.arrayContaining([
        { name: "stripe", status: "connected", source: "sdk" },
        { name: "gmail", status: "connected", source: "sdk" },
        { name: "hubspot", status: "connected", source: "sdk" },
      ]),
    });
    expect(streamDeltas(messages, "thinking_delta").join("")).toBe(THINKING);
    expect(streamDeltas(messages, "text_delta").join("")).toBe(INTRO + FINAL);
    const result = messages.find((message) => message.type === "result");
    expect(result).toMatchObject({
      subtype: "success",
      is_error: false,
      result: FINAL,
      usage: expect.objectContaining({
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
      }),
    });
    if (result?.type !== "result") throw new Error("no result message");
    expect(result.total_cost_usd).toBeGreaterThan(0);
    expect(result.modelUsage[MODEL]?.costUSD).toBeCloseTo(result.total_cost_usd, 10);
    expect(result.permission_denials).toEqual([
      expect.objectContaining({ tool_name: `${G}GMAIL_SEND_DRAFT`, tool_use_id: "toolu_send" }),
    ]);
  });

  it("builds a fresh proxy instance for each query() over one upstream connection", {
    timeout: 120_000,
  }, async () => {
    const h = await harness((body) => {
      if (!isMainLoop(body)) return undefined;
      return stepIndex(body) === 0
        ? [use("toolu_search", `${H}search_contacts`, { query: "ana@acme.test" })]
        : [{ type: "text", text: "Found Ana." }];
    });
    const readsOnly: CanUseTool = async (toolName, input) =>
      READS.includes(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "not in this test" };
    for (const _ of [1, 2]) {
      const { messages, error } = await collect("Who is Ana?", h.options(readsOnly));
      expect(error, h.stderr.join("")).toBeUndefined();
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        subtype: "success",
        result: "Found Ana.",
      });
    }
    expect(readCallLog(h.crmLog)).toEqual([
      { tool: "search_contacts", arguments: { query: "ana@acme.test" } },
      { tool: "search_contacts", arguments: { query: "ana@acme.test" } },
    ]);
    expect(strayTraffic(h.mock.requests)).toEqual([]);
  });
});
