/**
 * Fidelity check in both directions: Revenue Desk's own integrations
 * (config snapshot, resolve, read-only probes and the API tools' HTTP
 * clients) against the local fakes, configured only through the ordinary
 * §3 variables, with every base URL carrying a path prefix. If a fake and a
 * product client disagree about a contract, this fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadAgentEnv, sandboxEndpointProblems } from "../../../src/config/env.js";
import type { AgentEnv } from "../../../src/contracts/env.js";
import type {
  ApiCallContext,
  IntegrationDefinition,
  IntegrationId,
  ProbeResult,
} from "../../../src/contracts/integration.js";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import { createIntegrations, type Integrations } from "../../../src/integrations/registry.js";
import type { ApiTool } from "../../../src/integrations/shared/api-tool.js";
import type { ApiIntegration } from "../../../src/integrations/shared/definition.js";
import { type Fakes, startFakes } from "../../support/fakes/index.js";

let fakes: Fakes;
let env: AgentEnv;
let integrations: Integrations;
let stateDir: string;

beforeAll(async () => {
  fakes = await startFakes({ prefixes: true });
  stateDir = mkdtempSync(join(tmpdir(), "revenue-desk-fakes-"));
  const loaded = loadAgentEnv({ ...fakes.env(), AGENT_STATE_DIR: stateDir, AGENT_SANDBOX: "1" });
  if (!loaded.ok) throw new Error(`env refused: ${JSON.stringify(loaded.problems)}`);
  env = loaded.env;
  integrations = createIntegrations();
}, 60_000);

afterAll(async () => {
  await fakes?.close();
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
});

let calls = 0;
function context(): ApiCallContext {
  calls += 1;
  return {
    runId: "run-fakes",
    toolUseId: `toolu_fakes_${calls}`,
    idempotencyKey: `idem-fakes-${calls}`,
    signal: undefined,
  };
}

/** A definition's probe result for the fakes' configuration. */
async function probe<I extends IntegrationId>(
  definition: IntegrationDefinition<I>,
): Promise<ProbeResult> {
  const resolution = definition.resolve(env);
  if (resolution.status !== "configured")
    throw new Error(`${definition.id} is ${resolution.status}`);
  return definition.probe(resolution.connection, AbortSignal.timeout(30_000));
}

/** The API tools of one integration, bound to the fakes' configuration. */
function toolsOf<I extends "stripe" | "quickbooks" | "slack">(
  definition: ApiIntegration<I>,
): readonly ApiTool[] {
  const resolution = definition.resolve(env);
  if (resolution.status !== "configured")
    throw new Error(`${definition.id} is ${resolution.status}`);
  return definition.tools(resolution.connection, { currency: "USD" });
}

/** Runs a tool as the SDK does: arguments parsed by its zod shape (defaults applied) first. */
async function run(
  id: "stripe" | "quickbooks" | "slack",
  name: string,
  args: JsonObject,
  ctx = context(),
): Promise<JsonValue> {
  const tools =
    id === "stripe"
      ? toolsOf(integrations.stripe)
      : id === "quickbooks"
        ? toolsOf(integrations.quickbooks)
        : toolsOf(integrations.slack);
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`${id} has no tool ${name}`);
  return tool.run(z.object(tool.input).parse(args), ctx);
}

