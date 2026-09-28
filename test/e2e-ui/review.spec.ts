// What the 2026-09-29 review asked of the running app (docs/ARCHITECTURE.md,
// decisions log): the browser contacts nothing but Revenue Desk, a waiting
// approval shows outside its conversation, an approved refund that Stripe
// declines never reads as a success, and a server without a model key says
// so before anyone starts a job. The first two use the suite's sandbox; the
// others start their own, with the fakes arranged.

import { expect, type Page, test } from "@playwright/test";
import { type Harness, startHarness } from "../support/harness.js";
import {
  APPROVAL,
  expectAccessible,
  expectNoSideScroll,
  isPhone,
  SANDBOX_URL,
  sandboxApi,
  startJob,
  stopActiveRuns,
} from "./support.js";

/** Stops every run and waits until none is left, so counts start from zero. */
async function quiet(baseUrl: string = SANDBOX_URL): Promise<void> {
  await stopActiveRuns(baseUrl);
  const api = await sandboxApi(baseUrl);
  await expect
    .poll(
      async () =>
        (await api.expect("GET /api/runs", { query: { status: "running", limit: 50 } })).items
          .length,
      { timeout: 30_000 },
    )
    .toBe(0);
}

async function approvalCard(page: Page) {
  const card = page.getByRole("region", { name: APPROVAL });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.describe("in the suite's sandbox", () => {
  test.beforeEach(async () => {
    await quiet();
  });
  test.afterEach(async () => {
    await stopActiveRuns();
  });

  test("a whole job never makes the browser contact another host", async ({ page }) => {
    const hosts = new Set<string>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
    });
    const home = await page.goto("/");
    // The page carries the policy that keeps it that way.
    expect(home?.headers()["content-security-policy"]).toContain("img-src 'self' data:");
    await startJob(page, /Answer a billing inquiry/);
    const card = await approvalCard(page);
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/I replied to Dana/)).toBeVisible({ timeout: 30_000 });
    expect([...hosts]).toEqual([new URL(SANDBOX_URL).host]);
  });

  test("a waiting approval shows in the tab title, on the new chat and on the phone's menu", async ({
    page,
  }, testInfo) => {
    await startJob(page, /Refund a duplicate charge/);
    await approvalCard(page);
    await expect(page).toHaveTitle("(1) Revenue Desk", { timeout: 15_000 });
    if (isPhone(testInfo)) {
      await expect(
        page.getByRole("button", { name: "Open conversations, 1 approval waiting" }),
      ).toBeVisible({ timeout: 15_000 });
    }
    // A new chat does not hide it.
    await page.goto("/");
    const waiting = page.getByRole("region", { name: "Waiting for your decision" });
    await expect(waiting).toBeVisible({ timeout: 15_000 });
    await expect(waiting).toContainText("Refund a duplicate charge");
    await expect(waiting).toContainText("Refund $490.00");
    await expectAccessible(page);
    await expectNoSideScroll(page);
  });
});

test.describe("a refund Stripe declines after approval", () => {
  let harness: Harness;

  test.beforeAll(async () => {
    harness = await startHarness({
      server: "process",
      entry: "built",
      arrange: (fakes) => {
        fakes.stripe.faults.decline("/v1/refunds", {
          method: "POST",
          times: Number.POSITIVE_INFINITY,
        });
      },
    });
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test("reads 'Approved, then failed' with Stripe's reason, and Runs counts it", async ({
    page,
  }) => {
    const url = harness.url ?? "";
    await quiet(url);
    await startJob(page, /Refund a duplicate charge/, url);
    const card = await approvalCard(page);
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Approved, then failed").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Stripe: Your card was declined.").first()).toBeVisible();
    // Never a green "Approved" for it.
    await expect(page.getByText("Approved", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(/Stripe declined the refund: Your card was declined\./),
    ).toBeVisible({ timeout: 30_000 });
    await page.goto(`${url}/runs`);
    // The desktop table or the phone list, whichever is shown.
    await expect(page.getByText("1 failed").filter({ visible: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expectNoSideScroll(page);
  });
});

test.describe("a server without ANTHROPIC_API_KEY", () => {
  let harness: Harness;

  test.beforeAll(async () => {
    harness = await startHarness({
      server: "process",
      entry: "built",
      env: { ANTHROPIC_API_KEY: "" },
    });
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test("says so up front and offers no job to start", async ({ page }, testInfo) => {
    await page.goto(`${harness.url}/`);
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
});
