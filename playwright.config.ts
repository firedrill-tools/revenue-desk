import { defineConfig, devices } from "@playwright/test";

// UI end-to-end tests run the built app (pnpm build && pnpm start) against the
// local fakes and the scripted model; see docs/ARCHITECTURE.md §11.
export default defineConfig({
  testDir: "./test/e2e-ui",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:4320",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "phone-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: "http://127.0.0.1:4320/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
