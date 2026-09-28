/**
 * A scripted, loopback stand-in for the Anthropic Messages API, for running
 * the real Claude Agent SDK and its native CLI with no model and no network.
 *
 * Provenance: adapted from firedrill-tools/firedrill-platform
 * `apps/agent/test/mock-anthropic.ts` (worktree HEAD c7b9f1e8; the file last
 * changed in 4644332e, 2026-09-27). Same owner. Revenue Desk changes:
 * - thinking blocks (`thinking_delta` then `signature_delta`);
 * - text, thinking and tool-input deltas split into several chunks, as the
 *   real API streams them, plus a `ping` after `message_start`;
 * - request headers are recorded, with `x-api-key` and `authorization` removed;
 * - per-reply usage can come from the script.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One content block the scripted model returns. */
export type ScriptedBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

export interface MessagesBody {
  readonly model?: string;
  readonly stream?: boolean;
  readonly system?: unknown;
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly input_schema?: unknown;
  }[];
  readonly messages?: readonly { readonly role: string; readonly content: unknown }[];
  readonly [key: string]: unknown;
}

export interface RecordedRequest {
  readonly method: string;
  /** Path and query as the server saw it; absolute-form requests keep their host. */
  readonly target: string;
  /** True when the request's x-api-key or bearer token equals the expected credential. */
  readonly usedExpectedCredential: boolean;
  /** The anthropic-beta header values, as sent. */
  readonly betas: readonly string[];
  readonly version?: string;
  /** Every header except `x-api-key` and `authorization`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** An HTTP error reply instead of a model message. */
export interface ScriptedError {
  readonly httpStatus: number;
  readonly message: string;
  /** The Messages API error type; defaults to `invalid_request_error`. */
  readonly errorType?: string;
  /** Extra response headers, such as `x-should-retry: false`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** No reply at all: the request stays open until the client gives up or the mock closes. */
export interface ScriptedHang {
  readonly hang: true;
}

/** Decides one reply from the request body; `undefined` means a plain side-request reply. */
export type Responder = (
  body: MessagesBody,
  index: number,
) => readonly ScriptedBlock[] | ScriptedError | ScriptedHang | undefined;

export interface MockAnthropic {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** The usage one reply reports, as the Messages API does. */
export interface ScriptedUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

const defaultUsage: ScriptedUsage = {
  input_tokens: 12,
  output_tokens: 6,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Splits a string into pieces of at most `size` characters; an empty string is one empty piece. */
export function chunks(value: string, size: number): string[] {
  if (value === "") return [""];
  const pieces: string[] = [];
  for (let start = 0; start < value.length; start += size)
    pieces.push(value.slice(start, start + size));
  return pieces;
}

function fullBlock(block: ScriptedBlock) {
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature ?? "sig_mock" };
  }
  return block;
}

function message(
  model: string,
  blocks: readonly ScriptedBlock[],
  id: string,
  usage: ScriptedUsage,
) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: blocks.map(fullBlock),
    stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
  };
}

