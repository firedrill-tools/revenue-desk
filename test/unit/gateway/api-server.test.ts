import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  type ApiCallContext,
  sdkToolName,
  type ToolDescriptor,
} from "../../../src/contracts/integration.js";
import {
  type ApiToolContext,
  ApiToolDefinitionError,
  ApiToolError,
  apiGatewayTool,
  apiInputSchema,
  defineApiTool,
} from "../../../src/gateway/api-server.js";
import type { ExecutionContext } from "../../../src/gateway/types.js";
import { compileArgumentValidator } from "../../../src/gateway/validate.js";
import { textOf } from "../../helpers/mcp-client.js";

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

const context = (signal = new AbortController().signal): ExecutionContext => ({
  runId: "run_1",
  toolUseId: "toolu_1",
  idempotencyKey: "key_1",
  signal,
});

function refundTool(received: { args: unknown; context: ApiToolContext }[] = []) {
  return defineApiTool({
    name: "create_refund",
    description: "Refund a charge.",
    input: {
      charge: z.string().describe("Charge id, ch_…"),
      amount: z.number().int().positive().optional().describe("Minor units"),
      reason: z.enum(["duplicate", "fraudulent"]).default("duplicate"),
    },
    readOnly: false,
    run: async (args, callContext) => {
      received.push({ args, context: callContext });
      if (args.charge === "ch_refunded") {
        throw new ApiToolError("stripe", "Charge ch_refunded has already been refunded.", {
          status: 400,
          code: "charge_already_refunded",
        });
      }
      if (args.charge === "ch_boom") throw new Error("socket hang up");
      return { id: "re_1", ...args };
    },
  });
}

describe("API tools", () => {
  it("offer the zod shape as a closed draft-07 JSON schema that the validator can check", () => {
    const schema = apiInputSchema(refundTool());
    expect(schema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        charge: { type: "string", description: "Charge id, ch_…" },
        amount: { type: "integer", exclusiveMinimum: 0, description: "Minor units" },
        reason: { type: "string", enum: ["duplicate", "fraudulent"], default: "duplicate" },
      },
      required: ["charge"],
      additionalProperties: false,
    });
    const validate = compileArgumentValidator(schema);
    expect(validate({ charge: "ch_1" })).toEqual([]);
    expect(validate({ charge: "ch_1", amount: 0 }).map((issue) => issue.path)).toEqual(["/amount"]);
    expect(validate({ charge: "ch_1", note: "x" })).toEqual([
      { path: "", message: 'has an unexpected property "note"' },
    ]);
  });

  it("run with parsed arguments (defaults applied) and the call's context", async () => {
    const received: { args: unknown; context: ApiToolContext }[] = [];
    const tool = apiGatewayTool(refundTool(received), descriptor("create_refund", false));
    const signal = new AbortController().signal;
    const execution = await tool.execute({ charge: "ch_2", amount: 4900 }, context(signal));
    expect(received).toEqual([
      {
        args: { charge: "ch_2", amount: 4900, reason: "duplicate" },
        context: { runId: "run_1", toolUseId: "toolu_1", idempotencyKey: "key_1", signal },
      },
    ]);
    expect(execution.error).toBeNull();
    expect(JSON.parse(textOf(execution.result))).toEqual({
      id: "re_1",
      charge: "ch_2",
      amount: 4900,
      reason: "duplicate",
    });
    expect(tool.definition).toMatchObject({
      name: "create_refund",
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: { "anthropic/alwaysLoad": true },
    });
  });

  it("report a provider error with its status and code", async () => {
    const tool = apiGatewayTool(refundTool(), descriptor("create_refund", false));
    const execution = await tool.execute({ charge: "ch_refunded" }, context());
    const failure = {
      provider: "stripe",
      status: 400,
      code: "charge_already_refunded",
      message: "Charge ch_refunded has already been refunded.",
    };
    expect(execution).toEqual({
      result: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: failure }) }],
      },
      error: failure,
      httpStatus: 400,
    });
  });

  it("report an unexpected error without a status", async () => {
    const tool = apiGatewayTool(refundTool(), descriptor("create_refund", false));
    const execution = await tool.execute({ charge: "ch_boom" }, context());
    expect(execution.error).toEqual({
      provider: "stripe",
      status: null,
      code: null,
      message: "socket hang up",
    });
    expect(execution.httpStatus).toBeNull();
  });

  it("never run with arguments the shape refuses", async () => {
    const received: { args: unknown; context: ApiToolContext }[] = [];
    const tool = apiGatewayTool(refundTool(received), descriptor("create_refund", false));
    const execution = await tool.execute({ charge: 5, extra: true }, context());
    expect(received).toEqual([]);
    expect(execution.error?.code).toBe("invalid_arguments");
    expect(execution.result.isError).toBe(true);
  });

  it("mark reads read-only", () => {
    const list = defineApiTool({
      name: "list_charges",
      description: "List charges.",
      input: { customer: z.string() },
      readOnly: true,
      run: async () => ({ data: [] }),
    });
    expect(apiGatewayTool(list, descriptor("list_charges", true)).definition.annotations).toEqual({
      readOnlyHint: true,
    });
  });

  it("must match their profile entry", () => {
    expect(() => apiGatewayTool(refundTool(), descriptor("list_charges", true))).toThrow(
      ApiToolDefinitionError,
    );
  });

  it("serialise provider errors as the ToolFailure shape", () => {
    const error = new ApiToolError("quickbooks", "Stale object", { status: 400, code: "5010" });
    expect(error.toJSON()).toEqual({
      provider: "quickbooks",
      status: 400,
      code: "5010",
      message: "Stale object",
    });
    expect(new ApiToolError("slack", "channel_not_found").toJSON()).toEqual({
      provider: "slack",
      message: "channel_not_found",
    });
    expect(new ApiToolError("slack", "x").toFailure()).toEqual({
      provider: "slack",
      status: null,
      code: null,
      message: "x",
    });
  });

  it("receive exactly the frozen ApiCallContext", () => {
    expectTypeOf<ApiToolContext>().toEqualTypeOf<ApiCallContext>();
  });
});
