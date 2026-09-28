import { describe, expect, it } from "vitest";
import {
  ENDED_WHILE_RUNNING,
  RUN_ENDED_REASON,
  SdkMessageMapper,
  STOPPED_BEFORE_RUN_REASON,
  type ToolView,
} from "../../../src/agent/sdk-mapper.js";
import { ToolCallLedger } from "../../../src/agent/tool-calls.js";
import { createRedactorFor } from "../../../src/config/redact.js";
import { REDACTED } from "../../../src/config/secret.js";
import type { AgentEvent, ToolMetadata } from "../../../src/contracts/events.js";
import { eventContractViolations, forCall, ofType } from "../../helpers/event-contract.js";
import {
  apiRetry,
  assistant,
  blockStart,
  blockStop,
  delta,
  init,
  messageDelta,
  messageStart,
  messageStop,
  result,
  status,
  textStep,
  toolResult,
  toolStep,
} from "../../helpers/sdk-messages.js";

const REFUND: ToolMetadata = {
  integration: "stripe",
  connectionKind: "api",
  operation: "stripe.refunds.create",
  actionClass: "financial",
};

const tools: ToolView = {
  describe: (name) =>
    name === "mcp__stripe__create_refund"
      ? { title: "Refund charge in Stripe", tool: REFUND }
      : { title: name, tool: null },
  classify: (name, input) =>
    name === "mcp__stripe__create_refund"
      ? { title: `Refund ${String(input.charge)}`, tool: REFUND }
      : { title: name, tool: null },
};

function setup(options: { stopping?: () => boolean; secrets?: string[] } = {}) {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => events.push(event);
  const ledger = new ToolCallLedger(emit);
  const mapper = new SdkMessageMapper({
    emit,
    ledger,
    tools,
    redact: createRedactorFor(options.secrets ?? []),
    isStopping: options.stopping ?? (() => false),
  });
  return { events, ledger, mapper };
}

/** Wraps events as a full run so the contract checker can judge them. */
function asRun(events: readonly AgentEvent[]): AgentEvent[] {
  return [
    {
      type: "run.started",
      runId: "r",
      conversationId: "c",
      source: "ui",
      mode: "interactive",
      model: "m",
      effort: "medium",
      startedAt: "",
      connections: [],
    },
    ...events,
    {
      type: "run.finished",
      status: "completed",
      finishedAt: "",
      stopReason: null,
      terminalReason: null,
      reply: null,
      error: null,
    },
  ];
}

