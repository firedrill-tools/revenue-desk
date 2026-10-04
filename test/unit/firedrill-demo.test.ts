import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFiredrillDemoCatalog,
  syntheticFetch,
  validateDemoBindings,
  type WorldBinding,
} from "../../src/firedrill-demo/catalog.js";
import { SETTINGS } from "./integrations/helpers.js";

const core: WorldBinding = {
  worldHttpUrl: "https://world.firedrill.run",
  worldWireHttpUrl: "https://world.firedrill.run/v1/wire",
  worldMcpUrl: "https://world.firedrill.run/v1/mcp",
  worldWireAuthorizationHeader: "X-Firedrill-World-Authorization",
  credential: "core-token",
  expiresAtMs: Date.now() + 60_000,
  projectId: "prj_demo",
  environmentId: "env_core",
  sessionId: "ses_core",
};
const stripe: WorldBinding = {
  ...core,
  credential: "stripe-token",
  environmentId: "env_stripe",
  sessionId: "ses_stripe",
};

afterEach(() => vi.unstubAllGlobals());

describe("Revenue Desk's explicit synthetic composition", () => {
  it("refuses an expired binding, another project, and a different destination", () => {
    expect(() => validateDemoBindings({ core, stripe: { ...stripe, expiresAtMs: 0 } })).toThrow();
    expect(() =>
      validateDemoBindings({ core, stripe: { ...stripe, projectId: "prj_other" } }),
    ).toThrow();
    expect(() =>
      validateDemoBindings({ core: { ...core, worldHttpUrl: "https://api.stripe.com" }, stripe }),
    ).toThrow();
  });

  it("routes provider-shaped HTTP only through the actor-scoped world wire", async () => {
    const externalFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", externalFetch);
    await syntheticFetch(stripe)("https://api.stripe.com/v1/balance");
    expect(externalFetch).toHaveBeenCalledOnce();
    const [url, init] = externalFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://world.firedrill.run/v1/wire/v1/balance");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer stripe-token");
    expect(new Headers(init.headers).get("X-Firedrill-World-Authorization")).toBe(
      "Bearer stripe-token",
    );
    await expect(syntheticFetch(stripe)("https://example.com/v1/balance")).rejects.toThrow();
    expect(externalFetch).toHaveBeenCalledOnce();
  });

  it("keeps native invoice creation financial and names its actual amount", () => {
    const catalog = createFiredrillDemoCatalog({ core, stripe });
    const classification = catalog.quickbooks.classify(
      "QUICKBOOKS_CREATE_INVOICE",
      { customer_ref: "58", line_items: [{ item_ref: "1", qty: 2, unit_price: 64.5 }] },
      SETTINGS,
    );
    expect(classification?.actionClass).toBe("financial");
    expect(classification?.details?.amount?.amountMinor).toBe(12900);
  });

  it("refuses Gmail wire forms the existing approval card cannot describe", () => {
    const catalog = createFiredrillDemoCatalog({ core, stripe });
    expect(
      catalog.gmail.classify(
        "GMAIL_CREATE_EMAIL_DRAFT",
        { raw: "Ym9keQ", to: ["customer@example.test"] },
        SETTINGS,
      ),
    ).toBeNull();
    expect(
      catalog.gmail.classify(
        "GMAIL_CREATE_EMAIL_DRAFT",
        { to: ["customer@example.test"], subject: "Review" },
        SETTINGS,
      )?.actionClass,
    ).toBe("internal_write");
  });

  it("retains a created draft's recipients for its later send approval", () => {
    const catalog = createFiredrillDemoCatalog({ core, stripe });
    const memory = catalog.gmail.runMemory?.(SETTINGS);
    expect(memory).toBeDefined();
    memory?.record(
      "GMAIL_CREATE_EMAIL_DRAFT",
      { to: ["customer@example.test"], subject: "Review" },
      { id: "r123", message: { id: "m123" } },
      false,
    );
    const input = { id: "r123" };
    const initial = catalog.gmail.classify("GMAIL_SEND_DRAFT", input, SETTINGS);
    expect(initial).not.toBeNull();
    if (initial === null) throw new Error("Expected a classified send draft action");
    const refined = memory?.refine("GMAIL_SEND_DRAFT", input, initial);
    expect(refined?.actionClass).toBe("outbound");
    expect(refined?.details?.recipients).toContain("customer@example.test");
  });

  it("classifies an external native Calendar invitation as outbound", () => {
    const catalog = createFiredrillDemoCatalog({ core, stripe });
    const classification = catalog.google_calendar.classify(
      "GOOGLECALENDAR_CREATE_EVENT",
      {
        calendarId: "primary",
        startTime: "2026-10-01T10:00:00Z",
        endTime: "2026-10-01T10:30:00Z",
        summary: "Customer call",
        attendees: [{ email: "customer@example.test" }],
      },
      SETTINGS,
    );
    expect(classification?.actionClass).toBe("outbound");
    expect(classification?.details?.recipients).toContain("customer@example.test");
  });
});
