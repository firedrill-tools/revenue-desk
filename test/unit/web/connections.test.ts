import { describe, expect, it } from "vitest";
import {
  connectionDetail,
  STALE_CHECK_MS,
  staleConnections,
} from "../../../web/src/lib/connections.js";

describe("staleConnections", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  it("re-checks configured connections whose check is over 30 minutes old", () => {
    expect(
      staleConnections(
        [
          { integration: "quickbooks", state: "connected", checkedAt: at(45) },
          { integration: "stripe", state: "connected", checkedAt: at(5) },
          { integration: "slack", state: "expired", checkedAt: null },
          { integration: "gmail", state: "not_configured", checkedAt: null },
          { integration: "hubspot", state: "invalid", checkedAt: null },
        ],
        now,
      ),
    ).toEqual(["quickbooks", "slack"]);
    expect(STALE_CHECK_MS).toBe(30 * 60_000);
  });
});

describe("connectionDetail", () => {
  it("keeps the plain sentence apart from the provider's words", () => {
    expect(
      connectionDetail({
        state: "expired",
        detail:
          "QuickBooks Online rejected the access token (it expires hourly). Put a new QBO_ACCESS_TOKEN in your configuration file and restart Revenue Desk.\nQuickBooks said: message=AuthenticationFailed; errorCode=003200; statusCode=401",
      }),
    ).toEqual({
      summary:
        "QuickBooks Online rejected the access token (it expires hourly). Put a new QBO_ACCESS_TOKEN in your configuration file and restart Revenue Desk.",
      provider: "QuickBooks said: message=AuthenticationFailed; errorCode=003200; statusCode=401",
    });
    expect(connectionDetail({ state: "connected", detail: "Connected to Kestrel." })).toEqual({
      summary: "Connected to Kestrel.",
      provider: null,
    });
  });

  it("tells a not-configured row what to do; the Missing column names the variables", () => {
    expect(
      connectionDetail({ state: "not_configured", detail: "Not configured. Set SLACK_BOT_TOKEN." }),
    ).toEqual({
      summary: "Add these to the file DOTENV_PATH names, then restart Revenue Desk.",
      provider: null,
    });
  });
});