describe("SdkMessageMapper", () => {
  it("maps session, status, steps, reasoning and text", () => {
    const { events, mapper } = setup();
    for (const message of [
      init("sess_1"),
      init("sess_1"),
      status("requesting"),
      status(null),
      apiRetry(2, 529),
      messageStart("msg_1"),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "thinking_delta", thinking: "Check " }),
      delta(0, { type: "thinking_delta", thinking: "first." }),
      delta(0, { type: "signature_delta", signature: "sig" }),
      assistant("msg_1", [{ type: "thinking", thinking: "Check first.", signature: "sig" }]),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      delta(1, { type: "text_delta", text: "Hello " }),
      delta(1, { type: "text_delta", text: "Dana." }),
      assistant("msg_1", [{ type: "text", text: "Hello Dana." }]),
      blockStop(1),
      messageDelta(42),
      messageStop(),
    ]) {
      mapper.handle(message);
    }
    expect(events).toEqual([
      { type: "session", sdkSessionId: "sess_1" },
      { type: "status", status: { phase: "requesting" } },
      {
        type: "status",
        status: {
          phase: "retrying",
          attempt: 2,
          maxAttempts: 10,
          retryInMs: 500,
          errorStatus: 529,
        },
      },
      { type: "step.start" },
      { type: "reasoning.start", id: "msg_1:0" },
      { type: "reasoning.delta", id: "msg_1:0", delta: "Check " },
      { type: "reasoning.delta", id: "msg_1:0", delta: "first." },
      { type: "reasoning.end", id: "msg_1:0" },
      { type: "text.start", id: "msg_1:1" },
      { type: "text.delta", id: "msg_1:1", delta: "Hello " },
      { type: "text.delta", id: "msg_1:1", delta: "Dana." },
      { type: "text.end", id: "msg_1:1" },
      { type: "step.finish" },
    ]);
    expect(mapper.sessionId).toBe("sess_1");
    expect(mapper.lastText).toBe("Hello Dana.");
    expect(mapper.modelRequests).toBe(1);
    expect(mapper.streamTokens).toEqual({
      inputTokens: 100,
      outputTokens: 42,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });
  });

  it("skips thinking that never produced text (display omitted)", () => {
    const { events, mapper } = setup();
    for (const message of [
      messageStart("msg_1"),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "signature_delta", signature: "sig" }),
      blockStop(0),
      messageStop(),
    ]) {
      mapper.handle(message);
    }
    expect(events.map((event) => event.type)).toEqual(["step.start", "step.finish"]);
  });

  it("announces a tool call once from the stream and makes it available once from the message", () => {
    const { events, mapper } = setup();
    const refund = { charge: "ch_2", amount: 4900 };
    for (const message of [
      messageStart("msg_1"),
      ...toolStep("msg_1", "toolu_1", "mcp__stripe__create_refund", refund),
      // The CLI can repeat a block; it must not produce a second start or available.
      assistant("msg_1", [
        { type: "tool_use", id: "toolu_1", name: "mcp__stripe__create_refund", input: refund },
      ]),
      messageStop(),
    ]) {
      mapper.handle(message);
    }
    expect(forCall(events, "toolu_1")).toEqual([
      {
        type: "tool.input.start",
        toolCallId: "toolu_1",
        toolName: "mcp__stripe__create_refund",
        title: "Refund charge in Stripe",
        tool: REFUND,
      },
      { type: "tool.input.delta", toolCallId: "toolu_1", inputTextDelta: '{"cha' },
      {
        type: "tool.input.delta",
        toolCallId: "toolu_1",
        inputTextDelta: 'rge":"ch_2","amount":4900}',
      },
      {
        type: "tool.input.available",
        toolCallId: "toolu_1",
        toolName: "mcp__stripe__create_refund",
        title: "Refund ch_2",
        input: refund,
        tool: REFUND,
      },
    ]);
  });

  it("holds a callback's events until the call's step has finished", () => {
    const { events, ledger, mapper } = setup();
    mapper.handle(messageStart("msg_1"));
    for (const message of toolStep("msg_1", "toolu_1", "mcp__stripe__create_refund", {
      charge: "ch_2",
    })) {
      mapper.handle(message);
    }
    // canUseTool asked before this process consumed message_stop.
    ledger.emitFor("toolu_1", {
      type: "approval.requested",
      approvalId: "appr_1",
      toolCallId: "toolu_1",
      descriptor: {
        consequence: "Refund",
        facts: [],
        actionClass: "financial",
        integration: "stripe",
        connectionKind: "api",
        operation: "stripe.refunds.create",
        title: "Refund",
        expiresAt: "2026-09-28T12:15:00.000Z",
      },
    });
    expect(ofType(events, "approval.requested")).toHaveLength(0);
    mapper.handle(messageStop());
    const types = events.map((event) => event.type);
    expect(types.slice(-2)).toEqual(["step.finish", "approval.requested"]);
  });

  it("holds events of a call whose callback ran before the mapper saw the call at all", () => {
    const { events, ledger, mapper } = setup();
    ledger.emitFor("toolu_early", {
      type: "tool.denied",
      toolCallId: "toolu_early",
      decision: "rejected",
      reason: "bad",
    });
    expect(events).toEqual([]);
    mapper.handle(messageStart("msg_1"));
    for (const message of toolStep("msg_1", "toolu_early", "mcp__stripe__create_refund", {
      charge: "ch_early",
    })) {
      mapper.handle(message);
    }
    mapper.handle(messageStop());
    expect(forCall(events, "toolu_early").map((event) => event.type)).toEqual([
      "tool.input.start",
      "tool.input.delta",
      "tool.input.delta",
      "tool.input.available",
      "tool.denied",
    ]);
  });

  it("treats a <synthetic> or error assistant message as a model error, never as text", () => {
    const { events, mapper } = setup({ secrets: ["gateway-secret-value"] });
    mapper.handle(
      assistant(
        "msg_x",
        [{ type: "text", text: "API Error: 529 overloaded via gateway-secret-value" }],
        {
          model: "<synthetic>",
          error: "server_error",
        },
      ),
    );
    expect(events).toEqual([]);
    expect(mapper.modelError).toEqual({
      kind: "server_error",
      message: `API Error: 529 overloaded via ${REDACTED}`,
    });
    mapper.handle(assistant("msg_y", [{ type: "text", text: "later" }], { error: "rate_limit" }));
    expect(mapper.modelError?.kind).toBe("server_error");
  });

  it("produces nothing for subagent messages", () => {
    const { events, mapper } = setup();
    for (const message of [
      messageStart("msg_sub", 5, "toolu_task"),
      blockStart(0, { type: "text", text: "" }, "toolu_task"),
      delta(0, { type: "text_delta", text: "inner" }, "toolu_task"),
      assistant("msg_sub", [{ type: "text", text: "inner" }], { parent: "toolu_task" }),
      toolResult("toolu_inner", "x", false, "toolu_task"),
      messageStop("toolu_task"),
    ]) {
      mapper.handle(message);
    }
    expect(events).toEqual([]);
    expect(mapper.modelRequests).toBe(0);
  });

  it("emits text and tool events for a message that was not streamed", () => {
    const { events, mapper } = setup();
    mapper.handle(
      assistant("msg_plain", [
        { type: "thinking", thinking: "Plan.", signature: "s" },
        { type: "text", text: "Looking." },
        {
          type: "tool_use",
          id: "toolu_p",
          name: "mcp__stripe__create_refund",
          input: { charge: "ch_9" },
        },
      ]),
    );
    expect(events.map((event) => event.type)).toEqual([
      "reasoning.start",
      "reasoning.delta",
      "reasoning.end",
      "text.start",
      "text.delta",
      "text.end",
      "tool.input.start",
      "tool.input.available",
    ]);
    expect(mapper.lastText).toBe("Looking.");
  });

  it("settles a call no callback settled from its tool_result: rejected, stopped or output", () => {
    const { events, ledger, mapper } = setup();
    mapper.handle(messageStart("msg_1"));
    for (const [index, id] of ["toolu_unknown", "toolu_ok", "toolu_done"].entries()) {
      for (const message of toolStep("msg_1", id, "mcp__stripe__nope", {}, index))
        mapper.handle(message);
    }
    mapper.handle(messageStop());
    ledger.settle("toolu_done", "auto");
    mapper.handle(
      toolResult(
        "toolu_unknown",
        "<tool_use_error>Error: No such tool available: mcp__stripe__nope</tool_use_error>",
        true,
      ),
    );
    mapper.handle(toolResult("toolu_ok", '{"ok":true}'));
    mapper.handle(toolResult("toolu_done", "ignored"));
    mapper.handle(toolResult("toolu_never_announced", "ignored"));
    expect(ofType(events, "tool.denied")).toEqual([
      {
        type: "tool.denied",
        toolCallId: "toolu_unknown",
        decision: "rejected",
        reason: "<tool_use_error>Error: No such tool available: mcp__stripe__nope</tool_use_error>",
      },
    ]);
    expect(ofType(events, "tool.output")).toEqual([
      {
        type: "tool.output",
        toolCallId: "toolu_ok",
        output: { ok: true },
        truncated: false,
        isError: false,
        error: null,
        durationMs: 0,
        execution: null,
      },
    ]);
  });

  it("reports an error tool_result during a stop as stopped, with a plain reason", () => {
    let stopping = false;
    const { events, mapper } = setup({ stopping: () => stopping });
    mapper.handle(messageStart("msg_1"));
    for (const message of toolStep("msg_1", "toolu_sibling", "mcp__stripe__create_refund", {})) {
      mapper.handle(message);
    }
    mapper.handle(messageStop());
    stopping = true;
    mapper.handle(
      toolResult("toolu_sibling", "The user doesn't want to proceed with this tool use.", true),
    );
    expect(ofType(events, "tool.denied")).toEqual([
      {
        type: "tool.denied",
        toolCallId: "toolu_sibling",
        decision: "stopped",
        reason: STOPPED_BEFORE_RUN_REASON,
      },
    ]);
  });

  it("rejects a call to a tool the run never offered, even while stopping", () => {
    const { events, mapper } = setup({ stopping: () => true });
    mapper.handle(messageStart("msg_1"));
    for (const message of toolStep("msg_1", "toolu_x0", "mcp__slack__post_message", {})) {
      mapper.handle(message);
    }
    for (const message of toolStep("msg_1", "toolu_cut", "mcp__slack__add_reaction", {}, 1)) {
      mapper.handle(message);
    }
    mapper.handle(messageStop());
    mapper.handle(
      toolResult(
        "toolu_x0",
        "<tool_use_error>Error: No such tool available</tool_use_error>",
        true,
      ),
    );
    mapper.finish();
    expect(ofType(events, "tool.denied")).toEqual([
      {
        type: "tool.denied",
        toolCallId: "toolu_x0",
        decision: "rejected",
        reason: "<tool_use_error>Error: No such tool available</tool_use_error>",
      },
      {
        type: "tool.denied",
        toolCallId: "toolu_cut",
        decision: "rejected",
        reason: "Not run: mcp__slack__add_reaction is not a tool of this run.",
      },
    ]);
  });

  it("does not settle a call the gateway is still executing", () => {
    const { events, ledger, mapper } = setup();
    mapper.handle(messageStart("msg_1"));
    for (const message of toolStep("msg_1", "toolu_slow", "mcp__stripe__create_refund", {})) {
      mapper.handle(message);
    }
    mapper.handle(messageStop());
    ledger.setExecuting("toolu_slow", true);
    mapper.handle(toolResult("toolu_slow", "MCP error -32001: Request timed out", true));
    expect(ofType(events, "tool.output")).toEqual([]);
  });

  it("finishes a cut-short run: closes the step and blocks, and stops calls without an outcome", () => {
    const { events, mapper } = setup();
    for (const message of [
      messageStart("msg_1"),
      blockStart(0, { type: "text", text: "" }),
      delta(0, { type: "text_delta", text: "Refunding" }),
      blockStart(1, {
        type: "tool_use",
        id: "toolu_cut",
        name: "mcp__stripe__create_refund",
        input: {},
      }),
      delta(1, { type: "input_json_delta", partial_json: '{"charge":"ch_2"' }),
    ]) {
      mapper.handle(message);
    }
    mapper.finish();
    expect(eventContractViolations(asRun(events))).toEqual([]);
    expect(forCall(events, "toolu_cut").map((event) => event.type)).toEqual([
      "tool.input.start",
      "tool.input.delta",
      "tool.input.available",
      "tool.denied",
    ]);
    expect(ofType(events, "tool.input.available")[0]?.input).toEqual({});
    expect(ofType(events, "tool.denied")[0]).toMatchObject({
      decision: "stopped",
      reason: RUN_ENDED_REASON,
    });
    expect(mapper.lastText).toBe("Refunding");
  });

  it("never says a call the gateway was still executing at the end did not run", () => {
    const { events, ledger, mapper } = setup();
    mapper.handle(messageStart("msg_1"));
    for (const message of toolStep("msg_1", "toolu_refund", "mcp__stripe__create_refund", {
      charge: "ch_2",
    })) {
      mapper.handle(message);
    }
    mapper.handle(messageStop());
    ledger.decide("toolu_refund", "approved");
    ledger.setExecuting("toolu_refund", true, {
      upstreamTool: "POST /v1/refunds",
      idempotencyKey: "k".repeat(64),
      readOnly: false,
      apiKind: true,
    });
    mapper.finish();
    expect(ofType(events, "tool.denied")).toEqual([]);
    expect(ofType(events, "tool.output")).toEqual([
      {
        type: "tool.output",
        toolCallId: "toolu_refund",
        output: ENDED_WHILE_RUNNING,
        truncated: false,
        isError: true,
        error: {
          provider: null,
          status: null,
          code: "outcome_unknown",
          message: ENDED_WHILE_RUNNING,
        },
        durationMs: 0,
        // The provider can be asked about this request.
        execution: {
          upstreamTool: "POST /v1/refunds",
          httpStatus: null,
          idempotencyKey: "k".repeat(64),
        },
      },
    ]);
    expect(ENDED_WHILE_RUNNING).toMatch(/may already have been made\. Do not repeat it/);
    expect(eventContractViolations(asRun(events))).toEqual([]);
  });

  it("announces a call only a callback saw before stopping it at the end", () => {
    const { events, ledger, mapper } = setup();
    ledger.noteCallbackCall("toolu_ghost", "mcp__stripe__create_refund", { charge: "ch_7" });
    mapper.finish();
    expect(forCall(events, "toolu_ghost").map((event) => event.type)).toEqual([
      "tool.input.start",
      "tool.input.available",
      "tool.denied",
    ]);
    expect(eventContractViolations(asRun(events))).toEqual([]);
  });

  it("keeps the result message", () => {
    const { mapper } = setup();
    mapper.handle(result());
    expect(mapper.result?.subtype).toBe("success");
  });

  it("produces a stream that keeps the event contract for a typical run", () => {
    const { events, ledger, mapper } = setup();
    const messages = [
      init(),
      status("requesting"),
      messageStart("msg_1"),
      ...toolStep("msg_1", "toolu_a", "mcp__stripe__create_refund", { charge: "ch_1" }, 0),
      ...toolStep("msg_1", "toolu_b", "mcp__stripe__create_refund", { charge: "ch_2" }, 1),
      messageStop(),
    ];
    for (const message of messages) mapper.handle(message);
    ledger.settle("toolu_a", "auto");
    ledger.emitFor("toolu_a", {
      type: "tool.output",
      toolCallId: "toolu_a",
      output: {},
      truncated: false,
      isError: false,
      error: null,
      durationMs: 3,
      execution: null,
    });
    mapper.handle(toolResult("toolu_a", "{}"));
    mapper.handle(toolResult("toolu_b", "{}"));
    for (const message of textStep("msg_2", "All done.")) mapper.handle(message);
    mapper.handle(result());
    mapper.finish();
    expect(eventContractViolations(asRun(events))).toEqual([]);
    expect(ofType(events, "tool.output").map((event) => event.toolCallId)).toEqual([
      "toolu_a",
      "toolu_b",
    ]);
  });
});
