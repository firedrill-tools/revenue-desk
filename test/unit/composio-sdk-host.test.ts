import { Composio } from "@composio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionConfig,
  createComposioClient,
} from "../../src/integrations/composio/session.js";

// Pins where the real @composio/core 0.21.0 sends requests. The SDK takes its
// base URL from its options, else COMPOSIO_BASE_URL in the environment, else
// the Composio CLI's user config file. Revenue Desk always passes Composio's
// own host, so neither of the others can redirect it. No request leaves the
// process: fetch is stubbed and records the URL, then refuses.

function recordingFetch() {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ error: { message: "refused by the test" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return urls;
}

describe("@composio/core base URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("follows COMPOSIO_BASE_URL when the caller passes no base URL (the risk)", async () => {
    vi.stubEnv("COMPOSIO_BASE_URL", "https://composio.example");
    const urls = recordingFetch();
    const composio = new Composio({
      apiKey: "ak_test",
      disableVersionCheck: true,
      allowTracking: false,
      logger: { error() {}, warn() {}, info() {}, debug() {} },
    });
    await expect(composio.sessions.create("user-1", buildSessionConfig())).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => new URL(url).origin === "https://composio.example")).toBe(true);
  });

  it("always reaches backend.composio.dev through Revenue Desk's client", async () => {
    vi.stubEnv("COMPOSIO_BASE_URL", "https://composio.example");
    const urls = recordingFetch();
    const client = createComposioClient({
      apiKey: "ak_test",
      logger: { error() {}, warn() {}, info() {}, debug() {} },
    });
    await expect(client.createSession("user-1", buildSessionConfig())).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => new URL(url).origin === "https://backend.composio.dev")).toBe(true);
  });
});
