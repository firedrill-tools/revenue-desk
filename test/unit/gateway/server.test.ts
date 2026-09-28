import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRedactorFor } from "../../../src/config/redact.js";
import { REDACTED } from "../../../src/config/secret.js";
import { sdkToolName, type ToolDescriptor } from "../../../src/contracts/integration.js";
import { apiGatewayTool, defineApiTool } from "../../../src/gateway/api-server.js";
import {
  idempotencyKeyFor,
  MISSING_TOOL_USE_ID,
  toolUseIdFromMeta,
  untrackedToolUseId,
} from "../../../src/gateway/context.js";
import { noteHttpRequest, noteHttpResponse } from "../../../src/gateway/http-report.js";
import { createGatewayServer } from "../../../src/gateway/server.js";
import type {
  ExecutionContext,
  GatewayCall,
  GatewayCallResult,
  GatewayObserver,
} from "../../../src/gateway/types.js";
import { callWithMeta, connectClient, textOf } from "../../helpers/mcp-client.js";

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

const descriptor = (name: string, readOnly: boolean): ToolDescriptor => ({
  name,
  upstream: readOnly ? "GET /v1/charges" : "POST /v1/refunds",
  operation: readOnly ? "stripe.charges.list" : "stripe.refunds.create",
  title: name,
  baseClass: readOnly ? "read" : "financial",
  readOnly,
  integration: "stripe",
  connectionKind: "api",
  sdkName: sdkToolName("stripe", name),
});

function recorder() {
  const started: GatewayCall[] = [];
  const progress: number[] = [];
  const finished: GatewayCallResult[] = [];
  const observer: GatewayObserver = {
    callStarted: (call) => started.push(call),
    callProgress: (_call, elapsedMs) => progress.push(elapsedMs),
    callFinished: (result) => finished.push(result),
  };
  return { started, progress, finished, observer };
}

function stripeServer(
  options: { delayMs?: number; secret?: string; progressIntervalMs?: number } = {},
) {
  const contexts: ExecutionContext[] = [];
  const list = defineApiTool({
    name: "list_charges",
    description: "List charges.",
    input: { customer: z.string() },
    readOnly: true,
    run: async (args, context) => {
      contexts.push({ ...context, signal: context.signal ?? new AbortController().signal });
      if (options.delayMs !== undefined) await new Promise((r) => setTimeout(r, options.delayMs));
      return {
        data: [{ id: "ch_1", customer: args.customer }],
        debug: options.secret === undefined ? null : `Bearer ${options.secret}`,
      };
    },
  });
  const refund = defineApiTool({
    name: "create_refund",
    description: "Refund.",
    input: { charge: z.string() },
    readOnly: false,
    run: async (args, context) => {
      contexts.push({ ...context, signal: context.signal ?? new AbortController().signal });
      // As Stripe's client reports a write through the HTTP layer.
      noteHttpRequest(context.idempotencyKey);
      noteHttpResponse(200);
      return { id: "re_1", charge: args.charge };
    },
  });
  const events = recorder();
  const server = createGatewayServer({
    integration: "stripe",
    runId: "run_42",
    tools: [
      apiGatewayTool(list, descriptor("list_charges", true)),
      apiGatewayTool(refund, descriptor("create_refund", false)),
    ],
    observer: events.observer,
    redact: createRedactorFor(options.secret === undefined ? [] : [options.secret]),
    timeoutMs: 30_000,
    ...(options.progressIntervalMs === undefined
      ? {}
      : { progressIntervalMs: options.progressIntervalMs }),
  });
  return { server, contexts, ...events };
}

async function client(config: Parameters<typeof connectClient>[0]) {
  const connected = await connectClient(config);
  clients.push(connected);
  return connected;
}

describe("the call identity", () => {
  it("reads the CLI's tool-use id from _meta", () => {
    expect(toolUseIdFromMeta({ "claudecode/toolUseId": "toolu_1" })).toBe("toolu_1");
    expect(toolUseIdFromMeta({ progressToken: 2 })).toBeNull();
    expect(toolUseIdFromMeta({ "claudecode/toolUseId": 7 })).toBeNull();
    expect(toolUseIdFromMeta({ "claudecode/toolUseId": "  " })).toBeNull();
    expect(toolUseIdFromMeta(undefined)).toBeNull();
  });

  it("derives the idempotency key as sha256hex(runId:toolUseId)", () => {
    expect(idempotencyKeyFor("run_42", "toolu_1")).toBe(
      createHash("sha256").update("run_42:toolu_1").digest("hex"),
    );
    expect(untrackedToolUseId()).toMatch(/^untracked-[0-9a-f-]{36}$/);
  });
});

