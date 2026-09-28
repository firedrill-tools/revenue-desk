// The chat client (web/src/lib/chat.ts): the transport sends only the new
// user message with the CSRF token, reconnects to the contract's stream URL,
// and approvals and Stop go to their own endpoints.

import { describe, expect, it } from "vitest";
import {
  API_PATHS,
  type ChatUIMessage,
  CSRF_HEADER,
  UI_MESSAGE_STREAM_HEADER,
} from "../../../src/contracts/api.js";
import { ApiError, createApiClient } from "../../../web/src/lib/api.js";
import {
  ApprovalDecisionError,
  chatErrorMessage,
  chatRequestBody,
  createChatTransport,
  decideApproval,
  stopRun,
} from "../../../web/src/lib/chat.js";

type Call = { url: string; method: string; headers: Headers; body: string | null };

function sse(chunks: readonly object[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream", [UI_MESSAGE_STREAM_HEADER]: "v1" },
  });
}

function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    if (call.url.endsWith(API_PATHS.session)) {
      return Response.json({
        csrfToken: "csrf-1",
        version: "t",
        mode: "normal",
        model: "m",
        effort: "medium",
        businessDate: "2026-09-28",
        approvalTimeoutMs: 1,
      });
    }
    return respond(call);
  };
  return { fetch, calls };
}

const USER: ChatUIMessage = {
  id: "msg_2",
  role: "user",
  parts: [{ type: "text", text: "Refund it." }],
};
const EARLIER: ChatUIMessage = { id: "msg_1", role: "user", parts: [{ type: "text", text: "Hi" }] };

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

describe("createChatTransport", () => {
  it("posts only the conversation id and the last message, with the CSRF token", async () => {
    const server = recorder(() => sse([{ type: "start", messageId: "a1" }, { type: "finish" }]));
    const client = createApiClient({ fetch: server.fetch });
    const transport = createChatTransport<ChatUIMessage>({ fetch: client.fetchWithCsrf });
    const stream = await transport.sendMessages({
      chatId: "conv_1",
      messages: [EARLIER, USER],
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
    });
    expect(await drain(stream)).toEqual([{ type: "start", messageId: "a1" }, { type: "finish" }]);

    const post = server.calls.find((call) => call.method === "POST");
    expect(post?.url).toBe(API_PATHS.chat);
    expect(post?.headers.get(CSRF_HEADER)).toBe("csrf-1");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ conversationId: "conv_1", message: USER });
  });

  it("reconnects at /api/chat/:conversationId/stream and treats 204 as no active run", async () => {
    const server = recorder(() => new Response(null, { status: 204 }));
    const transport = createChatTransport<ChatUIMessage>({ fetch: server.fetch });
    const stream = await transport.reconnectToStream({ chatId: "conv_1" });
    expect(stream).toBeNull();
    expect(server.calls.at(-1)?.url).toBe(
      API_PATHS.chatStream.replace(":conversationId", "conv_1"),
    );
    expect(server.calls.at(-1)?.method).toBe("GET");
  });

  it("builds the body from the latest message", () => {
    expect(chatRequestBody("c", [EARLIER, USER])).toEqual({ conversationId: "c", message: USER });
  });
});

describe("decideApproval", () => {
  it("posts the decision with a trimmed reason of at most 500 characters", async () => {
    const server = recorder(() => Response.json({ status: "accepted", approvalId: "apr_1" }));
    const client = createApiClient({ fetch: server.fetch });
    await decideApproval("apr_1", { approved: false, reason: `  ${"x".repeat(600)}  ` }, client);
    const post = server.calls.at(-1);
    expect(post?.url).toBe("/api/approvals/apr_1");
    expect(post?.headers.get(CSRF_HEADER)).toBe("csrf-1");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ approved: false, reason: "x".repeat(500) });
  });

  it("omits an empty reason", async () => {
    const server = recorder(() => Response.json({ status: "accepted", approvalId: "apr_1" }));
    await decideApproval(
      "apr_1",
      { approved: true, reason: "   " },
      createApiClient({ fetch: server.fetch }),
    );
    expect(JSON.parse(server.calls.at(-1)?.body ?? "{}")).toEqual({ approved: true });
  });

  it.each([
    [404, "not_found", "This approval is no longer pending."],
    [409, "already_decided", "This approval was already decided."],
    [500, "internal", "The decision could not be sent. Try again."],
  ])("explains a %i", async (status, code, message) => {
    const server = recorder(() =>
      Response.json({ error: { code, message: "server text" } }, { status }),
    );
    const promise = decideApproval(
      "apr_1",
      { approved: true },
      createApiClient({ fetch: server.fetch }),
    );
    await expect(promise).rejects.toBeInstanceOf(ApprovalDecisionError);
    await expect(promise).rejects.toMatchObject({ message, code });
  });
});

describe("stopRun", () => {
  it("returns stopping on 202 and not_running when the run already ended", async () => {
    const running = recorder(() =>
      Response.json({ runId: "r", status: "stopping" }, { status: 202 }),
    );
    await expect(stopRun("r", createApiClient({ fetch: running.fetch }))).resolves.toBe("stopping");
    expect(running.calls.at(-1)?.url).toBe("/api/runs/r/stop");

    const ended = recorder(() =>
      Response.json(
        { error: { code: "run_not_active", message: "Not running." } },
        { status: 409 },
      ),
    );
    await expect(stopRun("r", createApiClient({ fetch: ended.fetch }))).resolves.toBe(
      "not_running",
    );
  });

  it("rethrows other failures", async () => {
    const broken = recorder(() =>
      Response.json({ error: { code: "internal", message: "Boom." } }, { status: 500 }),
    );
    await expect(stopRun("r", createApiClient({ fetch: broken.fetch }))).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("chatErrorMessage", () => {
  it("explains the chat route's errors", () => {
    const error = (
      code: "run_active" | "too_many_runs" | "not_found" | "csrf_failed" | "internal",
    ) => new ApiError("Server said so.", { status: 409, code });
    expect(chatErrorMessage(error("run_active"))).toMatch(/already has a run/);
    expect(chatErrorMessage(error("too_many_runs"))).toMatch(/Four runs/);
    expect(chatErrorMessage(error("not_found"))).toMatch(/no longer exists/);
    expect(chatErrorMessage(error("csrf_failed"))).toMatch(/Reload the page/);
    expect(chatErrorMessage(error("internal"))).toBe("Server said so.");
    expect(chatErrorMessage(null)).toMatch(/interrupted/);
  });
});
