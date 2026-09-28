/**
 * Gateway gate on the real Claude Agent SDK (its native CLI) against the
 * scripted loopback Messages API: the run gateway's three server kinds (an
 * API integration, a Streamable HTTP MCP upstream as HubSpot, a Composio-style
 * session upstream as Gmail) reached through query() with Revenue Desk's
 * options. It pins the SDK facts the gateway depends on, so an SDK upgrade
 * that breaks one fails here:
 *   - the CLI sends the model's tool_use id as _meta["claudecode/toolUseId"]
 *     to every in-process server (idempotency keys and action-log joins);
 *   - proxied schemas reach the Messages API byte for byte; API schemas are
 *     the gateway's closed draft-07 JSON schema;
 *   - one set of fresh server instances per query() over the same upstream;
 *   - only loopback Messages API traffic, and no upstream credential leaves.
 * Fails, never skips, without the native CLI.
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildQueryOptions, prepareStateDirectories } from "../../src/agent/sdk-options.js";
import { DEFAULT_POLICY } from "../../src/contracts/integration.js";
import { idempotencyKeyFor } from "../../src/gateway/context.js";
import { openRunGateway } from "../../src/gateway/run-gateway.js";
import type { GatewayCallResult } from "../../src/gateway/types.js";
import type { ComposioEndpointSource } from "../../src/gateway/upstreams.js";
import {
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
import {
  type MessagesBody,
  type Responder,
  type ScriptedBlock,
  startMockAnthropic,
} from "../support/mock-anthropic.js";
import {
  messageBodies,
  offeredTool,
  offeredTools,
  requireNativeSdkBinary,
  stepIndex,
  strayTraffic,
} from "../support/sdk-gate-support.js";
import { CRM_TOOLS, MAIL_TOOLS, startHttpUpstream } from "../support/upstream-mcp.js";

const KEY = `sk-ant-dummy-${"k".repeat(40)}`;
const CRM_TOKEN = `crm-upstream-${"t".repeat(24)}`;
const MAIL_TOKEN = `mail-upstream-${"m".repeat(24)}`;
const RUN_ID = "run_gate";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const use = (id: string, name: string, input: unknown): ScriptedBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const isMainLoop = (body: MessagesBody) => offeredTools(body).includes("mcp__stripe__list_charges");

const script: Responder = (body) => {
  if (!isMainLoop(body)) return undefined;
  if (stepIndex(body) === 0) {
    return [
      use("toolu_charges", "mcp__stripe__list_charges", { customer: "cus_123" }),
      use("toolu_crm", "mcp__hubspot__search_contacts", { query: "ana@acme.test" }),
      use("toolu_mail", "mcp__gmail__GMAIL_FETCH_EMAILS", { query: "from:ana@acme.test" }),
    ];
  }
  if (stepIndex(body) === 1) {
    return [use("toolu_refund", "mcp__stripe__create_refund", { charge: "ch_2", amount: 4900 })];
  }
  return [{ type: "text", text: "Done." }];
};

async function gate() {
  requireNativeSdkBinary();
  const state = tempStateDir("revenue-desk-gate-");
  cleanups.push(state.cleanup);
  const mock = await startMockAnthropic(KEY, script);
  cleanups.push(() => mock.close());
  const crm = await startHttpUpstream({ token: CRM_TOKEN, tools: CRM_TOOLS, name: "crm" });
  const mail = await startHttpUpstream({ token: MAIL_TOKEN, tools: MAIL_TOOLS, name: "mail" });
  cleanups.push(
    () => crm.close(),
    () => mail.close(),
  );
  const composio: ComposioEndpointSource = {
    endpoint: async () => ({
      transport: "http",
      url: mail.url,
      headers: { Authorization: `Bearer ${MAIL_TOKEN}` },
    }),
  };
  const stripeCalls: StripeCall[] = [];
  const finished: GatewayCallResult[] = [];
  const gateway = await openRunGateway({
    runId: RUN_ID,
    catalog: testCatalog(stripeCalls),
    settings: TEST_SETTINGS,
    policy: DEFAULT_POLICY,
    signal: new AbortController().signal,
    composio,
    observer: { callFinished: (result) => finished.push(result) },
    plans: plansWith([
      { integration: "stripe", status: "available", connection: stripeConnection() },
      {
        integration: "hubspot",
        status: "available",
        connection: hubspotHttpConnection(crm.url, CRM_TOKEN),
      },
      { integration: "gmail", status: "available", connection: gmailConnection() },
    ]),
  });
  cleanups.push(() => gateway.close());
  const env = testEnv({
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: mock.url,
    AGENT_STATE_DIR: state.dir,
    HTTP_PROXY: mock.url,
    HTTPS_PROXY: mock.url,
    NO_PROXY: "127.0.0.1,localhost",
    CLAUDE_CODE_MAX_RETRIES: "0",
  });
  const directories = prepareStateDirectories(state.dir);
  const stderr: string[] = [];
  const run = async () => {
    const messages: SDKMessage[] = [];
    const options = buildQueryOptions({
      env,
      model: {
        model: "claude-sonnet-5",
        effort: "medium",
        thinkingDisplay: "omitted",
        maxTurns: 6,
        maxBudgetUsd: 1,
      },
      directories,
      systemPrompt: ["Gateway gate."],
      mcpServers: gateway.mcpServers(),
      canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
      preToolUse: async () => ({}),
      resumeSessionId: null,
      abortController: new AbortController(),
      hostPath: process.env.PATH ?? "/usr/bin:/bin",
      clientApp: "revenue-desk-test/0",
      stderr: (data) => stderr.push(data),
    });
    for await (const message of query({ prompt: "Check Ana's charges.", options })) {
      messages.push(message);
    }
    return messages;
  };
  return { mock, crm, mail, gateway, stripeCalls, finished, stderr, run };
}

describe("the tool gateway on the real Claude Agent SDK", () => {
  it("offers exact schemas, joins every call to its tool_use id and keeps credentials home", {
    timeout: 120_000,
  }, async () => {
    const g = await gate();
    const messages = await g.run();
    const result = messages.find((message) => message.type === "result");
    expect(result, g.stderr.join("")).toMatchObject({ subtype: "success", result: "Done." });

    // Every call reached its tool with the model's tool_use id and the derived key.
    const byId = new Map(g.finished.map((entry) => [entry.call.toolUseId, entry]));
    for (const id of ["toolu_charges", "toolu_crm", "toolu_mail", "toolu_refund"]) {
      expect(byId.get(id)?.call.idempotencyKey).toBe(idempotencyKeyFor(RUN_ID, id));
      expect(byId.get(id)?.isError).toBe(false);
    }
    expect(byId.get("toolu_crm")?.call).toMatchObject({
      integration: "hubspot",
      connectionKind: "mcp",
    });
    expect(byId.get("toolu_mail")?.call).toMatchObject({
      integration: "gmail",
      connectionKind: "composio",
    });
    expect(g.stripeCalls).toEqual([
      {
        tool: "list_charges",
        args: { customer: "cus_123" },
        key: idempotencyKeyFor(RUN_ID, "toolu_charges"),
      },
      {
        tool: "create_refund",
        args: { charge: "ch_2", amount: 4900 },
        key: idempotencyKeyFor(RUN_ID, "toolu_refund"),
      },
    ]);

    const bodies = messageBodies(g.mock.requests).filter(isMainLoop);
    const first = bodies[0] as MessagesBody;
    expect(offeredTools(first)).toEqual(g.gateway.registry.names().sort());
    expect(offeredTool(first, "mcp__hubspot__create_note")?.input_schema).toEqual(
      CRM_TOOLS[1]?.tool.inputSchema,
    );
    expect(offeredTool(first, "mcp__gmail__GMAIL_FETCH_EMAILS")?.input_schema).toEqual(
      MAIL_TOOLS[0]?.tool.inputSchema,
    );
    expect(offeredTool(first, "mcp__stripe__create_refund")?.input_schema).toMatchObject({
      type: "object",
      properties: {
        charge: { type: "string" },
        amount: { type: "integer", exclusiveMinimum: 0 },
        reason: { type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] },
      },
      required: ["charge"],
      additionalProperties: false,
    });

    expect(strayTraffic(g.mock.requests)).toEqual([]);
    expect(g.mock.requests.every((request) => request.usedExpectedCredential)).toBe(true);
    const wire = JSON.stringify(g.mock.requests) + JSON.stringify(messages);
    for (const secret of [CRM_TOKEN, MAIL_TOKEN, "s".repeat(24)])
      expect(wire).not.toContain(secret);
    expect(g.crm.unauthorized + g.mail.unauthorized).toBe(0);
  });

  it("serves a second query() with fresh instances over the same upstreams", {
    timeout: 120_000,
  }, async () => {
    const g = await gate();
    await g.run();
    await g.run();
    expect(g.crm.calls).toHaveLength(2);
    expect(g.mail.calls).toHaveLength(2);
    expect(g.stripeCalls.filter((call) => call.tool === "create_refund")).toHaveLength(2);
  });
});
