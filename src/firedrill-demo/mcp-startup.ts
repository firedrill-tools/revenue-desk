/** Startup resilience only for the explicit synthetic composition; never retries Tool calls. */
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  connectUpstream,
  type UpstreamConfig,
  type UpstreamConnector,
} from "../gateway/mcp-proxy.js";

const STARTUP_DEADLINE_MS = 30_000;
const BACKOFF_MS = [500, 1_000] as const;

function isSyntheticMcp(config: UpstreamConfig): boolean {
  if (config.transport !== "http") return false;
  try {
    const url = new URL(config.url);
    return (
      url.protocol === "https:" &&
      url.hostname === "world.firedrill.run" &&
      url.port === "" &&
      url.pathname === "/v1/mcp" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isTransientStartup(error: unknown): boolean {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (cause instanceof StreamableHTTPError) return cause.code === 503;
    if (!(cause instanceof Error) || seen.has(cause)) return false;
    seen.add(cause);
    cause = cause.cause;
  }
  return false;
}

function backoff(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Failed connectUpstream attempts close their client before throwing. Only
 * initialize and tools/list have happened here: the returned client and its
 * later tools/call requests are passed through unchanged, without retries.
 */
export const connectDemoMcpUpstream: UpstreamConnector = async (config, options = {}) => {
  if (!isSyntheticMcp(config)) return connectUpstream(config, options);

  const timeoutMs = Math.min(STARTUP_DEADLINE_MS, options.timeoutMs ?? STARTUP_DEADLINE_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("synthetic MCP startup timeout must be positive and finite");
  }
  const scope = new AbortController();
  const abort = () => scope.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const deadline = performance.now() + timeoutMs;
  const deadlineError = () =>
    new DOMException("Synthetic MCP startup deadline exceeded", "TimeoutError");
  const assertCurrent = () => {
    if (performance.now() >= deadline && !scope.signal.aborted) scope.abort(deadlineError());
    scope.signal.throwIfAborted();
  };
  const timer = setTimeout(() => scope.abort(deadlineError()), timeoutMs);
  try {
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
      assertCurrent();
      try {
        const connected = await connectUpstream(config, {
          timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
          signal: scope.signal,
        });
        try {
          assertCurrent();
        } catch (error) {
          await connected.close().catch(() => {});
          throw error;
        }
        return connected;
      } catch (error) {
        assertCurrent();
        const waitMs = BACKOFF_MS[attempt];
        if (waitMs === undefined || !isTransientStartup(error)) throw error;
        await backoff(waitMs, scope.signal);
      }
    }
    throw new Error("Synthetic MCP startup attempts exhausted");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
};
