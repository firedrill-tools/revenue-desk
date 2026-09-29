import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm test:live:writes` (docs/ARCHITECTURE.md §11): the real model makes
// real changes, only on test-safe targets (Stripe test mode, a QuickBooks
// sandbox company, a HubSpot test or sandbox account, a Gmail draft to the
// account's own address, a Slack channel named in LIVE_SLACK_TEST_CHANNEL),
// and removes what it made where the API allows. A second opt-in on top of
// the live one, so it never runs by accident.
if (process.env.LIVE_E2E !== "1" || process.env.LIVE_E2E_WRITES !== "1") {
  process.stderr.write(
    "pnpm test:live:writes changes real test-safe accounts. " +
      "Set LIVE_E2E=1 and LIVE_E2E_WRITES=1 to run it.\n",
  );
  process.exit(2);
}

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    environment: "node",
    include: ["test/live/writes/*.test.ts"],
    reporters: ["default"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
