// SDK messages to AgentEvents (src/contracts/events.ts, docs/ARCHITECTURE.md §5).
//
// Shapes are those of @anthropic-ai/claude-agent-sdk 0.3.283 with
// includePartialMessages (spike S2 transcripts): stream events carry the
// deltas; the CLI then emits one assistant message per completed content
// block (sharing message.id), before that block's content_block_stop; tool
// results arrive as user messages with tool_result blocks.
//
// - A step is one model request: step.start at message_start, step.finish at
//   message_stop. Held callback events of the step's calls are released
//   after step.finish (ToolCallLedger).
// - tool.input.start comes from the stream (once per tool_use id);
//   tool.input.available from the complete assistant message (once).
// - Messages with parent_tool_use_id !== null (subagents) produce nothing.
// - A `<synthetic>` or error assistant message is a model error, never text.
// - A tool_result for a call that no callback settled (an unknown tool the
//   CLI refused, a sibling rejected by a stop) becomes its outcome here.

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Redactor } from "../config/redact.js";
import type { AgentEvent, ToolMetadata } from "../contracts/events.js";
import type { JsonObject, JsonValue } from "../contracts/json.js";
import { compactJson, DEFAULT_MAX_OUTPUT_CHARS } from "../gateway/compact.js";
import type { ToolCallLedger } from "./tool-calls.js";

/** How the mapper names and classifies tools (backed by the run's registry). */
export interface ToolView {
  /** Before the input is known: the profile title and base metadata; the raw name when unknown. */
  describe(toolName: string): { readonly title: string; readonly tool: ToolMetadata | null };
  /** From the complete input: the classification's title and metadata; null metadata when unclassifiable. */
  classify(
    toolName: string,
    input: JsonObject,
  ): { readonly title: string; readonly tool: ToolMetadata | null };
}

export type ModelErrorInfo = {
  /** The SDK's error kind (rate_limit, model_not_found, …) or null. */
  readonly kind: string | null;
  readonly message: string;
};

type Block =
  | { readonly kind: "text"; readonly id: string; text: string }
  | { readonly kind: "reasoning"; readonly id: string; started: boolean }
  | { readonly kind: "tool"; readonly toolCallId: string; partialJson: string }
  | { readonly kind: "other" };

const SYNTHETIC_MODEL = "<synthetic>";
export const RUN_ENDED_REASON = "The run ended before this call ran.";
/**
 * A call the SDK refused because the run was being stopped (a sibling queued
 * behind a pending approval, say). The Claude CLI's own text for it is an
 * instruction to the model ("The user doesn't want to proceed…"), which is
 * neither true nor useful to a person reading the action log.
 */
