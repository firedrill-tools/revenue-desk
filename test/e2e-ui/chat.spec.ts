// The built app in a browser (docs/ARCHITECTURE.md §9, §11): the production
// build (dist/server/main.js serving dist/web) in the labelled sandbox, with
// the scripted model and every local fake (playwright.config.ts starts it).
// Desktop 1440x900 and phone 390x844. Run `pnpm build` first.

import { expect, type Page, test } from "@playwright/test";
import {
  APPROVAL,
  expectAccessible,
  expectNoSideScroll,
  isFocused,
  isFocusVisible,
  isPhone,
  openRail,
  sandboxApi,
  startJob,
  stopActiveRuns,
  tabTo,
} from "./support.js";

async function startBillingInquiry(page: Page): Promise<void> {
  await startJob(page, /Answer a billing inquiry/);
  const card = page.getByRole("region", { name: APPROVAL });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("button", { name: "Approve" })).toBeEnabled();
}

test.afterEach(async () => {
  await stopActiveRuns();
});

test.describe("Revenue Desk in the sandbox", () => {
  test("the empty chat is labelled, accessible and fits the screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Local sandbox", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Suggested jobs" }).getByRole("button"),
    ).toHaveCount(5);
    await expect(page.getByRole("textbox", { name: "Message Revenue Desk" })).toBeVisible();
    await expectAccessible(page);
    await expectNoSideScroll(page);
  });

  test("a billing inquiry: tool rows, the approval card, approve, the answer", async ({ page }) => {
    await startBillingInquiry(page);
    const card = page.getByRole("region", { name: APPROVAL });
    // The card names who receives the email: the draft this run created was for Dana.
    await expect(card).toContainText("Send the Gmail draft to dana@harborpine.test");
    await expect(page.locator("[data-status]").first()).toBeVisible();
    // Three or more reads collapse into one line; a source is a system, not a call.
    await expect(page.getByText(/Checked 4 sources/).first()).toBeVisible();
    await expect(page.getByText(/6\scalls/).first()).toBeVisible();
    await expectAccessible(page);
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
    // After the answer's actions, one line says how the run ended, how long it took and its cost.
    await expect(page.locator('[data-slot="run-facts"]').last()).toHaveText(
      /^Stopped\s*·\s*[\d.]+\s?m?s · (<)?\$[\d.]+$/,
    );
  });

  test("a suggestion names the conversation after its job", async ({ page }, testInfo) => {
    await startJob(page, /Refund a duplicate charge/);
    await expect(page.getByRole("region", { name: APPROVAL })).toBeVisible({ timeout: 30_000 });
    const rail = await openRail(page, isPhone(testInfo));
    const current = rail.locator('li a[aria-current="page"]');
    await expect(current).toContainText("Refund a duplicate charge");
    await expect(current).not.toContainText("A customer says");
    if (isPhone(testInfo)) await page.keyboard.press("Escape");
    await page
      .getByRole("region", { name: APPROVAL })
      .getByRole("button", { name: "Deny" })
      .click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a suggestion in an empty conversation names it after the job", async ({
    page,
  }, testInfo) => {
    // A conversation with no messages and no title yet (the API can leave one).
    const api = await sandboxApi();
    const { conversation } = await api.expect("POST /api/conversations", { body: {} });
    await page.goto(`/c/${conversation.id}`);
    await page
      .getByRole("list", { name: "Suggested jobs" })
      .getByRole("button", { name: /Answer a billing inquiry/ })
      .click();
    await expect(page.getByRole("region", { name: APPROVAL })).toBeVisible({ timeout: 30_000 });
    const stored = await api.expect("GET /api/conversations/:conversationId", {
      params: { conversationId: conversation.id },
    });
    expect(stored.conversation.title).toBe("Answer a billing inquiry");
    const rail = await openRail(page, isPhone(testInfo));
    await expect(rail.locator('li a[aria-current="page"]')).toContainText(
      "Answer a billing inquiry",
    );
  });

  test("a typed prompt is named by the server from its first sentence", async ({
    page,
  }, testInfo) => {
    // Not one of the scripted jobs: the sandbox model answers with what it knows.
    const prompt = "Which invoices are due this week? List them by customer.";
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message Revenue Desk" });
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect(page).toHaveURL(/\/c\/[^/]+$/);
    await expect(page.getByText(/runs a scripted model/)).toBeVisible({ timeout: 30_000 });
    const rail = await openRail(page, isPhone(testInfo));
    await expect(rail.locator('li a[aria-current="page"]')).toContainText(
      "Which invoices are due this week?",
    );
    await expect(rail.locator('li a[aria-current="page"]')).not.toContainText("List them");
  });

  test("an approval can be reached and approved with the keyboard alone", async ({ page }) => {
    await startBillingInquiry(page);
    const card = page.getByRole("region", { name: APPROVAL });
    const approve = card.getByRole("button", { name: "Approve" });
    const deny = card.getByRole("button", { name: "Deny" });
    const note = card.getByRole("button", { name: "Add a note" });
    // From the composer, back into the card, then forward through it: note, Deny, Approve.
    await page.getByRole("textbox", { name: "Message Revenue Desk" }).focus();
    await tabTo(page, note, { backwards: true });
    await page.keyboard.press("Tab");
    expect(await isFocused(deny)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await isFocused(approve)).toBe(true);
    // The focus is visible, not only present.
    expect(await isFocusVisible(approve)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByText(/I replied to Dana/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(card).toHaveCount(0);
  });

  test("the inspector lists the calls by connection and the run's cost", async ({
    page,
  }, testInfo) => {
    await startBillingInquiry(page);
    await page
      .getByRole("region", { name: APPROVAL })
      .getByRole("button", { name: "Approve" })
      .click();
    await expect(page.getByText(/I replied to Dana/)).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Open inspector" }).click();
    const inspector = isPhone(testInfo)
      ? page.getByRole("dialog", { name: "Inspector" })
      : page.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).toBeVisible();
    await inspector.getByRole("tab", { name: "Activity" }).click();
    await expect(inspector.getByRole("region", { name: "Composio calls" })).toContainText(
      "Send Gmail draft",
    );
    await expect(inspector.getByRole("region", { name: "MCP calls" })).toContainText(
      "Search HubSpot contacts",
    );
    await expect(inspector.getByRole("region", { name: "API calls" })).toContainText(
      "Find customers in Stripe",
    );
    await expect(inspector.getByRole("region", { name: "Approvals" })).toContainText("Approved");
    await expectAccessible(page);

    await inspector.getByRole("tab", { name: "Run" }).click();
    const latest = inspector.getByRole("region", { name: "Latest run" });
    await expect(latest).toContainText("Completed");
    await expect(latest).toContainText("Cost");
    await expect(latest).toContainText(/\d+ in · \d+ out/);
    await expect(inspector.getByRole("region", { name: "Connections for this run" })).toContainText(
      "QuickBooks Online",
    );
    await latest.getByRole("link", { name: "Open run" }).click();
    await expect(page).toHaveURL(/\/runs\/[^/]+$/);
    await expect(page.getByRole("dialog", { name: /Run/ })).toContainText("Tool calls");
    await expectNoSideScroll(page);
  });
});
