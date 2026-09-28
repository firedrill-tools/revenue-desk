import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is web/. Unit and integration tests
// run in Node against src/; Playwright owns test/e2e-ui.
export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    restoreMocks: true,
  },
});
