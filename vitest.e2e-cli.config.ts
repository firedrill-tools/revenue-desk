import { defineConfig } from "vitest/config";

// The CLI end-to-end suite (docs/ARCHITECTURE.md §11): it spawns the built
// CLI (dist/cli/main.js), so it runs after `pnpm build` (pnpm test:e2e-cli,
// the last step of pnpm verify) and not in `pnpm test`.
export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    include: ["test/e2e-cli/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
