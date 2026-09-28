import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed: unknown[] = [];
const create = vi.fn(async () => ({ sessionId: "s0" }));

vi.mock("@composio/core", () => ({
  Composio: vi.fn(function Composio(this: unknown, config: unknown) {
    constructed.push(config);
    return { sessions: { create } };
  }),
}));

const { buildSessionConfig, createComposioClient, stderrComposioLogger, ComposioSessionManager } =
  await import("../../src/integrations/composio/session.js");

describe("createComposioClient", () => {
  beforeEach(() => {
    constructed.length = 0;
    create.mockClear();
  });

  it("disables the npm version check and analytics and logs to stderr", () => {
    createComposioClient({ apiKey: "ak_test" });
    expect(constructed).toEqual([
      {
        apiKey: "ak_test",
        disableVersionCheck: true,
        allowTracking: false,
        logger: stderrComposioLogger,
      },
    ]);
  });

  it("passes an explicit base URL and logger through", () => {
    const logger = { error() {}, warn() {}, info() {}, debug() {} };
    createComposioClient({ apiKey: "ak_test", baseURL: "https://composio.test", logger });
    expect(constructed[0]).toMatchObject({ baseURL: "https://composio.test", logger });
  });

  it("refuses to start without an API key", () => {
    expect(() => createComposioClient({ apiKey: "" })).toThrow(/COMPOSIO_API_KEY/);
    expect(constructed).toHaveLength(0);
  });

  it("creates sessions through composio.sessions.create with the built config", async () => {
    const sessions = new ComposioSessionManager({ apiKey: "ak_test", userId: "user-1" });
    await sessions.getSession({ access: "read" });
    expect(create).toHaveBeenCalledWith("user-1", buildSessionConfig({ access: "read" }));
  });
});
