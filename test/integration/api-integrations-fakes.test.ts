/**
 * The Stripe integration (the one API integration) end to end against its
 * contract-faithful loopback fake (test/support/fakes): configuration is
 * resolved from an AgentEnv exactly as in production, tools are built from
 * the registry, and every call goes over real HTTP to 127.0.0.1. Covers the
 * behaviours the fake enforces: bracket forms, idempotency replay and 429
 * handling.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiCallContext, ClassifierSettings } from "../../src/contracts/integration.js";
import type { JsonObject, JsonValue } from "../../src/contracts/json.js";
import {
  connectionSnapshot,
  createIntegrations,
  type Integrations,
  resolveAll,
} from "../../src/integrations/registry.js";
import type { ApiTool } from "../../src/integrations/shared/api-tool.js";
import { createClock } from "../support/fakes/core/clock.js";
import { FAKE_CREDENTIAL_VALUES, FAKE_CREDENTIALS } from "../support/fakes/credentials.js";
import { type BusinessFixtures, loadBusinessFixtures } from "../support/fakes/fixtures.js";
import { StripeFake } from "../support/fakes/stripe/index.js";
import { at, secret, testEnv } from "../unit/integrations/helpers.js";

let fixtures: BusinessFixtures;
let stripe: StripeFake;
let set: Integrations;
let settings: ClassifierSettings;
const tools = new Map<string, ApiTool>();
let sequence = 0;

function context(idempotencyKey?: string): ApiCallContext {
  sequence += 1;
  return {
    runId: "run_fakes",
    toolUseId: `toolu_${sequence}`,
    idempotencyKey: idempotencyKey ?? `${"0".repeat(56)}${String(sequence).padStart(8, "0")}`,
    signal: AbortSignal.timeout(15_000),
  };
}

function run(sdkName: string, args: JsonObject, call = context()): Promise<JsonValue> {
  const tool = tools.get(sdkName);
  if (tool === undefined) throw new Error(`no tool ${sdkName}`);
  return tool.run(args, call);
}

beforeAll(async () => {
  fixtures = loadBusinessFixtures();
  const clock = createClock(fixtures.company.asOf);
  stripe = await StripeFake.start({
    fixture: fixtures.stripe,
    clock,
    secretKey: FAKE_CREDENTIALS.stripeSecretKey,
    prefix: "/stripe",
  });
  const env = testEnv({
    stripe: {
      secretKey: secret(FAKE_CREDENTIALS.stripeSecretKey),
      apiBaseUrl: stripe.baseUrl,
      apiVersion: fixtures.stripe.account.apiVersion,
    },
  });
  // Instant backoff so retried reads do not slow the suite.
  set = createIntegrations({ http: { sleep: async () => {} } });
  settings = fixtures.company.workspaceSettings;
  const { plans } = connectionSnapshot(set, env);
  const options = { currency: settings.currency };
  for (const plan of plans) {
    if (plan.status !== "available") continue;
    const connection = plan.connection;
    const built = connection.integration === "stripe" ? set.stripe.tools(connection, options) : [];
    for (const tool of built) tools.set(`mcp__${connection.integration}__${tool.name}`, tool);
  }
  expect(Object.values(resolveAll(set, env)).map((resolution) => resolution.status)).toEqual([
    "not_configured",
    "not_configured",
    "not_configured",
    "configured",
    "not_configured",
    "not_configured",
  ]);
});

afterAll(async () => {
  await stripe?.close();
});

describe("Stripe against the fake", () => {
  it("probes, finds the customer and sees the duplicate charge", async () => {
    const connection = resolveAll(
      set,
      testEnv({
        stripe: { secretKey: secret(FAKE_CREDENTIALS.stripeSecretKey), apiBaseUrl: stripe.baseUrl },
      }),
    ).stripe;
    if (connection.status !== "configured") throw new Error("not configured");
    await expect(
      set.stripe.probe(connection.connection, AbortSignal.timeout(5000)),
    ).resolves.toMatchObject({ state: "connected" });

    const found = await run("mcp__stripe__find_customers", {
      email: "dana@harborpine.test",
      limit: 10,
    });
    expect(at(found, "data", 0, "id")).toBe("cus_KAharborpine");

    const charges = await run("mcp__stripe__list_charges", {
      customer: "cus_KAharborpine",
      created_after: "2026-09-22",
      limit: 10,
    });
    const ids = (at(charges, "data") as JsonObject[]).map((charge) => charge.id);
    expect(ids).toEqual(expect.arrayContaining(["ch_KAhp_0922a", "ch_KAhp_0922b"]));
    expect(ids).not.toContain("ch_KAhp_0822");
  });

  it("refunds the duplicate exactly once, even when the call is replayed", async () => {
    const args = { charge: "ch_KAhp_0922b", amount: 49000, reason: "duplicate" } as const;
    expect(set.stripe.classify("create_refund", args, settings)).toMatchObject({
      actionClass: "financial",
      details: {
        consequence: "Refund $490.00 on Stripe charge ch_KAhp_0922b",
        amount: { amountMinor: 49000, currency: "USD" },
      },
    });
    const key = "a1".repeat(32);
    const first = await run("mcp__stripe__create_refund", args, context(key));
    const replay = await run("mcp__stripe__create_refund", args, context(key));
    expect(at(first, "status")).toBe("succeeded");
    expect(at(replay, "id")).toBe(at(first, "id"));
    expect(stripe.refunds({ charge: "ch_KAhp_0922b" })).toHaveLength(1);
    const writes = stripe.writes().filter((write) => write.path === "/v1/refunds");
    expect(writes.map((write) => [write.idempotencyKey, write.replayed])).toEqual([
      [key, false],
      [key, true],
    ]);
  });

  it("retries a rate-limited read but never a rate-limited write", async () => {
    const read = stripe.faults.rateLimit("/v1/refunds", { method: "GET", retryAfterSeconds: 0 });
    await expect(
      run("mcp__stripe__list_refunds", { charge: "ch_KAlumen_0826", limit: 10 }),
    ).resolves.toMatchObject({
      data: [{ id: "re_KAlumen_0924", amount: 4900 }],
    });
    expect(read.hits).toBe(1);

    const write = stripe.faults.rateLimit("/v1/refunds", { method: "POST" });
    await expect(
      run("mcp__stripe__create_refund", { charge: "ch_KAlumen_0923", amount: 100 }),
    ).rejects.toMatchObject({ provider: "stripe", status: 429, code: "rate_limit" });
    expect(write.hits).toBe(1);
    expect(stripe.refunds({ charge: "ch_KAlumen_0923" })).toHaveLength(0);
  });

  it("reports Stripe's own refusals and cancels a subscription", async () => {
    await expect(
      run("mcp__stripe__create_refund", { charge: "ch_KAlumen_0826", amount: 20000 }),
    ).rejects.toMatchObject({ provider: "stripe", status: 400 });
    const cancelled = await run("mcp__stripe__cancel_subscription", {
      subscription: "sub_KAlumenyoga",
      comment: "Studio closing",
    });
    expect(at(cancelled, "status")).toBe("canceled");
    expect(stripe.subscription("sub_KAlumenyoga")).toMatchObject({ status: "canceled" });
  });
});

describe("secrets", () => {
  it("never appear in what the fakes recorded outside the credential headers", () => {
    const recorded = stripe.requests.map((request) => {
      const { authorization: _authorization, ...headers } = request.headers;
      return JSON.stringify({ ...request, headers });
    });
    for (const value of FAKE_CREDENTIAL_VALUES) {
      for (const entry of recorded) expect(entry).not.toContain(value);
    }
  });
});
