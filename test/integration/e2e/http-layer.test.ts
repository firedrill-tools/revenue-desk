/**
 * Full stack, the HTTP layer (docs/ARCHITECTURE.md §6, §7, §11), over a real
 * loopback port with the real Claude Agent SDK, the scripted model and every
 * fake. One J2 refund run is driven the hard way: the first client
 * disconnects at the approval card; while the approval waits, the guards and
 * limits are exercised; a second client reconnects, receives the replay from
 * the start of the assistant message, approves, and reads the run to its end.
 * Fails, never skips, without the native Claude CLI.
 */
import { request as httpRequest } from "node:http";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import {
  API_PATHS,
  type ChatUIMessage,
  CSRF_HEADER,
  UI_MESSAGE_STREAM_HEADER,
} from "../../../src/contracts/api.js";
import { expectedIdempotencyKey } from "../../scenarios/facts.js";
import { J2_REFUND_DUPLICATE } from "../../scenarios/index.js";
import type { StreamChunk } from "../../support/api-client.js";
import { startHarness } from "../../support/harness.js";
import { requireNativeSdkBinary } from "../../support/sdk-gate-support.js";
import { agentRequests, readRunRows } from "./support.js";

/** A browser tab's session: the cookie and the CSRF token from GET /api/session. */
async function openSession(baseUrl: string) {
  const response = await fetch(`${baseUrl}${API_PATHS.session}`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return {
    headers(extra: Record<string, string> = {}): Record<string, string> {
      return {
        cookie,
        origin: baseUrl,
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
        ...extra,
      };
    },
    post(path: string, body: unknown, extra: Record<string, string> = {}, signal?: AbortSignal) {
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(extra),
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}

type Sse = { readonly chunks: StreamChunk[]; readonly raw: string; readonly aborted: boolean };

/** Reads an SSE body chunk by chunk; `onChunk` may return "disconnect" to drop the connection. */
async function readSse(
  response: Response,
  controller: AbortController | null,
  onChunk: (chunk: StreamChunk) => Promise<"disconnect" | undefined> | "disconnect" | undefined,
): Promise<Sse> {
  const chunks: StreamChunk[] = [];
  let raw = "";
  let buffer = "";
  const decoder = new TextDecoder();
  if (response.body === null) return { chunks, raw, aborted: false };
  try {
    for await (const piece of response.body) {
      const text = decoder.decode(piece as Uint8Array, { stream: true });
      raw += text;
      buffer += text;
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = frame.startsWith("data: ") ? frame.slice(6) : "";
        if (data === "" || data === "[DONE]") continue;
        const chunk = JSON.parse(data) as StreamChunk;
        chunks.push(chunk);
        if ((await onChunk(chunk)) === "disconnect") {
          controller?.abort();
          return { chunks, raw, aborted: true };
        }
      }
    }
  } catch (error) {
    if (controller?.signal.aborted === true) return { chunks, raw, aborted: true };
    throw error;
  }
  return { chunks, raw, aborted: false };
}

/** A request with an arbitrary Host header (fetch does not let a caller choose it). */
function requestWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (piece: string) => {
        body += piece;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function reduce(chunks: readonly StreamChunk[]): Promise<ChatUIMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as unknown as UIMessageChunk);
      controller.close();
    },
  });
  let last: ChatUIMessage | undefined;
  for await (const message of readUIMessageStream<ChatUIMessage>({ stream })) last = message;
  return last;
}

function indexOf(chunks: readonly StreamChunk[], predicate: (chunk: StreamChunk) => boolean) {
  const index = chunks.findIndex(predicate);
  if (index < 0) throw new Error("expected chunk not found");
  return index;
}

