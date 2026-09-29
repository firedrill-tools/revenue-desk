// The integrations workstream's registry is the gateway's catalog as it
// stands: its Integrations type fits IntegrationCatalog (checked by pnpm
// typecheck), every profile tool of its API integration (Stripe) can be
// offered and validated by the gateway, and every tool of its Composio
// profiles exists in the captured Composio surface with a schema the gateway
// can validate.
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { COMPOSIO_TOOLKIT_OF } from "../../../src/contracts/integration.js";
import { apiGatewayTool } from "../../../src/gateway/api-server.js";
import { type IntegrationCatalog, profileDescriptors } from "../../../src/gateway/catalog.js";
import { compileArgumentValidator } from "../../../src/gateway/validate.js";
import { createIntegrations, type Integrations } from "../../../src/integrations/registry.js";
import { testEnv } from "../../helpers/agent-fixtures.js";

const env = testEnv({ STRIPE_SECRET_KEY: `sk_test_${"a".repeat(24)}` });

type CapturedTool = {
  readonly name: string;
  readonly inputSchema: unknown;
  readonly annotations?: { readonly readOnlyHint?: boolean };
};

const surface = JSON.parse(
  readFileSync(new URL("../../fixtures/surfaces/composio-direct.json", import.meta.url), "utf8"),
) as { toolkits: Record<string, { tools: CapturedTool[] }> };

describe("the integrations registry as the gateway catalog", () => {
  it("has the catalog's shape", () => {
    expectTypeOf<Integrations>().toExtend<IntegrationCatalog>();
  });

  it("offers every Stripe profile tool with a schema the gateway can validate", () => {
    const catalog: IntegrationCatalog = createIntegrations();
    const resolution = catalog.stripe.resolve(env);
    if (resolution.status !== "configured") throw new Error("stripe not configured");
    const tools = catalog.stripe.tools(resolution.connection, { currency: "USD" });
    const descriptors = profileDescriptors(catalog.stripe);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      descriptors.map((descriptor) => descriptor.name).sort(),
    );
    for (const descriptor of descriptors) {
      const definition = tools.find((tool) => tool.name === descriptor.name);
      if (definition === undefined) throw new Error(`stripe: ${descriptor.name} missing`);
      const gatewayTool = apiGatewayTool(definition, descriptor);
      expect(gatewayTool.definition.annotations?.readOnlyHint, descriptor.name).toBe(
        descriptor.readOnly,
      );
      expect(() => compileArgumentValidator(gatewayTool.definition.inputSchema)).not.toThrow();
    }
  });

  it("finds every Composio profile tool in the captured surface, with a schema it can validate", () => {
    const catalog: IntegrationCatalog = createIntegrations();
    for (const id of ["gmail", "google_calendar", "quickbooks", "slack"] as const) {
      const captured = surface.toolkits[COMPOSIO_TOOLKIT_OF[id]]?.tools ?? [];
      const byName = new Map(captured.map((tool) => [tool.name, tool]));
      const descriptors = profileDescriptors(catalog[id]);
      expect(descriptors.map((descriptor) => descriptor.upstream).sort(), id).toEqual(
        captured.map((tool) => tool.name).sort(),
      );
      for (const descriptor of descriptors) {
        const tool = byName.get(descriptor.upstream);
        if (tool === undefined) throw new Error(`${id}: ${descriptor.upstream} not captured`);
        expect(() => compileArgumentValidator(tool.inputSchema), descriptor.name).not.toThrow();
        // Composio marks its reads read-only; Revenue Desk's reads are exactly those.
        expect(descriptor.readOnly, descriptor.name).toBe(tool.annotations?.readOnlyHint === true);
      }
    }
  });
});
