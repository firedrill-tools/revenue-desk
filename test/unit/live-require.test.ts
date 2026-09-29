// LIVE_REQUIRE (test/live/require.ts): which integrations the live suites
// must exercise. A listed one that cannot be tested fails; any other skips.

import { describe, expect, it } from "vitest";
import { INTEGRATION_IDS } from "../../src/contracts/integration.js";
import { parseLiveRequire, requiredFailure } from "../live/require.js";

describe("parseLiveRequire", () => {
  it("requires nothing when unset or blank, so a partial setup still runs", () => {
    expect([...parseLiveRequire(undefined)]).toEqual([]);
    expect([...parseLiveRequire("")]).toEqual([]);
    expect([...parseLiveRequire(" , ")]).toEqual([]);
  });

  it("reads a comma-separated list of integration ids, in any case and spacing", () => {
    expect([...parseLiveRequire("gmail, Stripe,hubspot ")]).toEqual(["gmail", "stripe", "hubspot"]);
  });

  it("reads all as every integration", () => {
    expect([...parseLiveRequire("all")].sort()).toEqual([...INTEGRATION_IDS].sort());
    expect([...parseLiveRequire("gmail,ALL")].sort()).toEqual([...INTEGRATION_IDS].sort());
  });

  it("refuses an id that is not an integration, so a typo cannot require nothing", () => {
    expect(() => parseLiveRequire("gmail,quickbook")).toThrow(
      /LIVE_REQUIRE names "quickbook", which is not an integration/,
    );
    expect(() => parseLiveRequire("google-calendar")).toThrow(/google_calendar/);
  });
});

describe("requiredFailure", () => {
  const reason = "Slack needs sign-in (needs_auth): click Connect in Connections to sign in.";

  it("fails a required integration with the reason", () => {
    const failure = requiredFailure("slack", reason, parseLiveRequire("slack"));
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe(
      `Slack is required by LIVE_REQUIRE but cannot be tested: ${reason}`,
    );
    expect(requiredFailure("slack", reason, parseLiveRequire("all"))).toBeInstanceOf(Error);
  });

  it("lets any other integration skip", () => {
    expect(requiredFailure("slack", reason, parseLiveRequire("gmail,stripe"))).toBeNull();
    expect(requiredFailure("slack", reason, parseLiveRequire(undefined))).toBeNull();
  });
});
