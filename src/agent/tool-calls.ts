// Per-call bookkeeping shared by the SDK message mapper and the callbacks
// that decide and execute calls (PreToolUse hook, canUseTool, the gateway
// observer), so the event stream keeps the contract's order
// (src/contracts/events.ts, rule 3):
//
// - The callbacks run as soon as the Claude CLI asks, which can be before
//   this process has consumed the SDK messages that announced the call. Their
//   events are held per call and released only after the mapper emitted the
//   call's tool.input.available and the step.finish of its step.
// - A call settles once: the first outcome (tool.output or tool.denied) wins,
//   and later reports of the same call (the SDK's tool_result echo, a
//   timed-out handler finishing late) are dropped.

import type { AgentEvent, ToolDecision } from "../contracts/events.js";
import type { JsonObject } from "../contracts/json.js";

/** What the gateway knows about a call it started. */
export type CallExecution = {
  readonly upstreamTool: string;
  /** A write's idempotency key (API writes send it to the provider). */
  readonly idempotencyKey: string | null;
  readonly readOnly: boolean;
  readonly apiKind: boolean;
};

type CallState = {
  readonly toolCallId: string;
  toolName: string | null;
  /** The step whose message carried the tool_use; null for a non-streamed message. */
  step: number | null;
  inputStarted: boolean;
  inputAvailable: boolean;
  released: boolean;
  settled: boolean;
  /** The gateway started it and has not reported it finished. */
  executing: boolean;
  /** How the gateway runs it, from the moment it started: for an outcome the run cannot wait for. */
  execution: CallExecution | null;
  decision: ToolDecision | null;
  /** What a callback saw, for a call the mapper never announced. */
  callbackInput: JsonObject | null;
  readonly held: AgentEvent[];
};

export class ToolCallLedger {
  readonly #calls = new Map<string, CallState>();
  readonly #finishedSteps = new Set<number>();
  readonly #emit: (event: AgentEvent) => void;

  constructor(emit: (event: AgentEvent) => void) {
    this.#emit = emit;
  }

  #state(toolCallId: string): CallState {
    let state = this.#calls.get(toolCallId);
    if (state === undefined) {
      state = {
        toolCallId,
        toolName: null,
        step: null,
        inputStarted: false,
        inputAvailable: false,
        released: false,
        settled: false,
        executing: false,
        execution: null,
        decision: null,
        callbackInput: null,
        held: [],
      };
      this.#calls.set(toolCallId, state);
    }
    return state;
  }

  #release(state: CallState): void {
    if (state.released) return;
    state.released = true;
    for (const event of state.held.splice(0)) this.#emit(event);
  }

  /** The mapper saw the call's tool_use start; true the first time. */
  noteInputStart(toolCallId: string, toolName: string, step: number | null): boolean {
    const state = this.#state(toolCallId);
    if (state.inputStarted) return false;
    state.inputStarted = true;
    state.toolName = toolName;
    state.step = step;
    return true;
  }

  /** A callback (hook, canUseTool) saw the call: remembered in case the mapper never announces it. */
  noteCallbackCall(toolCallId: string, toolName: string, input: JsonObject): void {
    const state = this.#state(toolCallId);
    state.toolName ??= toolName;
    state.callbackInput ??= input;
  }

  toolNameOf(toolCallId: string): string | null {
    return this.#calls.get(toolCallId)?.toolName ?? null;
  }

  /** Calls only a callback saw, with what it saw. */
  unannounced(): {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: JsonObject;
  }[] {
    return [...this.#calls.values()].flatMap((state) =>
      !state.inputStarted && state.toolName !== null
        ? [
            {
              toolCallId: state.toolCallId,
              toolName: state.toolName,
              input: state.callbackInput ?? {},
            },
          ]
        : [],
    );
  }

  hasInputStarted(toolCallId: string): boolean {
    return this.#calls.get(toolCallId)?.inputStarted === true;
  }

  /**
   * The mapper is about to emit tool.input.available; true the first time.
   * Call releaseIfReady() after emitting it.
   */
  noteInputAvailable(toolCallId: string): boolean {
    const state = this.#state(toolCallId);
    if (state.inputAvailable) return false;
    state.inputAvailable = true;
    return true;
  }

  /** Releases the call's held events when its input is available and its step has finished. */
  releaseIfReady(toolCallId: string): void {
    const state = this.#calls.get(toolCallId);
    if (state === undefined || !state.inputAvailable) return;
    if (state.step === null || this.#finishedSteps.has(state.step)) this.#release(state);
  }

  /** The mapper emitted step.finish: release the step's calls whose input is available. */
  finishStep(step: number): void {
    this.#finishedSteps.add(step);
    for (const state of this.#calls.values()) {
      if (state.step === step && state.inputAvailable) this.#release(state);
    }
  }

  /** Emits an event of one call now, or holds it until the call is released. */
  emitFor(toolCallId: string, event: AgentEvent): void {
    const state = this.#state(toolCallId);
    if (state.released) this.#emit(event);
    else state.held.push(event);
  }

  /** Claims the call's outcome; false when it already has one. */
  settle(toolCallId: string, decision: ToolDecision): boolean {
    const state = this.#state(toolCallId);
    if (state.settled) return false;
    state.settled = true;
    if (state.decision === null || state.decision === "pending") state.decision = decision;
    return true;
  }

  /** Records how the call was decided before its outcome (auto, approved). */
  decide(toolCallId: string, decision: ToolDecision): void {
    this.#state(toolCallId).decision = decision;
  }

  isSettled(toolCallId: string): boolean {
    return this.#calls.get(toolCallId)?.settled === true;
  }

  setExecuting(toolCallId: string, executing: boolean, execution?: CallExecution): void {
    const state = this.#state(toolCallId);
    state.executing = executing;
    if (execution !== undefined) state.execution = execution;
  }

  executionOf(toolCallId: string): CallExecution | null {
    return this.#calls.get(toolCallId)?.execution ?? null;
  }

  isExecuting(toolCallId: string): boolean {
    return this.#calls.get(toolCallId)?.executing === true;
  }

  decisionOf(toolCallId: string): ToolDecision | null {
    return this.#calls.get(toolCallId)?.decision ?? null;
  }

  /** Calls the mapper announced that have no outcome yet. */
  unsettled(): {
    readonly toolCallId: string;
    readonly inputAvailable: boolean;
    readonly executing: boolean;
  }[] {
    return [...this.#calls.values()]
      .filter((state) => state.inputStarted && !state.settled)
      .map((state) => ({
        toolCallId: state.toolCallId,
        inputAvailable: state.inputAvailable,
        executing: state.executing,
      }));
  }

  /** At the end of the run: emit everything still held, in call order. */
  releaseAll(): void {
    for (const state of this.#calls.values()) this.#release(state);
  }
}
