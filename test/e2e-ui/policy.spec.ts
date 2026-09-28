// A policy change in Settings applies to the next run (docs/ARCHITECTURE.md
// §7, §9): with financial actions set to deny, the refund job's refund is
// refused before anyone is asked, and the card says why in plain words.

import { expect, test } from "@playwright/test";
import {
  APPROVAL,
  expectAccessible,
  expectNoSideScroll,
  sandboxApi,
  startJob,
  stopActiveRuns,
} from "./support.js";

test.afterEach(async () => {
  // The sandbox is shared by every test: put the default back even after a failure.
  const api = await sandboxApi();
  await api.expect("PATCH /api/policies", { body: { modes: { financial: "ask" } } });
  await stopActiveRuns();
});

test("financial actions set to deny: the next refund is refused with a plain reason", async ({
  page,
}) => {
  await page.goto("/settings");
  const financial = page.getByRole("group", { name: "Financial actions" });
  await financial.getByText("Deny", { exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Approval policy saved. It applies to the next run.")).toBeVisible();
  await expect(financial.getByRole("radio", { name: "Deny" })).toBeChecked();

  await startJob(page, /Refund a duplicate charge/);
  const blocked = page.locator('[data-slot="confirmation"][data-state="blocked"]');
  await expect(blocked).toBeVisible({ timeout: 30_000 });
  await expect(blocked).toContainText("Blocked by policy");
  await expect(blocked).toContainText("Financial actions are set to deny in this workspace.");
  // The server's words for the model stay out of the card.
  await expect(blocked).not.toContainText("do not retry");
  await expect(blocked).not.toContainText("Blocked by policy: Financial");
  // Nobody was asked, and the run finished.
  await expect(page.getByRole("region", { name: APPROVAL })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-status="blocked"]')).toContainText("Refund charge in Stripe");
  await expectNoSideScroll(page);

  // The card leads to the setting that decided it.
  await blocked.getByRole("link", { name: "Review the policy" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("group", { name: "Financial actions" }).getByRole("radio", { name: "Deny" }),
  ).toBeChecked();
});
