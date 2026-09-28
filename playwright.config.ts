import { defineConfig, devices } from "@playwright/test";

// UI end-to-end tests run the built app (run `pnpm build` first) in the
// labelled sandbox: dist/server/main.js on 127.0.0.1:4320 against the local
// fakes and the scripted model (docs/ARCHITECTURE.md §11). The model is
// forced to the scripted one, and a server already listening on 4320 is never
// reused, so a test can never drive a real workspace or the real model.
// Browsers: the installed Google Chrome (channel "chrome").
export default defineConfig({
  testDir: "./test/e2e-ui",
  outputDir: "./test-results",
  // The runs share one set of fakes; one at a time keeps them independent.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:4320",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "phone-chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: "node --import tsx scripts/dev-sandbox.ts --built --model scripted",
    url: "http://127.0.0.1:4320/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
