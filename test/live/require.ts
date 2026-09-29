/**
 * LIVE_REQUIRE for the live suites (`pnpm test:live`, `pnpm test:live:ui`,
 * `pnpm test:live:writes`): a comma-separated list of integration ids, or
 * `all`, that must be exercised. When one of them cannot be (not configured,
 * not connected, or, in the write suite, no test-safe target), its test FAILS
 * with the reason instead of skipping. Unset, every such test skips with the
 * reason, so a partial setup still runs.
 *
 * An unknown id is refused, so a typo cannot silently require nothing.
 * Imports nothing heavy: the Playwright spec and the unit tests use it too.
 */
import {
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationId,
} from "../../src/contracts/integration.js";

export const LIVE_REQUIRE = "LIVE_REQUIRE";

/** The integrations LIVE_REQUIRE names. Throws on an unknown id. */
export function parseLiveRequire(raw: string | undefined): ReadonlySet<IntegrationId> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  if (entries.includes("all")) return new Set(INTEGRATION_IDS);
  const unknown = entries.filter(
    (entry) => !(INTEGRATION_IDS as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${LIVE_REQUIRE} names ${unknown.map((entry) => JSON.stringify(entry)).join(", ")}, which is not an integration. ` +
        `Use a comma-separated list of ${INTEGRATION_IDS.join(", ")}, or all.`,
    );
  }
  return new Set(entries as IntegrationId[]);
}

let required: ReadonlySet<IntegrationId> | undefined;

/** LIVE_REQUIRE of this process, parsed once. */
export function requiredIntegrations(): ReadonlySet<IntegrationId> {
  required ??= parseLiveRequire(process.env[LIVE_REQUIRE]);
  return required;
}

/**
 * What a live test does when `integration` cannot be exercised: with
 * LIVE_REQUIRE naming it, an Error to throw (the test fails with the reason);
 * otherwise null, and the caller skips with the reason.
 */
export function requiredFailure(
  integration: IntegrationId,
  reason: string,
  wanted: ReadonlySet<IntegrationId> = requiredIntegrations(),
): Error | null {
  if (!wanted.has(integration)) return null;
  return new Error(
    `${INTEGRATIONS[integration].label} is required by ${LIVE_REQUIRE} but cannot be tested: ${reason}`,
  );
}
