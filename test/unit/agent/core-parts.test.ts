import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { EventChannel } from "../../../src/agent/event-channel.js";
import { runOutcome, stopReasonOf } from "../../../src/agent/outcome.js";
import { ToolCallLedger } from "../../../src/agent/tool-calls.js";
import type { AgentEvent } from "../../../src/contracts/events.js";
import { result } from "../../helpers/sdk-messages.js";

const identity = (text: string) => text;

describe("EventChannel", () => {
  it("delivers pushed values in order to one consumer, then ends on close", async () => {
    const channel = new EventChannel<number>();
    channel.push(1);
    const collected: number[] = [];
    const consumer = (async () => {
      for await (const value of channel) collected.push(value);
    })();
    channel.push(2);
    await Promise.resolve();
    channel.push(3);
    channel.close();
    channel.push(4);
    await consumer;
    expect(collected).toEqual([1, 2, 3]);
    expect(channel.closed).toBe(true);
  });

  it("refuses a second consumer", () => {
    const channel = new EventChannel<number>();
    channel[Symbol.asyncIterator]();
    expect(() => channel[Symbol.asyncIterator]()).toThrow("single consumer");
  });
});

describe("ToolCallLedger", () => {
  const denied = (id: string): AgentEvent => ({
    type: "tool.denied",
    toolCallId: id,
    decision: "rejected",
    reason: "x",
  });

  it("holds events until input is available and the call's step has finished", () => {
    const emitted: AgentEvent[] = [];
    const ledger = new ToolCallLedger((event) => emitted.push(event));
    ledger.noteInputStart("a", "tool", 0);
    ledger.emitFor("a", denied("a"));
    ledger.noteInputAvailable("a");
    ledger.releaseIfReady("a");
    expect(emitted).toEqual([]);
    ledger.finishStep(0);
    expect(emitted).toEqual([denied("a")]);
    ledger.emitFor("a", denied("a"));
    expect(emitted).toHaveLength(2);
  });

  it("releases a call from a non-streamed message as soon as its input is available", () => {
    const emitted: AgentEvent[] = [];
    const ledger = new ToolCallLedger((event) => emitted.push(event));
    ledger.emitFor("b", denied("b"));
    ledger.noteInputStart("b", "tool", null);
    expect(ledger.noteInputAvailable("b")).toBe(true);
    expect(ledger.noteInputAvailable("b")).toBe(false);
    ledger.releaseIfReady("b");
    expect(emitted).toEqual([denied("b")]);
  });

  it("settles each call once and remembers how it was decided", () => {
    const ledger = new ToolCallLedger(() => {});
    ledger.decide("c", "approved");
    expect(ledger.settle("c", "auto")).toBe(true);
    expect(ledger.settle("c", "denied")).toBe(false);
    expect(ledger.decisionOf("c")).toBe("approved");
    expect(ledger.isSettled("c")).toBe(true);
    ledger.setExecuting("d", true);
    expect(ledger.isExecuting("d")).toBe(true);
  });

  it("lists unsettled and unannounced calls, and releases everything at the end", () => {
    const emitted: AgentEvent[] = [];
    const ledger = new ToolCallLedger((event) => emitted.push(event));
    ledger.noteInputStart("e", "tool_e", 3);
    ledger.noteCallbackCall("f", "tool_f", { a: 1 });
    ledger.emitFor("f", denied("f"));
    expect(ledger.unsettled()).toEqual([
      { toolCallId: "e", inputAvailable: false, executing: false },
    ]);
    expect(ledger.unannounced()).toEqual([
      { toolCallId: "f", toolName: "tool_f", input: { a: 1 } },
    ]);
    expect(ledger.toolNameOf("e")).toBe("tool_e");
    ledger.releaseAll();
    expect(emitted).toEqual([denied("f")]);
  });
});

describe("runOutcome", () => {
  const outcome = (fields: Partial<Parameters<typeof runOutcome>[0]>) =>
    runOutcome({
      stopReason: null,
      result: null,
      modelError: null,
      thrown: undefined,
      redact: identity,
      ...fields,
    });
  const sdkResult = (fields: object) => result(fields) as SDKResultMessage;

  it("maps the stop reason first: user and shutdown cancel, timeout times out", () => {
    expect(outcome({ stopReason: "user", result: sdkResult({}) })).toEqual({
      status: "cancelled",
      error: { code: "cancelled", message: "The run was stopped." },
      stopReason: "user",
      terminalReason: "completed",
    });
    expect(outcome({ stopReason: "shutdown" }).status).toBe("cancelled");
    expect(outcome({ stopReason: "timeout" })).toMatchObject({
      status: "timed_out",
      error: { code: "timeout" },
    });
    expect(stopReasonOf("timeout")).toBe("timeout");
    expect(stopReasonOf(new Error("x"))).toBe("user");
  });

  it("completes on a clean success and fails on every other result", () => {
    expect(outcome({ result: sdkResult({}) })).toEqual({
      status: "completed",
      error: null,
      stopReason: null,
      terminalReason: "completed",
    });
    expect(
      outcome({
        result: sdkResult({
          is_error: true,
          result: "API Error: 400",
          terminal_reason: "api_error",
        }),
      }),
    ).toMatchObject({
      status: "failed",
      error: { code: "model_error", message: "API Error: 400" },
    });
    expect(
      outcome({ result: sdkResult({ subtype: "error_max_turns", terminal_reason: "max_turns" }) }),
    ).toMatchObject({
      status: "failed",
      error: { code: "max_turns" },
      terminalReason: "max_turns",
    });
    expect(outcome({ result: sdkResult({ subtype: "error_max_budget_usd" }) }).error?.code).toBe(
      "budget_exceeded",
    );
    expect(
      outcome({
        result: sdkResult({
          subtype: "error_during_execution",
          errors: ["[ede_diagnostic] result_type=user", "No conversation found"],
        }),
      }).error,
    ).toEqual({ code: "internal", message: "No conversation found" });
  });

  it("prefers a model error message over the result", () => {
    expect(
      outcome({
        modelError: { kind: "overloaded", message: "API Error: 529" },
        result: sdkResult({}),
      }),
    ).toMatchObject({
      status: "failed",
      error: { code: "model_error", message: "API Error: 529" },
    });
  });

  it("reports a throw or a missing result as internal, redacted", () => {
    expect(
      outcome({
        thrown: new Error("spawn failed with key abc"),
        redact: (text) => text.replace("abc", "***"),
      }),
    ).toMatchObject({
      status: "failed",
      error: { code: "internal", message: "spawn failed with key ***" },
    });
    expect(outcome({}).error).toEqual({
      code: "internal",
      message: "The agent ended without a result.",
    });
  });
});
