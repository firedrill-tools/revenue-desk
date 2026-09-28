import { Composio } from "@composio/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Pins the behaviour of the real @composio/core 0.21.0 constructor that the
// session module relies on: disableVersionCheck stops the npm registry request
// (and therefore the "Upgrade available" banner, which the SDK's default
// console logger would print to stdout). No request leaves the process: fetch
// is stubbed.

function stubFetch(latest: string) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://registry.npmjs.org/")) {
      return new Response(JSON.stringify({ version: latest }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function capturingLogger() {
  const lines: string[] = [];
  const sink = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, logger: { error: sink, warn: sink, info: sink, debug: sink } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("@composio/core version check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes no registry request and logs nothing when disabled", async () => {
    const fetchMock = stubFetch("99.0.0");
    const { lines, logger } = capturingLogger();
    new Composio({ apiKey: "ak_test", disableVersionCheck: true, allowTracking: false, logger });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.includes("Upgrade available"))).toEqual([]);
  });

  it("queries the npm registry when enabled (the banner source)", async () => {
    const fetchMock = stubFetch("99.0.0");
    const { lines, logger } = capturingLogger();
    new Composio({ apiKey: "ak_test", allowTracking: false, logger });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://registry.npmjs.org/@composio/core/latest");
    // The SDK suppresses the banner itself when CI or DEVELOPMENT is set.
    if (!process.env.CI && !process.env.DEVELOPMENT) {
      await vi.waitFor(() =>
        expect(lines.some((line) => line.includes("Upgrade available"))).toBe(true),
      );
    }
  });
});
