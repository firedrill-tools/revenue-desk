// The integrations workstream's registry is the gateway's catalog as it
// stands: its Integrations type fits IntegrationCatalog (checked by pnpm
// typecheck), and every profile tool of its API integrations can be offered
// and validated by the gateway.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ApiIntegrationId } from "../../../src/contracts/integration.js";
import { apiGatewayTool } from "../../../src/gateway/api-server.js";
import { type IntegrationCatalog, profileDescriptors } from "../../../src/gateway/catalog.js";
import { compileArgumentValidator } from "../../../src/gateway/validate.js";
import { createIntegrations, type Integrations } from "../../../src/integrations/registry.js";
import { testEnv } from "../../helpers/agent-fixtures.js";

const env = testEnv({
  STRIPE_SECRET_KEY: `sk_test_${"a".repeat(24)}`,
  QBO_ACCESS_TOKEN: `qbo-${"b".repeat(24)}`,
  QBO_REALM_ID: "9130350000000000",
  SLACK_BOT_TOKEN: `xoxb-${"c".repeat(24)}`,
});

function apiTools(catalog: IntegrationCatalog, id: ApiIntegrationId) {
  const options = { currency: "USD" };
  if (id === "stripe") {
    const resolution = catalog.stripe.resolve(env);
    if (resolution.status !== "configured") throw new Error("stripe not configured");
    return catalog.stripe.tools(resolution.connection, options);
  }
  if (id === "quickbooks") {
    const resolution = catalog.quickbooks.resolve(env);
    if (resolution.status !== "configured") throw new Error("quickbooks not configured");
    return catalog.quickbooks.tools(resolution.connection, options);
  }
  const resolution = catalog.slack.resolve(env);
  if (resolution.status !== "configured") throw new Error("slack not configured");
  return catalog.slack.tools(resolution.connection, options);
}

describe("the integrations registry as the gateway catalog", () => {
  it("has the catalog's shape", () => {
    expectTypeOf<Integrations>().toExtend<IntegrationCatalog>();
  });

  it("offers every API profile tool with a schema the gateway can validate", () => {
    const catalog: IntegrationCatalog = createIntegrations();
    for (const id of ["stripe", "quickbooks", "slack"] as const) {
      const tools = apiTools(catalog, id);
      const descriptors = profileDescriptors(catalog[id]);
      expect(tools.map((tool) => tool.name).sort(), id).toEqual(
        descriptors.map((descriptor) => descriptor.name).sort(),
      );
      for (const descriptor of descriptors) {
        const definition = tools.find((tool) => tool.name === descriptor.name);
        if (definition === undefined) throw new Error(`${id}: ${descriptor.name} missing`);
        const gatewayTool = apiGatewayTool(definition, descriptor);
        expect(gatewayTool.definition.annotations?.readOnlyHint, descriptor.name).toBe(
          descriptor.readOnly,
        );
        expect(() => compileArgumentValidator(gatewayTool.definition.inputSchema)).not.toThrow();
      }
    }
  });
});
