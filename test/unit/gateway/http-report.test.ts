// The action log's HTTP facts (src/gateway/http-report.ts): an API tool call
// records the provider's last status, 2xx included, and the idempotency key
// only when a write actually sent it. The integrations' HTTP layer
// (sendHttp) reports into the call's scope; concurrent calls never mix.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sdkToolName, type ToolDescriptor } from "../../../src/contracts/integration.js";
import { ApiToolError, apiGatewayTool, defineApiTool } from "../../../src/gateway/api-server.js";
import { noteHttpResponse, reportingHttp } from "../../../src/gateway/http-report.js";
import type { ExecutionContext } from "../../../src/gateway/types.js";
import { type FetchLike, sendHttp } from "../../../src/integrations/shared/http.js";

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

const context = (idempotencyKey: string): ExecutionContext => ({
  runId: "run_1",
  toolUseId: "toolu_1",
  idempotencyKey,
  signal: new AbortController().signal,
});

/** A fetch that answers from a list of outcomes, in order. */
function sequencedFetch(outcomes: readonly (number | Error)[], delayMs = 0): FetchLike {
  let index = 0;
  return async () => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? 200;
    index += 1;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (outcome instanceof Error) throw outcome;
    return new Response(JSON.stringify({ ok: outcome < 300 }), {
      status: outcome,
      headers: { "retry-after": "0" },
    });
  };
}

function networkError(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });
}

/** A write and a read that go through sendHttp, as the provider clients do. */
function httpTools(fetch: FetchLike, options: { refuseBeforeSending?: boolean } = {}) {
  const write = defineApiTool({
    name: "create_refund",
    description: "Refund.",
    input: { charge: z.string() },
    readOnly: false,
    run: async (_args, call) => {
      if (options.refuseBeforeSending === true) {
        throw new ApiToolError("stripe", "Refused before sending.", { code: "invalid" });
      }
      const response = await sendHttp(
        {
          method: "POST",
          url: "http://stripe.test/v1/refunds",
          headers: { "idempotency-key": call.idempotencyKey },
          body: "charge=ch_1",
          retryable: false,
          signal: call.signal,
          idempotencyKey: call.idempotencyKey,
        },
        { fetch, sleep: async () => {} },
      );
      if (response.status >= 300) {
        throw new ApiToolError("stripe", "Stripe failed.", { status: response.status });
      }
      return { id: "re_1" };
    },
  });
  const read = defineApiTool({
    name: "list_charges",
    description: "List.",
    input: {},
    readOnly: true,
    run: async (_args, call) => {
      const response = await sendHttp(
        {
          method: "GET",
          url: "http://stripe.test/v1/charges",
          headers: {},
          retryable: true,
          signal: call.signal,
        },
        { fetch, sleep: async () => {} },
      );
      return { status: response.status };
    },
  });
  return {
    write: apiGatewayTool(write, descriptor("create_refund", false)),
    read: apiGatewayTool(read, descriptor("list_charges", true)),
  };
}

describe("an API call's HTTP report", () => {
  it("records a successful write's 2xx status and the key it sent", async () => {
    const { write } = httpTools(sequencedFetch([200]));
    const execution = await write.execute({ charge: "ch_1" }, context("key_write"));
    expect(execution).toMatchObject({ error: null, httpStatus: 200, idempotencyKey: "key_write" });
  });

  it("records a read's final status after a retried 429, and no key", async () => {
    const { read } = httpTools(sequencedFetch([429, 200]));
    const execution = await read.execute({}, context("key_read"));
    expect(execution).toMatchObject({ error: null, httpStatus: 200, idempotencyKey: null });
  });

  it("records the provider's error status and the key of a write that reached it", async () => {
    const { write } = httpTools(sequencedFetch([500]));
    const execution = await write.execute({ charge: "ch_1" }, context("key_500"));
    expect(execution).toMatchObject({ httpStatus: 500, idempotencyKey: "key_500" });
    expect(execution.error?.status).toBe(500);
  });

  it("records no key for a write refused before anything was sent", async () => {
    const { write } = httpTools(sequencedFetch([200]), { refuseBeforeSending: true });
    const execution = await write.execute({ charge: "ch_1" }, context("key_refused"));
    expect(execution).toMatchObject({ httpStatus: null, idempotencyKey: null });
    expect(execution.error?.code).toBe("invalid");
  });

  it("records no key when the connection failed before sending, and the key when it may have been sent", async () => {
    const refused = httpTools(sequencedFetch([networkError("ECONNREFUSED")])).write;
    expect(await refused.execute({ charge: "ch_1" }, context("key_refused"))).toMatchObject({
      httpStatus: null,
      idempotencyKey: null,
    });
    const reset = httpTools(sequencedFetch([networkError("ECONNRESET")])).write;
    expect(await reset.execute({ charge: "ch_1" }, context("key_reset"))).toMatchObject({
      httpStatus: null,
      idempotencyKey: "key_reset",
    });
  });

  it("keeps concurrent calls' reports apart", async () => {
    const slow = httpTools(sequencedFetch([201], 30)).write;
    const fast = httpTools(sequencedFetch([404], 5)).read;
    const [written, listed] = await Promise.all([
      slow.execute({ charge: "ch_1" }, context("key_slow")),
      fast.execute({}, context("key_fast")),
    ]);
    expect(written).toMatchObject({ httpStatus: 201, idempotencyKey: "key_slow" });
    expect(listed).toMatchObject({ httpStatus: 404, idempotencyKey: null });
  });

  it("goes nowhere outside a call (probes, client tests)", async () => {
    noteHttpResponse(200);
    const outcome = await reportingHttp(async () => "value");
    expect(outcome).toEqual({
      ok: true,
      value: "value",
      report: { httpStatus: null, idempotencyKey: null },
    });
  });
});
