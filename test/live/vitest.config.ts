import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm test:live` (docs/ARCHITECTURE.md §11): tests against real services.
// They cost money and read a real mailbox, so they run only when asked for
// explicitly; nothing else includes test/live.
if (process.env.LIVE_E2E !== "1") {
  process.stderr.write(
    "pnpm test:live calls the real Anthropic API and reads the connected Gmail inbox. " +
      "Set LIVE_E2E=1 to run it.\n",
  );
  process.exit(2);
}

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    // The default reporter shows a passing test's log line (counts and tool
    // names only); the minimal one some environments pick hides it.
    reporters: ["default"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
