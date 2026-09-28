import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiToolError, createApiServer, defineApiTool } from "../../../src/gateway/api-server.js";
import type { GatewayCallEvent } from "../../../src/gateway/types.js";

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

function stripeServer() {
  const runs: Record<string, unknown>[] = [];
  const events: GatewayCallEvent[] = [];
  const config = createApiServer({
    name: "stripe",
    timeoutMs: 30_000,
    observer: (event) => events.push(event),
    tools: [
      defineApiTool({
        name: "list_charges",
        description: "List a customer's charges.",
        input: { customer: z.string(), limit: z.number().int().min(1).max(100).optional() },
        readOnly: true,
        run: async (args) => {
          runs.push(args);
          return { data: [{ id: "ch_1" }], has_more: false };
        },
      }),
      defineApiTool({
        name: "create_refund",
        description: "Refund a charge.",
        input: { charge: z.string(), amount: z.number().int().positive().optional() },
        readOnly: false,
        run: async (args) => {
          runs.push(args);
          if (args.charge === "ch_declined") {
            throw new ApiToolError("stripe", "Charge ch_declined has already been refunded.", {
              status: 400,
              code: "charge_already_refunded",
            });
          }
          if (args.charge === "ch_boom") throw new Error("socket hang up");
          return { id: "re_1", ...args };
        },
      }),
      defineApiTool({
        name: "delete_customer",
        description: "Delete a customer.",
        input: { customer: z.string() },
        readOnly: false,
        destructive: true,
        run: async () => ({ deleted: true }),
      }),
    ],
  });
  return { config, runs, events };
}

async function connect(instance: ReturnType<typeof stripeServer>["config"]["instance"]) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverSide);
  const client = new Client({ name: "unit", version: "1.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

const text = (result: unknown) =>
  (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";

describe("createApiServer", () => {
  it("lists zod tools as always-loaded JSON-schema tools with read/write annotations", async () => {
    const { config } = stripeServer();
    expect(config).toMatchObject({ type: "sdk", name: "stripe", timeout: 30_000 });
    const client = await connect(config.instance);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_charges",
      "create_refund",
      "delete_customer",
    ]);
    const [list, refund, remove] = tools;
    expect(list?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        customer: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["customer"],
    });
    expect(list?.annotations).toEqual({ readOnlyHint: true });
    expect(refund?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(remove?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    for (const tool of tools) expect(tool._meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });

  it("returns run's data as JSON text and reports the call", async () => {
    const { config, runs, events } = stripeServer();
    const client = await connect(config.instance);
    const result = await client.callTool({
      name: "list_charges",
      arguments: { customer: "cus_1", limit: 2 },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual({ data: [{ id: "ch_1" }], has_more: false });
    expect(runs).toEqual([{ customer: "cus_1", limit: 2 }]);
    expect(events).toEqual([
      expect.objectContaining({
        server: "stripe",
        kind: "api",
        tool: "list_charges",
        arguments: { customer: "cus_1", limit: 2 },
        isError: false,
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("normalises provider errors and other failures into error results", async () => {
    const { config, events } = stripeServer();
    const client = await connect(config.instance);
    const declined = await client.callTool({
      name: "create_refund",
      arguments: { charge: "ch_declined" },
    });
    expect(declined.isError).toBe(true);
    expect(JSON.parse(text(declined))).toEqual({
      error: {
        provider: "stripe",
        status: 400,
        code: "charge_already_refunded",
        message: "Charge ch_declined has already been refunded.",
      },
    });
    const broken = await client.callTool({
      name: "create_refund",
      arguments: { charge: "ch_boom" },
    });
    expect(JSON.parse(text(broken))).toEqual({ error: { message: "socket hang up" } });
    expect(events.map((event) => event.isError)).toEqual([true, true]);
  });

  it("rejects arguments that fail the zod shape before run is called", async () => {
    const { config, runs, events } = stripeServer();
    const client = await connect(config.instance);
    const result = await client.callTool({
      name: "create_refund",
      arguments: { charge: "ch_1", amount: -5 },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/-32602.*Invalid arguments for tool create_refund/s);
    expect(runs).toEqual([]);
    expect(events).toEqual([]);
  });

  it("builds a new server instance on every call", () => {
    expect(stripeServer().config.instance).not.toBe(stripeServer().config.instance);
  });
});