describe("the product's integrations against the local fakes", () => {
  it("accepts the fakes' variables as a loopback sandbox configuration", () => {
    expect(sandboxEndpointProblems(env)).toEqual([]);
  });

  it("resolves every integration as configured and every probe as connected", async () => {
    const probes = {
      gmail: await probe(integrations.gmail),
      google_calendar: await probe(integrations.google_calendar),
      hubspot: await probe(integrations.hubspot),
      stripe: await probe(integrations.stripe),
      quickbooks: await probe(integrations.quickbooks),
      slack: await probe(integrations.slack),
    };
    for (const [id, result] of Object.entries(probes)) {
      expect(result, id).toMatchObject({ state: "connected" });
    }
  }, 60_000);

  it("Stripe: finds the duplicate and refunds it exactly once per idempotency key", async () => {
    const customers = await run("stripe", "find_customers", { email: "dana@harborpine.test" });
    expect(JSON.stringify(customers)).toContain("cus_KAharborpine");
    const charges = await run("stripe", "list_charges", {
      customer: "cus_KAharborpine",
      limit: 10,
    });
    expect(JSON.stringify(charges)).toContain("ch_KAhp_0922b");

    const refundContext = context();
    const refund = await run(
      "stripe",
      "create_refund",
      { charge: "ch_KAhp_0922b", amount: 49000, reason: "duplicate" },
      refundContext,
    );
    expect(JSON.stringify(refund)).toContain("re_RD0001");
    await run(
      "stripe",
      "create_refund",
      { charge: "ch_KAhp_0922b", amount: 49000, reason: "duplicate" },
      refundContext,
    );
    expect(fakes.stripe.refunds({ charge: "ch_KAhp_0922b" })).toHaveLength(1);
    expect(fakes.stripe.writes()).toEqual([
      {
        method: "POST",
        path: "/v1/refunds",
        idempotencyKey: refundContext.idempotencyKey,
        status: 200,
        replayed: false,
      },
      {
        method: "POST",
        path: "/v1/refunds",
        idempotencyKey: refundContext.idempotencyKey,
        status: 200,
        replayed: true,
      },
    ]);
  });

  it("Stripe: surfaces a 402 decline as a tool error without retrying the write", async () => {
    fakes.stripe.faults.decline("/v1/refunds", { method: "POST" });
    const before = fakes.stripe.http.requestsTo("POST", "/v1/refunds").length;
    await expect(
      run("stripe", "create_refund", { charge: "ch_KAlumen_0923", amount: 100 }),
    ).rejects.toMatchObject({
      provider: "stripe",
      status: 402,
    });
    expect(fakes.stripe.http.requestsTo("POST", "/v1/refunds").length).toBe(before + 1);
  });

  it("QuickBooks: reads every truncated page of overdue invoices", async () => {
    const before = fakes.quickbooks.requests.length;
    const result = await run("quickbooks", "list_invoices", {
      status: "open",
      due_before: "2026-09-28",
      as_of: "2026-09-28",
    });
    const text = JSON.stringify(result);
    for (const number of ["1043", "1048", "1051", "1055"]) expect(text).toContain(number);
    expect(text).not.toContain("1057");
    const queries = fakes.quickbooks.requests
      .slice(before)
      .filter((entry) => entry.path.endsWith("/query"));
    expect(queries.length).toBe(3);
  });

  it("QuickBooks: creates a customer and an invoice, then sends it, each with its requestid", async () => {
    const customer = await run("quickbooks", "create_customer", {
      display_name: "Solstice Energy Cooperative",
      company_name: "Solstice Energy Cooperative",
      email: "marco@solstice.test",
    });
    expect(JSON.stringify(customer)).toContain("Solstice Energy Cooperative");
    const created = fakes.quickbooks.customerByName("Solstice Energy Cooperative");
    const invoice = await run("quickbooks", "create_invoice", {
      customer_id: String(created?.Id),
      lines: [
        {
          description: "Enterprise plan (annual)",
          quantity: 1,
          unit_price_minor: 1_800_000,
          item_id: "3",
        },
      ],
    });
    expect(JSON.stringify(invoice)).toContain("1058");
    const invoiceId = String(fakes.quickbooks.invoiceByNumber("1058")?.Id);
    await run("quickbooks", "send_invoice", { invoice_id: invoiceId });
    expect(fakes.quickbooks.sentInvoices).toMatchObject([
      { docNumber: "1058", to: "marco@solstice.test" },
    ]);
    expect(fakes.quickbooks.writes().map((write) => write.requestId)).toEqual([
      expect.stringMatching(/^idem-fakes-/),
      expect.stringMatching(/^idem-fakes-/),
      expect.stringMatching(/^idem-fakes-/),
    ]);
  });

  it("Slack: posts to an allowed channel and reports ok:false as a tool error", async () => {
    await run("slack", "post_message", {
      channel: "#billing",
      text: "Refunded the duplicate charge for Harbor & Pine.",
    });
    expect(fakes.slack.posts()).toMatchObject([{ channelName: "#billing" }]);
    await expect(
      run("slack", "post_message", { channel: "#general", text: "hello" }),
    ).rejects.toMatchObject({
      provider: "slack",
      code: "not_in_channel",
    });
  });
});
