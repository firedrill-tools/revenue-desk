import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT } from "./test/e2e-ui/port.js";

// UI end-to-end tests of the real app (docs/ARCHITECTURE.md §11): the
// production build (run `pnpm build` first), dist/server/main.js on
// 127.0.0.1:4320 (or E2E_PORT, test/e2e-ui/port.ts), with the real configuration (DOTENV_PATH, default this
// repository's git-ignored .env, when it exists) and a fresh state directory
// in the system temp directory. Nothing is faked: the connections the pages
// show are the ones the server checked, read-only, at start.
//
// `pnpm test:e2e` runs everything that needs no model call, in the installed
// Google Chrome on desktop and phone viewports. It never clicks Connect
// (which would start a real sign-in) and never starts a job.
//
// `LIVE_E2E=1 pnpm test:live:ui` (which sets LIVE_UI=1) runs the chat with
// the real model instead (*.live.spec.ts, desktop only): read-only prompts,
// and one approval that is denied. Its failure output can hold real data, so
// it keeps no trace, screenshot or HTML report, and writes its artifacts
// outside the repository. `pnpm test:e2e` never runs it.
const LIVE = process.env.LIVE_UI === "1";
const PORT = E2E_PORT;
const STATE_DIR = join(tmpdir(), LIVE ? "revenue-desk-e2e-ui-live" : "revenue-desk-e2e-ui");
const DOTENV = resolve(process.env.DOTENV_PATH?.trim() || ".env");

export default defineConfig({
  testDir: "./test/e2e-ui",
  outputDir: LIVE
    ? join(process.env.LIVE_OUT_DIR?.trim() || tmpdir(), "revenue-desk-e2e-ui-live-results")
    : "./test-results",
  // One server and one database for every test: one at a time keeps them independent.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: LIVE
    ? [["list"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    trace: LIVE ? "off" : "retain-on-failure",
    screenshot: LIVE ? "off" : "only-on-failure",
  },
  projects: LIVE
    ? [
        {
          name: "live-desktop-chrome",
          testMatch: /\.live\.spec\.ts$/,
          use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
        },
      ]
    : [
        {
          name: "desktop-chrome",
          testIgnore: /\.live\.spec\.ts$/,
          use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
        },
        {
          name: "phone-chrome",
          testIgnore: /\.live\.spec\.ts$/,
          use: {
            ...devices["Desktop Chrome"],
            viewport: { width: 390, height: 844 },
            hasTouch: true,
            isMobile: true,
          },
        },
      ],
  webServer: {
    // A fresh database each time; a server already listening on the port is never reused.
    command: `node -e "require('node:fs').rmSync(process.env.AGENT_STATE_DIR,{recursive:true,force:true})" && node dist/server/main.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      AGENT_STATE_DIR: STATE_DIR,
      ...(existsSync(DOTENV) ? { DOTENV_PATH: DOTENV } : {}),
      // The live chat spends at most this per run.
      ...(LIVE ? { AGENT_MAX_BUDGET_USD: "0.50" } : {}),
    },
  },
});
