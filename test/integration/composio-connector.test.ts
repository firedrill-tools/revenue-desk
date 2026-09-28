/**
 * Gmail and Google Calendar through the real @composio/core client against
 * the local Composio fake (COMPOSIO_BASE_URL on loopback): configuration is
 * resolved from an AgentEnv, the probe reads each toolkit's state, the run's
 * session MCP endpoint (plain http on loopback, allowed only because the base
 * URL is loopback) lists exactly the allowlist for the policy's access level,
 * and Connect returns a sign-in link. No real Composio call is made.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composioAccessFor, DEFAULT_POLICY } from "../../src/contracts/integration.js";
import { connectUpstream } from "../../src/gateway/mcp-proxy.js";
import { allowedTools } from "../../src/integrations/composio/session.js";
import {
  checkConnection,
  createIntegrations,
  type Integrations,
} from "../../src/integrations/registry.js";
import { ComposioFake } from "../support/fakes/composio/index.js";
import { createClock } from "../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../support/fakes/fixtures.js";
import { secret, testEnv } from "../unit/integrations/helpers.js";

let composio: ComposioFake;
let set: Integrations;
let env: ReturnType<typeof testEnv>;

const silent = { error() {}, warn() {}, info() {}, debug() {} };

beforeAll(async () => {
  const fixtures = loadBusinessFixtures();
  composio = await ComposioFake.start({
    composio: fixtures.composio,
    gmail: fixtures.gmail,
    calendar: fixtures.calendar,
    clock: createClock(fixtures.company.asOf),
    apiKey: FAKE_CREDENTIALS.composioApiKey,
  });
  env = testEnv({
    composio: {
      apiKey: secret(FAKE_CREDENTIALS.composioApiKey),
      userId: fixtures.composio.userId,
      baseUrl: composio.baseUrl,
    },
  });
  set = createIntegrations({ composio: { logger: silent } });
});

afterAll(async () => {
  await composio?.close();
});

function gmailConnection() {
  const resolution = set.gmail.resolve(env);
  if (resolution.status !== "configured") throw new Error(`unexpected ${resolution.status}`);
  return resolution.connection;
}

describe("Composio integrations against the Composio fake", () => {
  it("resolve and probe both toolkits through one session", async () => {
    const now = () => new Date("2026-09-28T13:00:00Z");
    const signal = AbortSignal.timeout(15_000);
    await expect(checkConnection(set, "gmail", env, signal, now)).resolves.toMatchObject({
      state: "connected",
      endpointLabel: new URL(composio.baseUrl).host,
      accountHint: "ca_…001",
    });
    await expect(checkConnection(set, "google_calendar", env, signal, now)).resolves.toMatchObject({
      state: "connected",
    });
    expect(composio.sessions.size).toBe(1);
    const [session] = composio.sessions.values();
    expect(session?.toolkits).toEqual(["gmail", "googlecalendar"]);
    expect(session?.enabled).toEqual({
      gmail: allowedTools("gmail", "read"),
      googlecalendar: allowedTools("googlecalendar", "read"),
    });
  });

  it("serves the run's session MCP with exactly the policy's allowlist", async () => {
    const access = composioAccessFor(DEFAULT_POLICY);
    const upstream = await set.gmail
      .connector(gmailConnection())
      .upstream(["gmail", "googlecalendar"], access);
    expect(upstream.config.url.startsWith(`${new URL(composio.baseUrl).origin}/`)).toBe(true);
    expect(upstream.allowlists).toEqual({
      gmail: allowedTools("gmail", "outbound"),
      googlecalendar: allowedTools("googlecalendar", "outbound"),
    });
    const client = await connectUpstream(upstream.config, { timeoutMs: 15_000 });
    try {
      expect(client.tools.map((tool) => tool.name).sort()).toEqual(
        [
          ...allowedTools("gmail", "outbound"),
          ...allowedTools("googlecalendar", "outbound"),
        ].sort(),
      );
    } finally {
      await client.close();
    }

    const readOnly = await set.gmail
      .connector(gmailConnection())
      .upstream(
        ["gmail"],
        composioAccessFor({ ...DEFAULT_POLICY, outbound: "deny", internal_write: "deny" }),
      );
    const reader = await connectUpstream(readOnly.config, { timeoutMs: 15_000 });
    try {
      expect(reader.tools.map((tool) => tool.name).sort()).toEqual(
        [...allowedTools("gmail", "read")].sort(),
      );
    } finally {
      await reader.close();
    }
  });

  it("reports needs_auth and expired from Composio's connection state", async () => {
    const fresh = createIntegrations({ composio: { logger: silent } });
    composio.setConnection("googlecalendar", "EXPIRED");
    composio.setConnection("gmail", null);
    try {
      await expect(
        checkConnection(fresh, "google_calendar", env, AbortSignal.timeout(15_000)),
      ).resolves.toMatchObject({ state: "expired" });
      await expect(
        checkConnection(fresh, "gmail", env, AbortSignal.timeout(15_000)),
      ).resolves.toMatchObject({ state: "needs_auth" });
    } finally {
      composio.setConnection("googlecalendar", "ACTIVE");
      composio.setConnection("gmail", "ACTIVE");
    }
  });

  it("returns a sign-in link only when asked, with the server's callback", async () => {
    const before = composio.links.length;
    const callback = "http://127.0.0.1:4320/api/connections/google_calendar/callback";
    const calendar = set.google_calendar.resolve(env);
    if (calendar.status !== "configured") throw new Error(`unexpected ${calendar.status}`);
    const link = await set.google_calendar
      .connector(calendar.connection)
      .authorize("googlecalendar", callback);
    expect(link.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(composio.links.slice(before).map((entry) => [entry.toolkit, entry.callbackUrl])).toEqual(
      [["googlecalendar", callback]],
    );
  });

  it("reports a refused project as an error without the key", async () => {
    const fresh = createIntegrations({ composio: { logger: silent } });
    composio.failSessions({ status: 401, slug: "Auth_InvalidApiKey", message: "Invalid API key." });
    try {
      const status = await checkConnection(fresh, "gmail", env, AbortSignal.timeout(15_000));
      expect(status.state).toBe("error");
      expect(JSON.stringify(status)).not.toContain(FAKE_CREDENTIALS.composioApiKey);
    } finally {
      composio.failSessions(null);
    }
  });
});