function writeStream(
  response: ServerResponse,
  model: string,
  blocks: readonly ScriptedBlock[],
  id: string,
  usage: ScriptedUsage,
) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "request-id": `req_${id}`,
  });
  const send = (event: string, data: unknown) =>
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const full = message(model, blocks, id, usage);
  send("message_start", {
    type: "message_start",
    message: { ...full, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } },
  });
  send("ping", { type: "ping" });
  blocks.forEach((block, index) => {
    const delta = (value: unknown) =>
      send("content_block_delta", { type: "content_block_delta", index, delta: value });
    if (block.type === "thinking") {
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      for (const piece of chunks(block.thinking, 12))
        delta({ type: "thinking_delta", thinking: piece });
      delta({ type: "signature_delta", signature: block.signature ?? "sig_mock" });
    } else if (block.type === "text") {
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      for (const piece of chunks(block.text, 8)) delta({ type: "text_delta", text: piece });
    } else {
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      for (const piece of chunks(JSON.stringify(block.input), 16)) {
        delta({ type: "input_json_delta", partial_json: piece });
      }
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: full.stop_reason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  send("message_stop", { type: "message_stop" });
  response.end();
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
) {
  response.writeHead(status, { ...headers, "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function recordedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === "x-api-key" || name === "authorization" || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/**
 * Starts the mock on an ephemeral loopback port. It never contacts any other
 * host: CONNECT tunnels and absolute-form requests for other hosts are
 * recorded and refused, so it can also serve as the SDK's HTTP(S) proxy.
 */
export async function startMockAnthropic(
  credential: string,
  responder: Responder,
  options: {
    /** Per-reply usage; defaults to a small fixed report. */
    readonly usage?: (body: MessagesBody, index: number) => ScriptedUsage;
    /** The token count answered for a count request; defaults to 42. */
    readonly countTokens?: (body: MessagesBody) => number;
  } = {},
): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = [];
  let replies = 0;
  const server = createServer(async (request, response) => {
    const target = request.url ?? "/";
    const apiKey = request.headers["x-api-key"];
    const bearer = request.headers.authorization;
    const usedExpectedCredential = apiKey === credential || bearer === `Bearer ${credential}`;
    const raw = await readBody(request);
    let body: unknown;
    try {
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      body = { unparsed: raw.slice(0, 200) };
    }
    const betas = String(request.headers["anthropic-beta"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const version = request.headers["anthropic-version"];
    requests.push({
      method: request.method ?? "",
      target,
      usedExpectedCredential,
      betas,
      ...(typeof version === "string" ? { version } : {}),
      headers: recordedHeaders(request),
      ...(body === undefined ? {} : { body }),
    });
    const url = new URL(target, `http://${request.headers.host ?? "127.0.0.1"}`);
    const self = server.address() as AddressInfo;
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== String(self.port)) {
      json(response, 403, {
        type: "error",
        error: { type: "permission_error", message: "mock refuses other hosts" },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      json(response, 200, {
        input_tokens: options.countTokens?.((body ?? {}) as MessagesBody) ?? 42,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const messagesBody = (body ?? {}) as MessagesBody;
      const model = typeof messagesBody.model === "string" ? messagesBody.model : "mock-model";
      const usage = options.usage?.(messagesBody, replies) ?? defaultUsage;
      const reply = responder(messagesBody, replies) ?? [{ type: "text", text: "ok" }];
      replies += 1;
      if ("hang" in reply) return;
      if (!Array.isArray(reply)) {
        const { httpStatus, message: text, errorType, headers } = reply as ScriptedError;
        json(
          response,
          httpStatus,
          { type: "error", error: { type: errorType ?? "invalid_request_error", message: text } },
          headers,
        );
        return;
      }
      const blocks = reply as readonly ScriptedBlock[];
      const id = `msg_mock_${replies}`;
      if (messagesBody.stream === true) writeStream(response, model, blocks, id, usage);
      else json(response, 200, message(model, blocks, id, usage));
      return;
    }
    json(response, 404, {
      type: "error",
      error: { type: "not_found_error", message: "not scripted" },
    });
  });
  server.on("connect", (request, socket) => {
    requests.push({
      method: "CONNECT",
      target: request.url ?? "",
      usedExpectedCredential: false,
      betas: [],
      headers: recordedHeaders(request),
    });
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every tool_result block in a request's messages, with its text content joined. */
export function toolResults(body: MessagesBody): { id: string; text: string; isError: boolean }[] {
  const results: { id: string; text: string; isError: boolean }[] = [];
  for (const entry of body.messages ?? []) {
    if (!Array.isArray(entry.content)) continue;
    for (const block of entry.content as Record<string, unknown>[]) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content as Record<string, unknown>[])
                .map((part) => (typeof part.text === "string" ? part.text : ""))
                .join("")
            : "";
      results.push({ id: String(block.tool_use_id), text, isError: block.is_error === true });
    }
  }
  return results;
}