describe("a gateway server", () => {
  it("is a fresh sdk server instance for every query, listing the offered tools", async () => {
    const { server } = stripeServer();
    const first = server.serverConfig();
    const second = server.serverConfig();
    expect(first.instance).not.toBe(second.instance);
    expect(first).toMatchObject({ type: "sdk", name: "stripe", timeout: 30_000 });
    const { tools } = await (await client(first)).listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_charges", "create_refund"]);
  });

  it("gives each call its tool-use id and idempotency key and reports it", async () => {
    const { server, contexts, started, finished } = stripeServer();
    const connected = await client(server.serverConfig());
    const result = await callWithMeta(
      connected,
      "create_refund",
      { charge: "ch_2" },
      "toolu_refund",
    );
    const key = idempotencyKeyFor("run_42", "toolu_refund");
    expect(contexts).toEqual([
      expect.objectContaining({ runId: "run_42", toolUseId: "toolu_refund", idempotencyKey: key }),
    ]);
    expect(JSON.parse(textOf(result))).toEqual({ id: "re_1", charge: "ch_2" });
    expect(started).toEqual([
      {
        integration: "stripe",
        connectionKind: "api",
        tool: "create_refund",
        sdkName: "mcp__stripe__create_refund",
        upstreamTool: "POST /v1/refunds",
        toolUseId: "toolu_refund",
        idempotencyKey: key,
        arguments: { charge: "ch_2" },
        readOnly: false,
      },
    ]);
    expect(finished).toEqual([
      {
        call: started[0],
        output: { id: "re_1", charge: "ch_2" },
        truncated: false,
        isError: false,
        error: null,
        httpStatus: 200,
        idempotencyKey: key,
        durationMs: expect.any(Number),
      },
    ]);
  });

  it("refuses a write without a tool-use id before running it", async () => {
    const { server, contexts, started, finished } = stripeServer();
    const connected = await client(server.serverConfig());
    const result = await callWithMeta(connected, "create_refund", { charge: "ch_2" }, null);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(MISSING_TOOL_USE_ID);
    expect(contexts).toEqual([]);
    expect(started).toEqual([]);
    expect(finished).toEqual([
      expect.objectContaining({
        isError: true,
        error: expect.objectContaining({ code: "tool_use_id_missing" }),
        call: expect.objectContaining({ toolUseId: null, idempotencyKey: null }),
      }),
    ]);
  });

  it("runs a read without a tool-use id under a stand-in id", async () => {
    const { server, contexts, finished } = stripeServer();
    const connected = await client(server.serverConfig());
    const result = await callWithMeta(connected, "list_charges", { customer: "cus_1" }, null);
    expect(result.isError).toBeUndefined();
    expect(contexts[0]?.toolUseId).toMatch(/^untracked-/);
    expect(finished[0]?.call.toolUseId).toBeNull();
  });

  it("refuses a name it does not offer", async () => {
    const { server, contexts } = stripeServer();
    const connected = await client(server.serverConfig());
    const result = await callWithMeta(connected, "delete_customer", {}, "toolu_x");
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool delete_customer is not available on stripe." }],
    });
    expect(contexts).toEqual([]);
  });

  it("redacts what the model and the observer receive", async () => {
    const secret = "sk_test_embedded_secret_value";
    const { server, finished } = stripeServer({ secret });
    const connected = await client(server.serverConfig());
    const result = await callWithMeta(connected, "list_charges", { customer: "cus_1" }, "toolu_1");
    expect(textOf(result)).not.toContain(secret);
    expect(JSON.stringify(finished)).not.toContain(secret);
    expect(finished[0]?.output).toMatchObject({ debug: `Bearer ${REDACTED}` });
  });

  it("reports progress while a call runs", async () => {
    const { server, progress } = stripeServer({ delayMs: 120, progressIntervalMs: 25 });
    const connected = await client(server.serverConfig());
    await callWithMeta(connected, "list_charges", { customer: "cus_1" }, "toolu_1");
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("keeps a result when the observer throws", async () => {
    const server = createGatewayServer({
      integration: "stripe",
      runId: "run_1",
      tools: stripeServer().server.tools,
      observer: {
        callStarted: () => {
          throw new Error("observer bug");
        },
        callFinished: () => {
          throw new Error("observer bug");
        },
      },
    });
    const connected = await client(server.serverConfig());
    const result = await callWithMeta(connected, "list_charges", { customer: "cus_1" }, "toolu_1");
    expect(result.isError).toBeUndefined();
  });

  it("forwards instructions only when given", async () => {
    const tools = stripeServer().server.tools;
    const withInstructions = createGatewayServer({
      integration: "stripe",
      runId: "run_1",
      tools,
      instructions: "Amounts are minor units.",
    });
    expect((await client(withInstructions.serverConfig())).getInstructions()).toBe(
      "Amounts are minor units.",
    );
    const without = createGatewayServer({ integration: "stripe", runId: "run_1", tools });
    expect((await client(without.serverConfig())).getInstructions()).toBeUndefined();
  });
});

