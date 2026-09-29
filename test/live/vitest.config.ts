import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm test:live` (docs/ARCHITECTURE.md §11): the real model and the real
// accounts in the env file, read-only. It costs money and reads real data, so
// it runs only when asked for explicitly; nothing else includes test/live.
// The write tests (test/live/writes) have their own opt-in and config.
if (process.env.LIVE_E2E !== "1") {
  process.stderr.write(
    "pnpm test:live calls the real Anthropic API and reads the connected accounts. " +
      "Set LIVE_E2E=1 to run it.\n",
  );
  process.exit(2);
}

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    environment: "node",
    include: ["test/live/*.test.ts"],
    // The default reporter shows each test's log line (states, counts and
    // tool names only) and the reason a test was skipped.
    reporters: ["default"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
