import { describe, expect, it } from "vitest";
import {
  isPreSendNetworkError,
  parseRetryAfter,
  sendHttp,
  TransportError,
} from "../../../src/integrations/shared/http.js";
import { networkError, stubFetch } from "./helpers.js";

const read = {
  method: "GET",
  url: "https://api.test/x",
  headers: {},
  retryable: true,
  signal: undefined,
} as const;
const write = { ...read, method: "POST", retryable: false } as const;

describe("sendHttp retry rules", () => {
  it("retries a read on 429, honouring Retry-After, at most twice", async () => {
    const mock = stubFetch(() => ({
      status: 429,
      json: { error: "slow" },
      headers: { "retry-after": "2" },
    }));
    const response = await sendHttp(read, mock.http);
    expect(response.status).toBe(429);
    expect(mock.requests).toHaveLength(3);
    expect(mock.sleeps).toEqual([2000, 2000]);
  });

  it("returns the first success after a 429", async () => {
    const mock = stubFetch((_, index) => (index === 0 ? { status: 429 } : { json: { ok: true } }));
    const response = await sendHttp(read, mock.http);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    expect(mock.sleeps).toEqual([500]);
  });

  it("does not wait for a Retry-After beyond the limit", async () => {
    const mock = stubFetch(() => ({ status: 429, headers: { "retry-after": "120" } }));
    const response = await sendHttp(read, { ...mock.http, maxRetryDelayMs: 10_000 });
    expect(response.status).toBe(429);
    expect(mock.requests).toHaveLength(1);
  });

  it("never retries a write, even on 429", async () => {
    const mock = stubFetch(() => ({ status: 429 }));
    const response = await sendHttp(write, mock.http);
    expect(response.status).toBe(429);
    expect(mock.requests).toHaveLength(1);
    expect(mock.sleeps).toEqual([]);
  });

  it("does not retry other errors", async () => {
    for (const status of [400, 402, 500, 503]) {
      const mock = stubFetch(() => ({ status }));
      expect((await sendHttp(read, mock.http)).status).toBe(status);
      expect(mock.requests).toHaveLength(1);
    }
  });

  it("retries a read after a network error raised before sending", async () => {
    const mock = stubFetch((_, index) => (index < 2 ? networkError("ECONNREFUSED") : { json: {} }));
    const response = await sendHttp(read, mock.http);
    expect(response.status).toBe(200);
    expect(mock.requests).toHaveLength(3);
    expect(mock.sleeps).toEqual([500, 1000]);
  });

  it("gives up after two retries with a TransportError", async () => {
    const mock = stubFetch(() => networkError("ENOTFOUND"));
    const error = await sendHttp(read, mock.http).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("network");
    expect((error as TransportError).message).toContain("ENOTFOUND");
    expect(mock.requests).toHaveLength(3);
  });

  it("does not retry a network error that may have happened after sending", async () => {
    const mock = stubFetch(() => networkError("ECONNRESET"));
    await expect(sendHttp(read, mock.http)).rejects.toBeInstanceOf(TransportError);
    expect(mock.requests).toHaveLength(1);
  });

  it("does not retry a write after a pre-send network error", async () => {
    const mock = stubFetch(() => networkError("ECONNREFUSED"));
    await expect(sendHttp(write, mock.http)).rejects.toBeInstanceOf(TransportError);
    expect(mock.requests).toHaveLength(1);
  });

  it("reports a cancelled request as aborted", async () => {
    const controller = new AbortController();
    const mock = stubFetch(() => {
      controller.abort();
      return new DOMException("aborted", "AbortError");
    });
    const error = await sendHttp({ ...read, signal: controller.signal }, mock.http).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: "aborted" });
    expect(mock.requests).toHaveLength(1);
  });

  it("times out an attempt that gets no response", async () => {
    const error = await sendHttp(read, {
      timeoutMs: 20,
      fetch: (_, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("t", "AbortError")));
        }),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "timeout" });
  });

  it("marks a write sent without an answer as outcome unknown, never a read or a refused write", async () => {
    // After the connection: the provider may have received and applied it.
    for (const failure of [networkError("ECONNRESET"), networkError("UND_ERR_SOCKET")]) {
      const error = (await sendHttp(write, stubFetch(() => failure).http).catch(
        (e: unknown) => e,
      )) as TransportError;
      expect(error.outcomeUnknown).toBe(true);
    }
    const timedOut = (await sendHttp(write, {
      timeoutMs: 20,
      fetch: (_, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("t", "AbortError")));
        }),
    }).catch((e: unknown) => e)) as TransportError;
    expect(timedOut).toMatchObject({ kind: "timeout", outcomeUnknown: true });
    // Refused before sending: nothing reached the provider.
    const refused = (await sendHttp(
      write,
      stubFetch(() => networkError("ECONNREFUSED")).http,
    ).catch((e: unknown) => e)) as TransportError;
    expect(refused.outcomeUnknown).toBe(false);
    const cancelled = new AbortController();
    cancelled.abort();
    const early = (await sendHttp(
      { ...write, signal: cancelled.signal },
      stubFetch(() => new DOMException("aborted", "AbortError")).http,
    ).catch((e: unknown) => e)) as TransportError;
    expect(early.outcomeUnknown).toBe(false);
    // A read is simply failed.
    const readError = (await sendHttp(read, stubFetch(() => networkError("ECONNRESET")).http).catch(
      (e: unknown) => e,
    )) as TransportError;
    expect(readError.outcomeUnknown).toBe(false);
  });

  it("parses JSON bodies and keeps non-JSON text", async () => {
    const mock = stubFetch(() => ({ status: 502, text: "<html>bad gateway</html>" }));
    const response = await sendHttp(read, mock.http);
    expect(response.json).toBeUndefined();
    expect(response.text).toContain("bad gateway");
  });
});

describe("helpers", () => {
  it("classifies connect-phase errors only", () => {
    expect(isPreSendNetworkError(networkError("ECONNREFUSED").cause)).toBe(true);
    expect(isPreSendNetworkError(networkError("EAI_AGAIN"))).toBe(true);
    expect(isPreSendNetworkError(networkError("UND_ERR_CONNECT_TIMEOUT"))).toBe(true);
    expect(isPreSendNetworkError(networkError("ECONNRESET"))).toBe(false);
    expect(isPreSendNetworkError(networkError("UND_ERR_SOCKET"))).toBe(false);
    expect(isPreSendNetworkError(new Error("x"))).toBe(false);
    const aggregate = new TypeError("fetch failed", {
      cause: Object.assign(
        new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })]),
        {},
      ),
    });
    expect(isPreSendNetworkError(aggregate)).toBe(true);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("1.5")).toBe(1500);
    const now = Date.parse("2026-09-28T12:00:00Z");
    expect(parseRetryAfter("Mon, 28 Sep 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Mon, 28 Sep 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
  });
});