describe("a started write", () => {
  it("is not cancelled with its request, and its real result is still reported", async () => {
    const signals = new Map<string, AbortSignal>();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = (name: string, readOnly: boolean) =>
      apiGatewayTool(
        defineApiTool({
          name,
          description: name,
          input: { charge: z.string() },
          readOnly,
          run: async (args, context) => {
            if (context.signal !== undefined) signals.set(name, context.signal);
            await Promise.race([
              released,
              new Promise((_resolve, reject) =>
                context.signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
              ),
            ]);
            return { id: `${name}_done`, charge: args.charge };
          },
        }),
        descriptor(name, readOnly),
      );
    const events = recorder();
    const server = createGatewayServer({
      integration: "stripe",
      runId: "run_42",
      tools: [slow("list_charges", true), slow("create_refund", false)],
      observer: events.observer,
      writeDeadlineMs: 30_000,
    });
    const connected = await client(server.serverConfig());
    const cancel = new AbortController();
    const call = (name: string, id: string) =>
      connected
        .request(
          {
            method: "tools/call",
            params: {
              name,
              arguments: { charge: "ch_2" },
              _meta: { "claudecode/toolUseId": id },
            },
          },
          CallToolResultSchema,
          { signal: cancel.signal },
        )
        .catch((error: unknown) => error);
    const read = call("list_charges", "toolu_read");
    const write = call("create_refund", "toolu_refund");
    await expect.poll(() => signals.size).toBe(2);

    // Stop: the CLI cancels both requests.
    cancel.abort("stop");
    await Promise.all([read, write]);
    await expect.poll(() => signals.get("list_charges")?.aborted).toBe(true);
    expect(signals.get("create_refund")?.aborted).toBe(false);

    // The provider answers the write after the request was cancelled: it is logged as it happened.
    release();
    await expect.poll(() => events.finished.length).toBe(2);
    const refund = events.finished.find((result) => result.call.tool === "create_refund");
    expect(refund).toMatchObject({
      isError: false,
      output: { id: "create_refund_done", charge: "ch_2" },
    });
    expect(events.started.find((call) => call.tool === "create_refund")?.readOnly).toBe(false);
  });

  it("is aborted at its own deadline", async () => {
    let seen: AbortSignal | undefined;
    const server = createGatewayServer({
      integration: "stripe",
      runId: "run_42",
      tools: [
        apiGatewayTool(
          defineApiTool({
            name: "create_refund",
            description: "Refund.",
            input: { charge: z.string() },
            readOnly: false,
            run: async (_args, context) => {
              seen = context.signal;
              await new Promise((resolve) => setTimeout(resolve, 200));
              return {};
            },
          }),
          descriptor("create_refund", false),
        ),
      ],
      writeDeadlineMs: 20,
    });
    await callWithMeta(await client(server.serverConfig()), "create_refund", { charge: "c" }, "t1");
    expect(seen?.aborted).toBe(true);
  });
});
