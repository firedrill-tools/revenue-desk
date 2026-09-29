// The chat with the real model and the real connected Gmail account, in the
// running app (`LIVE_E2E=1 pnpm test:live:ui`, desktop only). It costs money
// and reads a real mailbox, so it runs only when asked for; playwright.config.ts
// keeps no trace, screenshot or HTML report for it.
//
// - A read-only question with every write denied: tool rows while it works,
//   the answer, the inspector's calls and the run's cost, and on the server a
//   completed run in which only reads ran.
// - An action that needs approval (a Gmail draft, with internal writes set to
//   ask): the card names the recipient, is reached and denied with the
//   keyboard alone, and nothing is created.
//
// Both skip, with the reason, when Gmail is not connected; with gmail (or
// all) in LIVE_REQUIRE they fail with it instead (test/live/require.ts).

import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_POLICY } from "../../src/contracts/integration.js";
import { requiredFailure, requiredIntegrations } from "../live/require.js";
import {
  APPROVAL,
  appApi,
  checkedConnections,
  expectAccessible,
  expectNoSideScroll,
  isFocusVisible,
  tabTo,
} from "./support.js";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (process.env.LIVE_E2E !== "1") {
    throw new Error("The live chat calls the real model and reads a real mailbox: set LIVE_E2E=1.");
  }
  requiredIntegrations();
});

test.beforeEach(async () => {
  const gmail = (await checkedConnections(await appApi())).find(
    (view) => view.integration === "gmail",
  );
  if (gmail?.state === "connected") return;
  const reason = `Gmail is ${gmail?.state ?? "missing"}: click Connect in Connections to sign in.`;
  const failure = requiredFailure("gmail", reason);
  if (failure !== null) throw failure;
  test.skip(true, reason);
});

test.afterEach(async () => {
  const api = await appApi();
  const { items } = await api.expect("GET /api/runs", { query: { status: "running", limit: 50 } });
  for (const run of items) {
    await api.call("POST /api/runs/:runId/stop", { params: { runId: run.id } });
  }
  await api.expect("PATCH /api/policies", { body: { modes: { ...DEFAULT_POLICY } } });
});

async function ask(page: Page, prompt: string): Promise<string> {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message Revenue Desk" });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  return page.url().split("/c/")[1] ?? "";
}

async function onlyRun(conversationId: string) {
  const api = await appApi();
  const runs = await api.expect("GET /api/runs", { query: { conversationId, limit: 5 } });
  expect(runs.items).toHaveLength(1);
  const run = runs.items[0];
  if (run === undefined) throw new Error("no run");
  return api.expect("GET /api/runs/:runId", { params: { runId: run.id } });
}

test("a read-only question: Gmail reads, the answer, the inspector and the run's cost", async ({
  page,
}) => {
  await (await appApi()).expect("PATCH /api/policies", {
    body: { modes: { internal_write: "deny", outbound: "deny", financial: "deny" } },
  });
  const conversationId = await ask(
    page,
    "What are the three most recent emails in my inbox about? Just summarise them; don't change anything.",
  );
  // Tool rows appear while it works; the Send button returns when the run ends.
  await expect(page.locator("[data-status]").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
    timeout: 240_000,
  });
  // A completed run's line is its duration and cost (a stopped or failed one leads with that).
  await expect(page.locator('[data-slot="run-facts"]').last()).toHaveText(
    /^[\d.]+\s?m?s · <?\$[\d.]+$/,
  );
  await expect(page.getByRole("region", { name: APPROVAL })).toHaveCount(0);
  await expectAccessible(page);
  await expectNoSideScroll(page);

  await page.getByRole("button", { name: "Open inspector" }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("tab", { name: "Activity" }).click();
  await expect(inspector.getByRole("region", { name: "Composio calls" })).toContainText("Gmail");
  await inspector.getByRole("tab", { name: "Run" }).click();
  const latest = inspector.getByRole("region", { name: "Latest run" });
  await expect(latest).toContainText("Completed");
  await expect(latest).toContainText("Cost");

  // The server agrees: one completed run, and every call that ran is a read.
  const run = await onlyRun(conversationId);
  expect(run.status).toBe("completed");
  expect(run.toolCalls.filter((call) => call.status === "succeeded").length).toBeGreaterThan(0);
  expect(
    run.toolCalls
      .filter((call) => call.status === "succeeded" && call.actionClass !== "read")
      .map((call) => call.toolName),
  ).toEqual([]);
});

test("an action that needs approval: the card names it, the keyboard denies it, nothing is made", async ({
  page,
}) => {
  await (await appApi()).expect("PATCH /api/policies", {
    body: { modes: { internal_write: "ask", outbound: "deny", financial: "deny" } },
  });
  const recipient = "revenue-desk-ui-test@example.com";
  const conversationId = await ask(
    page,
    `Create a Gmail draft to ${recipient} with the subject "Revenue Desk UI test" and the body "Test." Do not send it.`,
  );
  const card = page.getByRole("region", { name: APPROVAL });
  await expect(card).toBeVisible({ timeout: 180_000 });
  await expect(card).toContainText(recipient);
  await expectAccessible(page);

  // From the composer, back into the card with the keyboard alone.
  const deny = card.getByRole("button", { name: "Deny" });
  await page.getByRole("textbox", { name: "Message Revenue Desk" }).focus();
  await tabTo(page, deny, { backwards: true });
  expect(await isFocusVisible(deny)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
    timeout: 240_000,
  });
  await expect(page.getByText("Denied", { exact: true }).first()).toBeVisible();

  // The server agrees: the draft was asked for and denied; no write ran.
  const run = await onlyRun(conversationId);
  expect(run.approvals.map((approval) => approval.status)).toContain("denied");
  expect(
    run.toolCalls
      .filter((call) => call.status === "succeeded" && call.actionClass !== "read")
      .map((call) => call.toolName),
  ).toEqual([]);
});
