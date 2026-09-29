/**
 * Fidelity check in both directions: Revenue Desk's own integrations
 * (config snapshot, resolve, read-only probes and Stripe's HTTP client)
 * against the local fakes, configured only through the ordinary
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
function toolsOf(definition: ApiIntegration<"stripe">): readonly ApiTool[] {
  const resolution = definition.resolve(env);
  if (resolution.status !== "configured")
    throw new Error(`${definition.id} is ${resolution.status}`);
  return definition.tools(resolution.connection, { currency: "USD" });
}

/** Runs a tool as the SDK does: arguments parsed by its zod shape (defaults applied) first. */
async function run(
  id: "stripe",
  name: string,
  args: JsonObject,
  ctx = context(),
): Promise<JsonValue> {
  const tool = toolsOf(integrations[id]).find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`${id} has no tool ${name}`);
  return tool.run(z.object(tool.input).parse(args), ctx);
}

describe("the product's integrations against the local fakes", () => {
  it("accepts the fakes' variables as a loopback sandbox configuration", () => {
    expect(sandboxEndpointProblems(env)).toEqual([]);
  });

  it("resolves every integration as configured; the fakes' probes say connected", async () => {
    const probes = {
      gmail: await probe(integrations.gmail),
      google_calendar: await probe(integrations.google_calendar),
      hubspot: await probe(integrations.hubspot),
      stripe: await probe(integrations.stripe),
    };
    for (const [id, result] of Object.entries(probes)) {
      expect(result, id).toMatchObject({ state: "connected" });
    }
    // QuickBooks and Slack have no local fake: the Composio fake reports no connected account.
    expect(await probe(integrations.quickbooks)).toMatchObject({ state: "needs_auth" });
    expect(await probe(integrations.slack)).toMatchObject({ state: "needs_auth" });
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
});
