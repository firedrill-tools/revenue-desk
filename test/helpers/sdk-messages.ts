/**
 * Builders for Claude Agent SDK 0.3.283 messages in the shapes the S2 spike
 * transcripts recorded (includePartialMessages: stream events, then one
 * assistant message per completed block before its content_block_stop, then
 * user tool_result messages). Only the fields the mapper reads are filled;
 * each builder casts once at the boundary.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const SESSION = "11111111-2222-3333-4444-555555555555";
const base = { session_id: SESSION, uuid: "00000000-0000-0000-0000-000000000000" };

function message(value: object): SDKMessage {
  return { ...base, ...value } as unknown as SDKMessage;
}

export const init = (sessionId = SESSION) =>
  message({ type: "system", subtype: "init", session_id: sessionId, tools: [], mcp_servers: [] });

export const status = (value: "requesting" | "compacting" | null) =>
  message({ type: "system", subtype: "status", status: value });

export const apiRetry = (attempt: number, errorStatus: number | null) =>
  message({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: errorStatus,
    error: "overloaded",
  });

const stream = (event: object, parent: string | null = null) =>
  message({ type: "stream_event", event, parent_tool_use_id: parent });

export const messageStart = (id: string, inputTokens = 100, parent: string | null = null) =>
  stream(
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        usage: {
          input_tokens: inputTokens,
          output_tokens: 1,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    },
    parent,
  );

export const blockStart = (index: number, block: object, parent: string | null = null) =>
  stream({ type: "content_block_start", index, content_block: block }, parent);

export const delta = (index: number, value: object, parent: string | null = null) =>
  stream({ type: "content_block_delta", index, delta: value }, parent);

export const blockStop = (index: number, parent: string | null = null) =>
  stream({ type: "content_block_stop", index }, parent);

export const messageDelta = (outputTokens: number) =>
  stream({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: outputTokens },
  });

export const messageStop = (parent: string | null = null) =>
  stream({ type: "message_stop" }, parent);

export const assistant = (
  id: string,
  content: readonly object[],
  options: {
    readonly model?: string;
    readonly error?: string;
    readonly parent?: string | null;
  } = {},
) =>
  message({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: options.model ?? "claude-sonnet-5",
      content,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: options.parent ?? null,
    ...(options.error === undefined ? {} : { error: options.error }),
  });

export const toolResult = (
  toolUseId: string,
  text: string,
  isError = false,
  parent: string | null = null,
) =>
  message({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: isError ? text : [{ type: "text", text }],
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: parent,
  });

export const result = (fields: object = {}) =>
  message({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    num_turns: 2,
    duration_ms: 900,
    duration_api_ms: 400,
    total_cost_usd: 0.012,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 3000,
        outputTokens: 600,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 15,
        webSearchRequests: 0,
        costUSD: 0.012,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
    permission_denials: [],
    errors: [],
    ...fields,
  });

/** A streamed step with one text block, as the CLI emits it. */
export function textStep(id: string, text: string, pieces = 8): SDKMessage[] {
  const chunks: SDKMessage[] = [];
  for (let start = 0; start < text.length; start += pieces) {
    chunks.push(delta(0, { type: "text_delta", text: text.slice(start, start + pieces) }));
  }
  return [
    messageStart(id),
    blockStart(0, { type: "text", text: "" }),
    ...chunks,
    assistant(id, [{ type: "text", text }]),
    blockStop(0),
    messageDelta(20),
    messageStop(),
  ];
}

/** A streamed step with one tool_use block. */
export function toolStep(
  id: string,
  toolUseId: string,
  name: string,
  input: object,
  index = 0,
): SDKMessage[] {
  const json = JSON.stringify(input);
  return [
    blockStart(index, { type: "tool_use", id: toolUseId, name, input: {} }),
    delta(index, { type: "input_json_delta", partial_json: json.slice(0, 5) }),
    delta(index, { type: "input_json_delta", partial_json: json.slice(5) }),
    assistant(id, [{ type: "tool_use", id: toolUseId, name, input }]),
    blockStop(index),
  ];
}
