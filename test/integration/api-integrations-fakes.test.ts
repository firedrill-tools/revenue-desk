/**
 * The Stripe, QuickBooks and Slack integrations end to end against the
 * contract-faithful loopback fakes (test/support/fakes): configuration is
 * resolved from an AgentEnv exactly as in production, tools are built from the
 * registry, and every call goes over real HTTP to 127.0.0.1. Covers the
 * behaviours the fakes enforce: bracket forms, idempotency replay, requestid,
 * size-truncated query pages, Fault envelopes, ok:false and 429 handling.
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
import { QuickBooksFake } from "../support/fakes/quickbooks/index.js";
import { SlackFake } from "../support/fakes/slack.js";
import { StripeFake } from "../support/fakes/stripe/index.js";
import { at, secret, testEnv } from "../unit/integrations/helpers.js";

let fixtures: BusinessFixtures;
let stripe: StripeFake;
let quickbooks: QuickBooksFake;
let slack: SlackFake;
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
  quickbooks = await QuickBooksFake.start({
    fixture: fixtures.quickbooks,
    clock,
    accessToken: FAKE_CREDENTIALS.quickbooksAccessToken,
    prefix: "/qbo",
  });
  slack = await SlackFake.start({
    fixture: fixtures.slack,
    clock,
    botToken: FAKE_CREDENTIALS.slackBotToken,
    prefix: "/slack",
  });
  const env = testEnv({
    stripe: {
      secretKey: secret(FAKE_CREDENTIALS.stripeSecretKey),
      apiBaseUrl: stripe.baseUrl,
      apiVersion: fixtures.stripe.account.apiVersion,
    },
    quickbooks: {
      accessToken: secret(FAKE_CREDENTIALS.quickbooksAccessToken),
      realmId: fixtures.quickbooks.realmId,
      apiBaseUrl: quickbooks.baseUrl,
      minorVersion: "75",
    },
    slack: { botToken: secret(FAKE_CREDENTIALS.slackBotToken), apiBaseUrl: slack.baseUrl },
  });
  // Instant backoff so retried reads do not slow the suite.
  set = createIntegrations({ http: { sleep: async () => {} } });
  settings = fixtures.company.workspaceSettings;
  const { plans } = connectionSnapshot(set, env);
  const options = { currency: settings.currency };
  for (const plan of plans) {
    if (plan.status !== "available") continue;
    const connection = plan.connection;
    const built =
      connection.integration === "stripe"
        ? set.stripe.tools(connection, options)
        : connection.integration === "quickbooks"
          ? set.quickbooks.tools(connection, options)
          : connection.integration === "slack"
            ? set.slack.tools(connection, options)
            : [];
    for (const tool of built) tools.set(`mcp__${connection.integration}__${tool.name}`, tool);
  }
  expect(Object.values(resolveAll(set, env)).map((resolution) => resolution.status)).toEqual([
    "not_configured",
    "not_configured",
    "not_configured",
    "configured",
    "configured",
    "configured",
  ]);
});

afterAll(async () => {
  await Promise.all([stripe?.close(), quickbooks?.close(), slack?.close()]);
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

describe("QuickBooks against the fake", () => {
  it("probes the company and reads every page of a truncated query", async () => {
    const resolution = resolveAll(
      set,
      testEnv({
        quickbooks: {
          accessToken: secret(FAKE_CREDENTIALS.quickbooksAccessToken),
          realmId: fixtures.quickbooks.realmId,
          apiBaseUrl: quickbooks.baseUrl,
        },
      }),
    ).quickbooks;
    if (resolution.status !== "configured") throw new Error("not configured");
    await expect(
      set.quickbooks.probe(resolution.connection, AbortSignal.timeout(5000)),
    ).resolves.toMatchObject({
      state: "connected",
      detail: "Connected to Kestrel Analytics, Inc.",
    });

    const before = quickbooks.requests.filter((request) => request.path.endsWith("/query")).length;
    const result = await run("mcp__quickbooks__list_invoices", {
      status: "all",
      as_of: "2026-09-28",
      limit: 200,
    });
    const invoices = at(result, "invoices") as JsonObject[];
    const queries =
      quickbooks.requests.filter((request) => request.path.endsWith("/query")).length - before;
    expect(at(result, "complete")).toBe(true);
    expect(invoices.map((invoice) => invoice.id).sort()).toEqual(
      fixtures.quickbooks.invoices.map((invoice) => invoice.Id).sort(),
    );
    // Pages hold at most queryPageCap rows, then one empty page ends the query.
    expect(queries).toBe(Math.ceil(invoices.length / fixtures.quickbooks.queryPageCap) + 1);
    const overdue = invoices.find((invoice) => invoice.id === "143");
    expect(overdue).toMatchObject({
      due_date: "2026-07-20",
      total_minor: 360_000,
      currency: "USD",
      days_overdue: 70,
    });
  });

  it("finds customers and payments in minor units", async () => {
    const customers = await run("mcp__quickbooks__find_customers", { name: "Harbor", limit: 20 });
    expect(at(customers, "customers", 0)).toMatchObject({
      id: "58",
      display_name: "Harbor & Pine Outfitters",
      email: "dana@harborpine.test",
    });
    const payments = await run("mcp__quickbooks__list_payments", { customer_id: "58", limit: 100 });
    expect(at(payments, "payments", 0)).toMatchObject({
      id: "214",
      total_minor: 49000,
      reference: "ch_KAhp_0922a",
      applied_to: [{ invoice_id: "149", amount_minor: 49000 }],
    });
  });

  it("creates an invoice once per requestid", async () => {
    const before = quickbooks.invoicesFor("58").length;
    const args: JsonObject = {
      customer_id: "58",
      lines: [
        {
          description: "Growth plan (monthly)",
          quantity: 1,
          unit_price_minor: 49000,
          item_id: "2",
        },
      ],
      due_date: "2026-10-28",
    };
    expect(set.quickbooks.classify("create_invoice", args, settings)).toMatchObject({
      actionClass: "financial",
      details: { amount: { amountMinor: 49000, currency: "USD" } },
    });
    const key = "b2".repeat(32);
    const created = await run("mcp__quickbooks__create_invoice", args, context(key));
    const replayed = await run("mcp__quickbooks__create_invoice", args, context(key));
    expect(at(created, "total_minor")).toBe(49000);
    expect(at(replayed, "id")).toBe(at(created, "id"));
    expect(quickbooks.invoicesFor("58")).toHaveLength(before + 1);
    expect(
      quickbooks
        .writes()
        .filter((write) => write.requestId === key)
        .map((write) => write.replayed),
    ).toEqual([false, true]);
  });

  it("surfaces the Fault envelope for a stale sync token", async () => {
    await expect(
      run("mcp__quickbooks__void_invoice", { invoice_id: "157", sync_token: "99" }),
    ).rejects.toMatchObject({
      provider: "quickbooks",
      status: 400,
      code: "5010",
    });
  });
});

describe("Slack against the fake", () => {
  it("probes, reads a channel and posts to an allowed channel", async () => {
    const resolution = resolveAll(
      set,
      testEnv({
        slack: { botToken: secret(FAKE_CREDENTIALS.slackBotToken), apiBaseUrl: slack.baseUrl },
      }),
    ).slack;
    if (resolution.status !== "configured") throw new Error("not configured");
    await expect(
      set.slack.probe(resolution.connection, AbortSignal.timeout(5000)),
    ).resolves.toMatchObject({
      state: "connected",
      detail: "Connected to Kestrel Analytics as revenue-desk.",
    });

    const history = await run("mcp__slack__read_channel", { channel: "C0BILLING01", limit: 30 });
    expect(JSON.stringify(at(history, "messages"))).toContain("charged twice");

    const post = {
      channel: "#billing",
      text: "Refunded the duplicate Harbor & Pine charge ch_KAhp_0922b ($490.00).",
    };
    expect(set.slack.classify("post_message", post, settings)?.actionClass).toBe("internal_write");
    expect(
      set.slack.classify("post_message", { ...post, channel: "#general" }, settings)?.actionClass,
    ).toBe("outbound");
    const posted = await run("mcp__slack__post_message", post);
    expect(at(posted, "channel")).toBe("C0BILLING01");
    expect(slack.posts().map((entry) => [entry.channelName, entry.text])).toEqual([
      ["#billing", post.text],
    ]);
  });

  it("reports ok:false errors and does not repeat a failed post", async () => {
    slack.faults.error("chat.postMessage", "not_in_channel");
    await expect(
      run("mcp__slack__post_message", { channel: "#billing", text: "again" }),
    ).rejects.toMatchObject({
      provider: "slack",
      code: "not_in_channel",
    });
    expect(slack.posts()).toHaveLength(1);
  });
});

describe("secrets", () => {
  it("never appear in what the fakes recorded outside the credential headers", () => {
    const recorded = [...stripe.requests, ...quickbooks.requests, ...slack.requests].map(
      (request) => {
        const { authorization: _authorization, ...headers } = request.headers;
        return JSON.stringify({ ...request, headers });
      },
    );
    for (const value of FAKE_CREDENTIAL_VALUES) {
      for (const entry of recorded) expect(entry).not.toContain(value);
    }
  });
});
