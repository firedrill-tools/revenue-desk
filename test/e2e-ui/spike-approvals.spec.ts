// Spike S1 smoke: the scripted approval stream renders in useChat with the owned
// AI Elements components, and a click on Approve or Deny reaches the server,
// whose tool-approval-response chunk moves the card on.

import { expect, type Page, test } from "@playwright/test";

const CONSEQUENCE = "Refund $49.00 to Kestrel Analytics";

function approvalCard(page: Page) {
  // AI Elements Confirmation renders an Alert (role="alert").
  return page.getByRole("alert").filter({ hasText: CONSEQUENCE });
}

test.describe("spike S1: approval stream in the browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/spike/approvals");
    await page.getByRole("button", { name: "Run script" }).click();
    await expect(page.getByText("Awaiting Approval")).toBeVisible();
    await expect(approvalCard(page).getByText("Kestrel Analytics, Inc.")).toBeVisible();
  });

  test("Approve shows the tool output and the closing answer", async ({ page }) => {
    const approvalRequest = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().includes("/api/spike/approvals/"),
    );
    await approvalCard(page).getByRole("button", { name: "Approve" }).click();
    expect((await approvalRequest).postDataJSON()).toEqual({ approved: true });

    await expect(approvalCard(page).getByText("Approved", { exact: true })).toBeVisible();
    await expect(approvalCard(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(page.getByText("Result", { exact: true })).toBeVisible();
    await expect(page.locator("pre", { hasText: "re_spike_0001" })).toBeVisible();
    await expect(page.getByText(/Refunded \$49\.00 to Kestrel Analytics/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Run script" })).toBeEnabled();
  });

  test("Deny shows the denial and no tool output", async ({ page }) => {
    await approvalCard(page).getByRole("button", { name: "Deny" }).click();

    await expect(approvalCard(page).getByText("Denied", { exact: true })).toBeVisible();
    await expect(approvalCard(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByText(/I did not refund the charge/)).toBeVisible();
    await expect(page.getByText("Result", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run script" })).toBeEnabled();
  });
});
