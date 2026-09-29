import { defineConfig } from "vitest/config";

// The built CLI suite (docs/ARCHITECTURE.md §11): it spawns dist/cli/main.js
// for what the CLI decides before a model call, so it runs after `pnpm build`
// (pnpm test:cli, part of pnpm verify) and not in `pnpm test`.
export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    include: ["test/cli/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
