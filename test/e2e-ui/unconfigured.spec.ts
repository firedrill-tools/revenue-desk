// The real app with no configuration at all (docs/ARCHITECTURE.md §9): a
// second server, started here from the production build with an explicit
// environment that holds no key and no DOTENV_PATH, and its own empty state
// directory. It says up front that it cannot run, offers no job, and shows
// every integration as not configured with the variables to set.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { freePort, REPOSITORY_ROOT } from "../support/repository.js";
import { appApi, expectAccessible, expectNoSideScroll, isPhone } from "./support.js";

let server: ChildProcess | undefined;
let url = "";
let stateDir = "";

test.beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "revenue-desk-unconfigured-"));
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(REPOSITORY_ROOT, "dist/server/main.js")], {
    cwd: REPOSITORY_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: stateDir,
      PORT: String(port),
      AGENT_STATE_DIR: stateDir,
    },
    stdio: "ignore",
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${url}/api/health`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(200);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(stateDir, { recursive: true, force: true });
});

test("says it cannot run yet and offers no job to start", async ({ page }, testInfo) => {
  expect((await (await appApi(url)).session()).modelConfigured).toBe(false);
  await page.goto(`${url}/`);
  await expect(page.getByText("Revenue Desk can't run yet:")).toBeVisible();
  await expect(page.getByText(/ANTHROPIC_API_KEY is not set/)).toBeVisible();
  const jobs = page.getByRole("list", { name: "Suggested jobs" }).getByRole("button");
  await expect(jobs).toHaveCount(5);
  for (const job of await jobs.all()) await expect(job).toBeDisabled();
  await page.getByRole("textbox", { name: "Message Revenue Desk" }).fill("Who owes us money?");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  if (!isPhone(testInfo)) await expect(page.getByText("No model key")).toBeVisible();
  await expectAccessible(page);
  await expectNoSideScroll(page);
});

test("shows every integration as not configured, with the variables to set", async ({ page }) => {
  const { items } = await (await appApi(url)).expect("GET /api/connections");
  expect(items.map((view) => [view.integration, view.state, view.canConnect])).toEqual([
    ["gmail", "not_configured", false],
    ["google_calendar", "not_configured", false],
    ["hubspot", "not_configured", false],
    ["stripe", "not_configured", false],
    ["quickbooks", "not_configured", false],
    ["slack", "not_configured", false],
  ]);
  await page.goto(`${url}/connections`);
  await expect(
    page.getByText("Not configured", { exact: true }).filter({ visible: true }),
  ).toHaveCount(6);
  for (const variable of ["STRIPE_SECRET_KEY", "HUBSPOT_ACCESS_TOKEN", "COMPOSIO_API_KEY"]) {
    await expect(
      page.getByText(variable, { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connections: 0 of 6 connected" })).toBeVisible();
  await expectAccessible(page);
  await expectNoSideScroll(page);
});
