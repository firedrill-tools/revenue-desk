// Throwaway visual check for the web UI (W4). NOT a test suite: it drives the
// built app against test/support/web-stub/server.ts with the installed Chrome
// and saves screenshots for a person to look at.
//
//   node --import tsx test/support/web-stub/screenshots.ts <baseUrl> <outDir>

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4399";
const outDir = process.argv[3] ?? "screenshots";
mkdirSync(outDir, { recursive: true });

type Viewport = { name: "desktop" | "phone"; width: number; height: number };
const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const THEMES = ["light", "dark"] as const;
/** Optional "desktop-light"-style filter for quick iterations. */
const only = process.argv[4];

async function shot(page: Page, name: string, viewport: Viewport, theme: string): Promise<void> {
  await page.waitForTimeout(250);
  const path = join(outDir, `${viewport.name}-${theme}-${name}.png`);
  await page.screenshot({ path });
  process.stderr.write(`saved ${path}\n`);
}

async function assertNoHorizontalScroll(page: Page, label: string): Promise<void> {
  // A string, not a function: this file is type-checked without the DOM library.
  const overflow = Number(
    await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    ),
  );
  if (overflow > 0) process.stderr.write(`WARNING horizontal overflow ${overflow}px on ${label}\n`);
}

async function run(
  browser: Browser,
  viewport: Viewport,
  theme: (typeof THEMES)[number],
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.name === "phone" ? 2 : 1,
    hasTouch: viewport.name === "phone",
    isMobile: viewport.name === "phone",
  });
  await context.addInitScript({
    content: `window.localStorage.setItem("revenue-desk:theme", ${JSON.stringify(theme)});`,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  // Empty chat.
  await page.goto(`${baseUrl}/`);
  await page.getByRole("list", { name: "Suggested jobs" }).waitFor();
  await shot(page, "01-empty-chat", viewport, theme);
  await assertNoHorizontalScroll(page, "empty chat");

  // Streaming turn: the refund job, captured while Stripe is still running.
  await page.getByRole("button", { name: /Refund a duplicate charge/ }).click();
  await page
    .getByText(/Checking 3 sources/)
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2_200);
  await shot(page, "02-streaming-turn", viewport, theme);
  await assertNoHorizontalScroll(page, "streaming turn");

  // Approval card, then the tool rows of all three kinds (reads group expanded).
  const card = page.getByRole("region", { name: /Approval needed/ });
  await card.waitFor({ timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  await shot(page, "03-approval-card", viewport, theme);
  await page.getByRole("button", { name: /Checked 3 sources/ }).click();
  await page.getByRole("button", { name: /Search the billing inbox/ }).scrollIntoViewIfNeeded();
  await shot(page, "04-tool-rows", viewport, theme);

  // Approve and wait for the finished answer.
  await card.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Refunded the duplicate charge for").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Send" }).waitFor();
  await page.waitForTimeout(600);
  await shot(page, "05-finished-answer", viewport, theme);

  // Inspector (desktop inline, phone bottom sheet).
  await page.getByRole("button", { name: "Open inspector" }).click();
  await page.waitForTimeout(400);
  await shot(page, "06-inspector-activity", viewport, theme);
  await page.getByRole("tab", { name: "Run" }).click();
  await page.waitForTimeout(300);
  await shot(page, "07-inspector-run", viewport, theme);
  await page
    .getByRole("button", { name: viewport.name === "desktop" ? "Close inspector" : "Close" })
    .first()
    .click();

  // Connections.
  await page.goto(`${baseUrl}/connections`);
  await page.getByRole("heading", { name: "Connections" }).waitFor();
  await page.getByText("Gmail").filter({ visible: true }).first().waitFor();
  await shot(page, "08-connections", viewport, theme);
  await assertNoHorizontalScroll(page, "connections");

  // Runs and the detail sheet.
  await page.goto(`${baseUrl}/runs`);
  await page.getByRole("heading", { name: "Runs" }).waitFor();
  await page.getByText("Completed").filter({ visible: true }).first().waitFor();
  await shot(page, "09-runs", viewport, theme);
  await assertNoHorizontalScroll(page, "runs");
  if (viewport.name === "desktop") await page.locator("tbody tr").first().click();
  else await page.locator("main ul li button").first().click();
  await page.getByRole("heading", { name: "Tool calls" }).waitFor();
  await page.waitForTimeout(300);
  await shot(page, "10-run-detail", viewport, theme);

  // Settings.
  await page.goto(`${baseUrl}/settings`);
  await page.getByRole("heading", { name: "Workspace" }).waitFor();
  await shot(page, "11-settings", viewport, theme);
  await page.evaluate(
    "[...document.querySelectorAll('h2')].find((h) => h.textContent === 'Approval policy')?.scrollIntoView({ block: 'start' })",
  );
  await shot(page, "12-settings-policy", viewport, theme);
  await assertNoHorizontalScroll(page, "settings");

  // Phone: the conversation rail as a sheet.
  if (viewport.name === "phone") {
    await page.getByRole("button", { name: "Open conversations" }).click();
    await page.waitForTimeout(400);
    await shot(page, "13-rail-sheet", viewport, theme);
  }

  if (errors.length > 0)
    process.stderr.write(`console errors (${viewport.name}/${theme}):\n  ${errors.join("\n  ")}\n`);
  await context.close();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      if (only && only !== `${viewport.name}-${theme}`) continue;
      await run(browser, viewport, theme);
    }
  }
} finally {
  await browser.close();
}
