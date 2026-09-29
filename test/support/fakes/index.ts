/**
 * Starts every local fake with the Kestrel Analytics fixtures and produces
 * the ordinary integration variables (docs/ARCHITECTURE.md §3) that point
 * Revenue Desk at them. QuickBooks and Slack are Composio toolkits with no
 * local fake: the Composio fake lists their captured tools and reports them
 * not connected, as Composio does for a toolkit nobody signed in to. Nothing here is reachable from product code: the
 * product only ever sees base URLs and credentials, exactly as it would for
 * the real services.
 */
import type { EnvVarName } from "../../../src/contracts/env.js";
import { ComposioFake } from "./composio/index.js";
import { type ClockMode, createClock, type FakeClock } from "./core/clock.js";
import { FAKE_CREDENTIALS } from "./credentials.js";
import { type BusinessFixtures, loadBusinessFixtures } from "./fixtures.js";
import { HubSpotFake } from "./hubspot/index.js";
import { StripeFake } from "./stripe/index.js";

export type HubSpotMode =
  /** The product's default: it launches the pinned @hubspot/mcp-server against the fake REST API. */
  | "stdio"
  /** HUBSPOT_MCP_URL: the fake's Streamable HTTP MCP endpoint (the vendor tools behind it). */
  | "http";

export interface StartFakesOptions {
  /** "fixed" (default, tests) or "running" (the sandbox demo). */
  readonly clock?: ClockMode;
  /** Mount every fake under a path prefix, to prove clients keep base URL prefixes. Default false. */
  readonly prefixes?: boolean;
  /** How the product reaches HubSpot. Default "stdio". */
  readonly hubspot?: HubSpotMode;
  /** Fixtures to serve; a fresh copy of the business fixtures by default. */
  readonly fixtures?: BusinessFixtures;
}

/** Integration variables for the product, by their ENV_VARS names. */
export type IntegrationEnv = Readonly<Partial<Record<EnvVarName, string>>>;

export interface Fakes {
  readonly fixtures: BusinessFixtures;
  readonly clock: FakeClock;
  readonly stripe: StripeFake;
  readonly hubspot: HubSpotFake;
  readonly composio: ComposioFake;
  readonly hubspotMode: HubSpotMode;
  /** COMPOSIO_*, HUBSPOT_* and STRIPE_* for the product. */
  env(): IntegrationEnv;
  close(): Promise<void>;
}

export async function startFakes(options: StartFakesOptions = {}): Promise<Fakes> {
  const fixtures = options.fixtures ?? loadBusinessFixtures();
  const clock = createClock(fixtures.company.asOf, options.clock ?? "fixed");
  const prefix = (name: string) => (options.prefixes === true ? { prefix: `/${name}` } : {});
  const hubspotMode = options.hubspot ?? "stdio";
  const started: { close(): Promise<void> }[] = [];
  const track = <T extends { close(): Promise<void> }>(fake: T): T => {
    started.push(fake);
    return fake;
  };
  try {
    const [stripe, hubspot, composio] = await Promise.all([
      StripeFake.start({
        fixture: fixtures.stripe,
        clock,
        secretKey: FAKE_CREDENTIALS.stripeSecretKey,
        ...prefix("stripe"),
      }).then(track),
      HubSpotFake.start({
        fixture: fixtures.hubspot,
        clock,
        accessToken: FAKE_CREDENTIALS.hubspotAccessToken,
        mcpToken: FAKE_CREDENTIALS.hubspotMcpToken,
        mcp: hubspotMode === "http",
        ...prefix("hubspot"),
      }).then(track),
      ComposioFake.start({
        composio: fixtures.composio,
        gmail: fixtures.gmail,
        calendar: fixtures.calendar,
        clock,
        apiKey: FAKE_CREDENTIALS.composioApiKey,
        ...prefix("composio"),
      }).then(track),
    ]);
    return {
      fixtures,
      clock,
      stripe,
      hubspot,
      composio,
      hubspotMode,
      env: () => ({
        COMPOSIO_API_KEY: FAKE_CREDENTIALS.composioApiKey,
        COMPOSIO_USER_ID: fixtures.composio.userId,
        COMPOSIO_BASE_URL: composio.baseUrl,
        ...(hubspotMode === "http"
          ? { HUBSPOT_MCP_URL: hubspot.mcpUrl, HUBSPOT_MCP_TOKEN: FAKE_CREDENTIALS.hubspotMcpToken }
          : hubspot.stdioEnv()),
        STRIPE_SECRET_KEY: FAKE_CREDENTIALS.stripeSecretKey,
        STRIPE_API_BASE_URL: stripe.baseUrl,
      }),
      close: async () => {
        await Promise.allSettled(started.map((fake) => fake.close()));
      },
    };
  } catch (error) {
    await Promise.allSettled(started.map((fake) => fake.close()));
    throw error;
  }
}

export type { BusinessFixtures };
export { ComposioFake, HubSpotFake, StripeFake };
