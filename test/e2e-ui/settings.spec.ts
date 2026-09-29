// Settings in the running app (docs/ARCHITECTURE.md §7, §9): the company
// profile and the approval policy are saved to this app's database (a fresh
// one for the suite, never a person's workspace) and read back after a
// reload. What a saved policy does to a run is in chat.live.spec.ts.

import { expect, test } from "@playwright/test";
import { appApi, expectAccessible, expectNoSideScroll, uniqueTitle } from "./support.js";

test.afterEach(async () => {
  // The suite shares one database: put the defaults back even after a failure.
  const api = await appApi();
  await api.expect("PATCH /api/policies", { body: { modes: { financial: "ask" } } });
});

test("financial actions set to deny are saved and stay after a reload", async ({ page }) => {
  const api = await appApi();
  const { policies } = await api.expect("GET /api/policies");
  const financialPolicy = policies.find((policy) => policy.actionClass === "financial");
  test.skip(financialPolicy?.locked === true, "AGENT_POLICY locks financial actions here.");

  await page.goto("/settings");
  const financial = page.getByRole("group", { name: "Financial actions" });
  await financial.getByText("Deny", { exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Approval policy saved. It applies to the next run.")).toBeVisible();
  await expect(financial.getByRole("radio", { name: "Deny" })).toBeChecked();

  // The server has it, and the page shows it after a reload.
  const saved = await api.expect("GET /api/policies");
  expect(saved.policies.find((policy) => policy.actionClass === "financial")).toMatchObject({
    mode: "deny",
    source: "saved",
  });
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Financial actions" }).getByRole("radio", { name: "Deny" }),
  ).toBeChecked();
  await expectNoSideScroll(page);
});

test("the company profile is saved and read back", async ({ page }) => {
  const api = await appApi();
  const before = (await api.expect("GET /api/settings")).settings;
  const company = uniqueTitle("Settings check");
  await page.goto("/settings");
  const field = page.getByLabel("Company name");
  await field.fill(company);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved. They apply to the next run.")).toBeVisible();
  expect((await api.expect("GET /api/settings")).settings.companyName).toBe(company);
  await page.reload();
  await expect(page.getByLabel("Company name")).toHaveValue(company);
  await api.expect("PATCH /api/settings", { body: { companyName: before.companyName } });
});
