import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Upstream, UpstreamConfig } from "../../src/gateway/mcp-proxy.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../src/gateway/mcp-proxy.js", () => ({ connectUpstream: connect }));

import { connectDemoMcpUpstream } from "../../src/firedrill-demo/mcp-startup.js";

const config: UpstreamConfig = {
  transport: "http",
  url: "https://world.firedrill.run/v1/mcp",
  headers: { Authorization: "Bearer unit-world-token" },
};
const upstream = {
  client: { request: vi.fn() },
  tools: [],
  instructions: undefined,
  stderrTail: () => "",
  close: vi.fn(),
} as unknown as Upstream;
const unavailable = () =>
  new Error("startup failed", { cause: new StreamableHTTPError(503, "service unavailable") });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  connect.mockReset();
  vi.mocked(upstream.close).mockReset().mockResolvedValue();
});
afterEach(() => vi.useRealTimers());

describe("synthetic-only MCP startup retry", () => {
  it("returns the original connected client without wrapping semantic calls", async () => {
    connect.mockResolvedValue(upstream);
    expect(await connectDemoMcpUpstream(config)).toBe(upstream);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[0]).toBe(config);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries typed 503 twice with the same binding and one decreasing deadline", async () => {
    connect.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable());
    connect.mockResolvedValue(upstream);
    const result = connectDemoMcpUpstream(config);
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(upstream);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect.mock.calls.map(([binding]) => binding)).toEqual([config, config, config]);
    expect(connect.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([
      30_000, 29_500, 28_500,
    ]);
    expect(new Set(connect.mock.calls.map(([, options]) => options.signal)).size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a fourth attempt", async () => {
    const error = unavailable();
    connect.mockRejectedValue(error);
    const rejected = expect(connectDemoMcpUpstream(config)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1_500);
    await rejected;
    expect(connect).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 409, 429, 502])("does not retry HTTP %s", async (status) => {
    const error = new Error("startup failed", {
      cause: new StreamableHTTPError(status, "refused"),
    });
    connect.mockRejectedValue(error);
    await expect(connectDemoMcpUpstream(config)).rejects.toBe(error);
    expect(connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not infer retryability from an error message", async () => {
    const error = new Error("HTTP 503 service unavailable retryable: true");
    connect.mockRejectedValue(error);
    await expect(connectDemoMcpUpstream(config)).rejects.toBe(error);
    expect(connect).toHaveBeenCalledOnce();
  });

  it.each([
    "https://provider.example.test/v1/mcp",
    "http://world.firedrill.run/v1/mcp",
    "https://world.firedrill.run:444/v1/mcp",
    "https://world.firedrill.run/v1/mcp?other=1",
    "https://world.firedrill.run/v1/mcp#other",
    "https://world.firedrill.run/other",
    "https://user:secret@world.firedrill.run/v1/mcp",
    "not-a-url",
  ])("preserves a non-synthetic connection unchanged (%s)", async (url) => {
    const binding: UpstreamConfig = { transport: "http", url };
    const options = { timeoutMs: 120_000, signal: new AbortController().signal };
    const error = unavailable();
    connect.mockRejectedValue(error);
    await expect(connectDemoMcpUpstream(binding, options)).rejects.toBe(error);
    expect(connect).toHaveBeenCalledExactlyOnceWith(binding, options);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves stdio connections unchanged", async () => {
    const binding: UpstreamConfig = { transport: "stdio", command: "unit-command" };
    connect.mockRejectedValue(unavailable());
    await expect(connectDemoMcpUpstream(binding)).rejects.toThrow();
    expect(connect).toHaveBeenCalledExactlyOnceWith(binding, {});
  });

  it("honors cancellation during backoff", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    connect.mockRejectedValue(unavailable());
    const rejected = expect(
      connectDemoMcpUpstream(config, { signal: controller.signal }),
    ).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(200);
    controller.abort(reason);
    await rejected;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not connect when already cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    await expect(connectDemoMcpUpstream(config, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards caller cancellation to an in-flight connection without retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled while connecting");
    connect.mockImplementation(
      (_config, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const rejected = expect(
      connectDemoMcpUpstream(config, { signal: controller.signal }),
    ).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps a longer caller timeout at one shared 30 seconds", async () => {
    connect.mockImplementation(
      (_config, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const rejected = expect(
      connectDemoMcpUpstream(config, { timeoutMs: 120_000 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[1].timeoutMs).toBe(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a shorter caller deadline during backoff", async () => {
    connect.mockRejectedValue(unavailable());
    const rejected = expect(
      connectDemoMcpUpstream(config, { timeoutMs: 200 }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a successful connection if the caller cancelled before handoff", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before handoff");
    connect.mockImplementation(async () => {
      controller.abort(reason);
      return upstream;
    });
    await expect(connectDemoMcpUpstream(config, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(upstream.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
