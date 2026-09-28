// The built app in a browser (docs/ARCHITECTURE.md §9, §11): the production
// build (dist/server/main.js serving dist/web) in the labelled sandbox, with
// the scripted model and every local fake (playwright.config.ts starts it).
// Desktop 1440x900 and phone 390x844. Run `pnpm build` first.

import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const APPROVAL = /^Approval needed: /;

async function startBillingInquiry(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("list", { name: "Suggested jobs" })
    .getByRole("button", { name: /Answer a billing inquiry/ })
    .click();
  await expect(page.getByRole("region", { name: APPROVAL })).toBeVisible({ timeout: 30_000 });
}

async function expectNoSideScroll(page: Page): Promise<void> {
  // A string, not a function: test code is type-checked without the DOM library.
  const overflow = Number(
    await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    ),
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Revenue Desk in the sandbox", () => {
  test("the empty chat is labelled, accessible and fits the screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Local sandbox", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Suggested jobs" }).getByRole("button"),
    ).toHaveCount(5);
    await expect(page.getByRole("textbox", { name: "Message Revenue Desk" })).toBeVisible();
    const axe = await new AxeBuilder({ page }).analyze();
    const serious = axe.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      serious.map((violation) => ({
        rule: violation.id,
        nodes: violation.nodes.map(
          (node) => `${node.target.join(" ")}: ${node.failureSummary ?? ""}`,
        ),
      })),
    ).toEqual([]);
    await expectNoSideScroll(page);
  });

  test("a billing inquiry: tool rows, the approval card, approve, the answer", async ({ page }) => {
    await startBillingInquiry(page);
    const card = page.getByRole("region", { name: APPROVAL });
    // The card names who receives the email: the draft this run created was for Dana.
    await expect(card).toContainText("Send the Gmail draft to dana@harborpine.test");
    await expect(page.locator("[data-status]").first()).toBeVisible();
    await expect(page.getByText(/Checked \d+ sources/).first()).toBeVisible();
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/I replied to Dana/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expectNoSideScroll(page);
  });

  test("a reload while the approval waits keeps the card actionable", async ({ page }) => {
    await startBillingInquiry(page);
    await expect(page).toHaveURL(/\/c\/[^/]+$/);
    await page.reload();
    const card = page.getByRole("region", { name: APPROVAL });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText(/saved as a draft and was not sent/)).toBeVisible({
      timeout: 30_000,
    });
  });

  test("Stop while the approval waits ends the run as stopped", async ({ page }) => {
    await startBillingInquiry(page);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("region", { name: APPROVAL })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  });
});