describe("full stack: the HTTP layer over a real loopback port", () => {
  it("streams in order, survives a disconnect, replays on reconnect and guards every route", {
    timeout: 120_000,
  }, async () => {
    requireNativeSdkBinary();
    const harness = await startHarness({ server: "in-process", model: J2_REFUND_DUPLICATE });
    try {
      const baseUrl = harness.url ?? "";
      const tab = await openSession(baseUrl);
      const created = await tab.post(API_PATHS.conversations, {});
      expect(created.status).toBe(201);
      const { conversation } = (await created.json()) as { conversation: { id: string } };
      const chatBody = (id: string) => ({
        conversationId: conversation.id,
        message: { id, role: "user", parts: [{ type: "text", text: J2_REFUND_DUPLICATE.prompt }] },
      });

      // 1. The first client streams until the approval card, then disconnects.
      const first = new AbortController();
      const response = await tab.post(API_PATHS.chat, chatBody("msg_first"), {}, first.signal);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get(UI_MESSAGE_STREAM_HEADER)).toBe("v1");
      let approvalId = "";
      const live = await readSse(response, first, (chunk) => {
        if (chunk.type === "tool-approval-request" && chunk.isAutomatic !== true) {
          approvalId = String(chunk.approvalId);
          return "disconnect";
        }
        return undefined;
      });
      expect(live.aborted).toBe(true);
      expect(approvalId).not.toBe("");
      const types = live.chunks.map((chunk) => chunk.type);
      expect(types[0]).toBe("start");
      const metadata = live.chunks[0]?.messageMetadata as { runId?: string } | undefined;
      const runId = metadata?.runId ?? "";
      expect(runId).not.toBe("");
      expect(types.indexOf("start-step")).toBeLessThan(types.indexOf("tool-input-start"));
      const refundAvailable = indexOf(
        live.chunks,
        (chunk) => chunk.type === "tool-input-available" && chunk.toolCallId === "toolu_j2_refund",
      );
      const approvalRequest = types.lastIndexOf("tool-approval-request");
      // A step ends before its calls ask for approval (S1/S2 ordering).
      expect(types.slice(refundAvailable, approvalRequest)).toContain("finish-step");
      expect(
        live.chunks.filter(
          (chunk) =>
            chunk.type === "tool-input-available" && chunk.toolCallId === "toolu_j2_refund",
        ),
      ).toHaveLength(1);
      const requestsAtApproval = agentRequests(harness.model).length;

      // 2. The run outlives the connection and waits for the decision.
      const waiting = await fetch(`${baseUrl}/api/conversations/${conversation.id}`);
      const detail = (await waiting.json()) as {
        conversation: { status: string; activeRunId: string | null };
        pendingApprovals: { id: string }[];
      };
      expect(detail.conversation).toMatchObject({
        status: "awaiting_approval",
        activeRunId: runId,
      });
      expect(detail.pendingApprovals.map((approval) => approval.id)).toEqual([approvalId]);

      // 3. Guards and limits while the approval waits.
      const second = await tab.post(API_PATHS.chat, chatBody("msg_second"));
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: { code: "run_active" } });

      const unknown = await tab.post("/api/approvals/apr_does_not_exist", { approved: true });
      expect(unknown.status).toBe(404);

      const foreign = await tab.post(
        `/api/approvals/${approvalId}`,
        { approved: true },
        { origin: "http://evil.test" },
      );
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({ error: { code: "forbidden_origin" } });

      const noToken = await fetch(`${baseUrl}/api/approvals/${approvalId}`, {
        method: "POST",
        headers: { ...tab.headers(), [CSRF_HEADER]: "" },
        body: JSON.stringify({ approved: true }),
      });
      expect(noToken.status).toBe(403);
      expect(await noToken.json()).toMatchObject({ error: { code: "csrf_failed" } });

      const rebinding = await requestWithHost(`${baseUrl}${API_PATHS.session}`, "evil.test");
      expect(rebinding.status).toBe(403);

      // None of that decided anything, and nothing was refunded.
      expect(readRunRows(harness.stateDir, runId).approval("j2_refund").status).toBe("pending");
      expect(harness.fakes.stripe.http.requestsTo("POST", "/v1/refunds")).toHaveLength(0);
      expect(agentRequests(harness.model)).toHaveLength(requestsAtApproval);

      // 4. A second client reconnects: the replay starts at the assistant message.
      const reconnect = await fetch(`${baseUrl}/api/chat/${conversation.id}/stream`);
      expect(reconnect.status).toBe(200);
      expect(reconnect.headers.get(UI_MESSAGE_STREAM_HEADER)).toBe("v1");
      let decided: Response | null = null;
      const replay = await readSse(reconnect, null, async (chunk) => {
        if (chunk.type === "tool-approval-request" && chunk.approvalId === approvalId) {
          decided = await tab.post(`/api/approvals/${approvalId}`, { approved: true });
        }
        return undefined;
      });
      expect((decided as Response | null)?.status).toBe(200);
      expect(replay.chunks[0]).toMatchObject({
        type: "start",
        messageId: live.chunks[0]?.messageId,
      });
      expect(replay.raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
      const replayTypes = replay.chunks.map((chunk) => chunk.type);
      expect(replayTypes.at(-1)).toBe("finish");
      const response2 = indexOf(
        replay.chunks,
        (chunk) => chunk.type === "tool-approval-response" && chunk.approvalId === approvalId,
      );
      const output = indexOf(
        replay.chunks,
        (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === "toolu_j2_refund",
      );
      expect(response2).toBeLessThan(output);

      // A decided approval cannot be decided again.
      const again = await tab.post(`/api/approvals/${approvalId}`, { approved: false });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: "already_decided" } });

      // 5. The persisted message equals what the reconnected client rendered.
      const final = (await (
        await fetch(`${baseUrl}/api/conversations/${conversation.id}`)
      ).json()) as { conversation: { status: string }; messages: ChatUIMessage[] };
      const rendered = await reduce(replay.chunks);
      expect(final.messages.at(-1)?.parts).toEqual(rendered?.parts);
      expect(final.conversation.status).toBe("idle");

      // 6. The run finished once, the refund happened once, with the run's key.
      const rows = readRunRows(harness.stateDir, runId);
      expect(rows.run.status).toBe("completed");
      expect(rows.call("j2_refund")).toMatchObject({ decision: "approved", status: "succeeded" });
      expect(harness.fakes.stripe.writes().map((write) => write.idempotencyKey)).toEqual([
        expectedIdempotencyKey(runId, "toolu_j2_refund"),
      ]);
      const idle = await fetch(`${baseUrl}/api/chat/${conversation.id}/stream`);
      expect(idle.status).toBe(204);
    } finally {
      await harness.close();
    }
  });
});