export const STOPPED_BEFORE_RUN_REASON = "Not run: the run was stopped before this call ran.";
const UNKNOWN_TOOL = /No such tool available/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject {
  if (!isObject(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    return {};
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function parseOutput(text: string): JsonValue {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return compactJson(JSON.parse(trimmed) as JsonValue, DEFAULT_MAX_OUTPUT_CHARS).value;
    } catch {
      // Not JSON: keep the text.
    }
  }
  return text.length > DEFAULT_MAX_OUTPUT_CHARS ? text.slice(0, DEFAULT_MAX_OUTPUT_CHARS) : text;
}

export class SdkMessageMapper {
  readonly #emit: (event: AgentEvent) => void;
  readonly #ledger: ToolCallLedger;
  readonly #tools: ToolView;
  readonly #redact: Redactor;
  readonly #isStopping: () => boolean;

  #sessionId: string | null = null;
  #result: SDKResultMessage | null = null;
  #modelError: ModelErrorInfo | null = null;
  #lastText: string | null = null;
  #modelRequests = 0;
  #step = -1;
  #stepOpen = false;
  #messageId: string | null = null;
  readonly #streamedMessages = new Set<string>();
  readonly #blocks = new Map<number, Block>();
  readonly #tokens = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  #messageOutputTokens = 0;
  readonly #partialInputs = new Map<string, string>();
  #syntheticCounter = 0;

  constructor(options: {
    readonly emit: (event: AgentEvent) => void;
    readonly ledger: ToolCallLedger;
    readonly tools: ToolView;
    readonly redact: Redactor;
    /** True once the run's signal aborted: unexplained tool results are then "stopped". */
    readonly isStopping: () => boolean;
  }) {
    this.#emit = options.emit;
    this.#ledger = options.ledger;
    this.#tools = options.tools;
    this.#redact = options.redact;
    this.#isStopping = options.isStopping;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get result(): SDKResultMessage | null {
    return this.#result;
  }

  get modelError(): ModelErrorInfo | null {
    return this.#modelError;
  }

  /** The text of the last complete assistant text block. */
  get lastText(): string | null {
    return this.#lastText;
  }

  get modelRequests(): number {
    return this.#modelRequests;
  }

  /** Main-loop token counts from this run's stream events. */
  get streamTokens(): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
  } {
    return { ...this.#tokens, outputTokens: this.#tokens.outputTokens + this.#messageOutputTokens };
  }

  handle(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        this.#system(message);
        return;
      case "stream_event":
        if (message.parent_tool_use_id === null) this.#stream(message.event);
        return;
      case "assistant":
        if (message.parent_tool_use_id === null) this.#assistant(message);
        return;
      case "user":
        if (message.parent_tool_use_id === null) this.#user(message.message.content);
        return;
      case "result":
        this.#result = message;
        return;
      default:
        return;
    }
  }

  #system(message: Extract<SDKMessage, { type: "system" }>): void {
    if (message.subtype === "init") {
      if (this.#sessionId === null) {
        this.#sessionId = message.session_id;
        this.#emit({ type: "session", sdkSessionId: message.session_id });
      }
      return;
    }
    if (message.subtype === "status") {
      if (message.status === "requesting" || message.status === "compacting") {
        this.#emit({ type: "status", status: { phase: message.status } });
      }
      return;
    }
    if (message.subtype === "api_retry") {
      this.#emit({
        type: "status",
        status: {
          phase: "retrying",
          attempt: message.attempt,
          maxAttempts: message.max_retries,
          retryInMs: message.retry_delay_ms,
          errorStatus: message.error_status,
        },
      });
    }
  }

  #stream(event: Extract<SDKMessage, { type: "stream_event" }>["event"]): void {
    switch (event.type) {
      case "message_start": {
        this.#closeStep();
        this.#step += 1;
        this.#stepOpen = true;
        this.#modelRequests += 1;
        this.#messageId = event.message.id;
        this.#streamedMessages.add(event.message.id);
        this.#blocks.clear();
        const usage = event.message.usage;
        this.#tokens.inputTokens += usage.input_tokens;
        this.#tokens.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        this.#tokens.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        this.#messageOutputTokens = usage.output_tokens;
        this.#emit({ type: "step.start" });
        return;
      }
      case "content_block_start": {
        const block = event.content_block;
        const id = `${this.#messageId ?? "msg"}:${event.index}`;
        if (block.type === "text") {
          this.#blocks.set(event.index, { kind: "text", id, text: "" });
          this.#emit({ type: "text.start", id });
        } else if (block.type === "thinking") {
          this.#blocks.set(event.index, { kind: "reasoning", id, started: false });
        } else if (block.type === "tool_use") {
          this.#blocks.set(event.index, { kind: "tool", toolCallId: block.id, partialJson: "" });
          this.#announce(block.id, block.name, this.#step);
        } else {
          this.#blocks.set(event.index, { kind: "other" });
        }
        return;
      }
      case "content_block_delta": {
        const block = this.#blocks.get(event.index);
        if (block === undefined) return;
        const delta = event.delta;
        if (block.kind === "text" && delta.type === "text_delta") {
          block.text += delta.text;
          if (delta.text !== "")
            this.#emit({ type: "text.delta", id: block.id, delta: delta.text });
        } else if (block.kind === "reasoning" && delta.type === "thinking_delta") {
          if (delta.thinking === "") return;
          if (!block.started) {
            block.started = true;
            this.#emit({ type: "reasoning.start", id: block.id });
          }
          this.#emit({ type: "reasoning.delta", id: block.id, delta: delta.thinking });
        } else if (block.kind === "tool" && delta.type === "input_json_delta") {
          block.partialJson += delta.partial_json;
          this.#partialInputs.set(block.toolCallId, block.partialJson);
          if (delta.partial_json !== "") {
            this.#emit({
              type: "tool.input.delta",
              toolCallId: block.toolCallId,
              inputTextDelta: delta.partial_json,
            });
          }
        }
        return;
      }
      case "content_block_stop": {
        const block = this.#blocks.get(event.index);
        this.#blocks.delete(event.index);
        if (block?.kind === "text") {
          this.#lastText = block.text;
          this.#emit({ type: "text.end", id: block.id });
        } else if (block?.kind === "reasoning" && block.started) {
          this.#emit({ type: "reasoning.end", id: block.id });
        }
        return;
      }
      case "message_delta":
        this.#messageOutputTokens = event.usage.output_tokens;
        return;
      case "message_stop":
        this.#closeStep();
        return;
    }
  }

  /** Ends open blocks and the open step (message_stop, or a stream cut short). */
  #closeStep(): void {
    if (!this.#stepOpen) return;
    for (const block of this.#blocks.values()) {
      if (block.kind === "text") {
        this.#lastText = block.text;
        this.#emit({ type: "text.end", id: block.id });
      } else if (block.kind === "reasoning" && block.started) {
        this.#emit({ type: "reasoning.end", id: block.id });
      }
    }
    this.#blocks.clear();
    this.#tokens.outputTokens += this.#messageOutputTokens;
    this.#messageOutputTokens = 0;
    this.#stepOpen = false;
    this.#emit({ type: "step.finish" });
    this.#ledger.finishStep(this.#step);
  }

  #announce(toolCallId: string, toolName: string, step: number | null): void {
    if (!this.#ledger.noteInputStart(toolCallId, toolName, step)) return;
    const { title, tool } = this.#tools.describe(toolName);
    this.#emit({ type: "tool.input.start", toolCallId, toolName, title, tool });
  }

  #makeAvailable(toolCallId: string, toolName: string, rawInput: unknown): void {
    if (!this.#ledger.noteInputAvailable(toolCallId)) return;
    const input = asJsonObject(rawInput);
    const { title, tool } = this.#tools.classify(toolName, input);
    this.#emit({
      type: "tool.input.available",
      toolCallId,
      toolName,
      title,
      input: this.#redact.json(input) as JsonObject,
      tool,
    });
    this.#ledger.releaseIfReady(toolCallId);
  }

  #assistant(message: Extract<SDKMessage, { type: "assistant" }>): void {
    const { message: body } = message;
    const content = body.content as readonly unknown[];
    if (body.model === SYNTHETIC_MODEL || message.error !== undefined) {
      const text = content
        .map((block) => (isObject(block) && typeof block.text === "string" ? block.text : ""))
        .join("\n")
        .trim();
      this.#modelError ??= {
        kind: message.error ?? null,
        message: this.#redact(text === "" ? "The model request failed." : text),
      };
      return;
    }
    const streamed = this.#streamedMessages.has(body.id);
    for (const block of content) {
      if (!isObject(block)) continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        if (!streamed) this.#announce(block.id, block.name, null);
        this.#makeAvailable(block.id, block.name, block.input);
      } else if (!streamed && block.type === "text" && typeof block.text === "string") {
        const id = `${body.id}:m${this.#syntheticCounter++}`;
        this.#emit({ type: "text.start", id });
        if (block.text !== "") this.#emit({ type: "text.delta", id, delta: block.text });
        this.#emit({ type: "text.end", id });
        this.#lastText = block.text;
      } else if (!streamed && block.type === "thinking" && typeof block.thinking === "string") {
        if (block.thinking === "") continue;
        const id = `${body.id}:m${this.#syntheticCounter++}`;
        this.#emit({ type: "reasoning.start", id });
        this.#emit({ type: "reasoning.delta", id, delta: block.thinking });
        this.#emit({ type: "reasoning.end", id });
      }
    }
  }

  #user(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const toolCallId = block.tool_use_id;
      if (typeof toolCallId !== "string") continue;
      if (!this.#ledger.hasInputStarted(toolCallId)) continue;
      if (this.#ledger.isSettled(toolCallId) || this.#ledger.isExecuting(toolCallId)) continue;
      this.#settleFromResult(toolCallId, toolResultText(block.content), block.is_error === true);
    }
  }

  #settleFromResult(toolCallId: string, rawText: string, isError: boolean): void {
    const text = this.#redact(rawText);
    if (isError && this.#isStopping()) {
      // Every call the gateway ran was settled by the gateway, so this one never ran.
      if (!this.#ledger.settle(toolCallId, "stopped")) return;
      this.#ledger.emitFor(toolCallId, {
        type: "tool.denied",
        toolCallId,
        decision: "stopped",
        reason: STOPPED_BEFORE_RUN_REASON,
      });
      return;
    }
    if (isError && UNKNOWN_TOOL.test(text)) {
      if (!this.#ledger.settle(toolCallId, "rejected")) return;
      this.#ledger.emitFor(toolCallId, {
        type: "tool.denied",
        toolCallId,
        decision: "rejected",
        reason: text,
      });
      return;
    }
    const decision = this.#ledger.decisionOf(toolCallId) ?? "auto";
    if (!this.#ledger.settle(toolCallId, decision)) return;
    this.#ledger.emitFor(toolCallId, {
      type: "tool.output",
      toolCallId,
      output: parseOutput(text),
      truncated: false,
      isError,
      error: isError
        ? { provider: null, status: null, code: null, message: text.slice(0, 1_000) }
        : null,
      durationMs: 0,
      execution: null,
    });
  }

  /**
   * At the end of the run: closes an open step, gives every call without an
   * outcome one (stopped), after making its input available, and releases
   * every held event.
   */
  finish(): void {
    this.#closeStep();
    for (const call of this.#ledger.unannounced()) {
      this.#announce(call.toolCallId, call.toolName, null);
      this.#makeAvailable(call.toolCallId, call.toolName, call.input);
    }
    for (const call of this.#ledger.unsettled()) {
      if (!call.inputAvailable) {
        const partial = this.#partialInputs.get(call.toolCallId) ?? "";
        let input: unknown = {};
        try {
          input = partial === "" ? {} : JSON.parse(partial);
        } catch {
          input = {};
        }
        this.#makeAvailable(call.toolCallId, this.#ledger.toolNameOf(call.toolCallId) ?? "", input);
      }
      if (!this.#ledger.settle(call.toolCallId, "stopped")) continue;
      this.#ledger.emitFor(call.toolCallId, {
        type: "tool.denied",
        toolCallId: call.toolCallId,
        decision: "stopped",
        reason: RUN_ENDED_REASON,
      });
    }
    this.#ledger.releaseAll();
  }
}
