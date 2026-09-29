// What a check or a failed call says about a connection's credential
// (src/integrations/shared/errors.ts, connectionFromFailure in registry.ts):
// a plain sentence with the next step first, the provider's words after.

import { describe, expect, it } from "vitest";
import type { ToolFailure } from "../../../src/contracts/integration.js";
import { ApiToolError } from "../../../src/gateway/api-server.js";
import { connectionFromFailure } from "../../../src/integrations/registry.js";
import { probeFailure } from "../../../src/integrations/shared/errors.js";

const failure = (provider: string, status: number | null, code: string | null, message: string) =>
  ({ provider, status, code, message }) satisfies ToolFailure;

describe("a failed check", () => {
  it("says what to do first and keeps the provider's words on a second line", () => {
    const rejected = probeFailure(
      "HubSpot",
      new ApiToolError("hubspot", "Authentication credentials not found.", { status: 401 }),
      {
        variable: "HUBSPOT_ACCESS_TOKEN",
        credential: "the private-app token",
      },
    );
    expect(rejected.state).toBe("needs_auth");
    expect(rejected.detail.split("\n")).toEqual([
      "HubSpot rejected the private-app token. Put a new HUBSPOT_ACCESS_TOKEN in your configuration file and restart Revenue Desk.",
      "HubSpot said: Authentication credentials not found.",
    ]);

    const stripe = probeFailure(
      "Stripe",
      new ApiToolError("stripe", "Invalid API Key", { status: 401 }),
      {
        variable: "STRIPE_SECRET_KEY",
        credential: "the API key",
      },
    );
    expect(stripe).toMatchObject({ state: "needs_auth" });
    expect(stripe.detail).toMatch(
      /^Stripe rejected the API key\. Put a new STRIPE_SECRET_KEY in your configuration file and restart Revenue Desk\.\n/,
    );

    const down = probeFailure(
      "Stripe",
      new ApiToolError("stripe", "An unexpected error occurred.", { status: 500 }),
    );
    expect(down.state).toBe("error");
    expect(down.detail.split("\n")[0]).toBe(
      "Stripe did not answer the check (HTTP 500). Try Check again later.",
    );
  });
});

describe("a failed call's credential", () => {
  it("marks Stripe refused only on a 401, never on one call's 403 or a decline", () => {
    expect(
      connectionFromFailure("stripe", failure("stripe", 401, null, "Invalid API Key"))?.state,
    ).toBe("needs_auth");
    // A restricted key without one permission: the other Stripe tools still work.
    expect(
      connectionFromFailure("stripe", failure("stripe", 403, null, "Permission denied")),
    ).toBeNull();
    expect(
      connectionFromFailure("stripe", failure("stripe", 402, "card_declined", "Declined")),
    ).toBeNull();
    expect(connectionFromFailure("stripe", failure("stripe", 500, null, "Oops"))).toBeNull();
  });

  it("leaves Composio's sign-in to its own check, QuickBooks and Slack included", () => {
    expect(connectionFromFailure("gmail", failure("gmail", 401, null, "Unauthorized"))).toBeNull();
    // A Composio tool's failure reaches the gateway as the tool's text, with no HTTP status.
    expect(
      connectionFromFailure("quickbooks", failure("quickbooks", null, null, "Token expired")),
    ).toBeNull();
    expect(
      connectionFromFailure("slack", failure("slack", null, "token_expired", "token_expired")),
    ).toBeNull();
    expect(
      connectionFromFailure("hubspot", failure("hubspot", 401, null, "Bad token"))?.state,
    ).toBe("needs_auth");
  });
});
