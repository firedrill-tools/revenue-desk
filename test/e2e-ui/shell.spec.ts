// The app around the chat: theme, reduced motion, the conversation rail
// (search, archive), the Runs screen with its detail sheet, and how an
// answer's table reads. Against the shared sandbox (playwright.config.ts).

import { expect, type Locator, type Page, test } from "@playwright/test";
import { J5_PROMPT } from "../scenarios/j5-weekly-digest.js";
import {
  APPROVAL,
  expectAccessible,
  expectNoSideScroll,
  holdStreamAt,
  installStreamHold,
  isPhone,
  openRail,
  releaseStream,
  sandboxApi,
  startJob,
  stopActiveRuns,
  uniqueTitle,
  waitUntilHeld,
} from "./support.js";

test.afterEach(async () => {
  await stopActiveRuns();
});

/** The page background's relative luminance (0 black, 1 white). */
async function backgroundLuminance(page: Page): Promise<number> {
  const color = String(await page.evaluate("getComputedStyle(document.body).backgroundColor"));
  const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const [r, g, b] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test.describe("theme", () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate("localStorage.removeItem('revenue-desk:theme')");
  });

  test("dark mode applies everywhere, stays after a reload and keeps contrast", async ({
    page,
  }, testInfo) => {
    const phone = isPhone(testInfo);
    await page.goto("/");
    expect(await backgroundLuminance(page)).toBeGreaterThan(0.9);
    // On phones the toggle lives in the navigation sheet.
    const scope = phone ? await openRail(page, true) : page.getByRole("banner");
    await scope.getByRole("button", { name: "Switch to dark theme" }).click();
    if (phone) await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    expect(await backgroundLuminance(page)).toBeLessThan(0.05);

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    // A financial approval card: the danger action and the facts keep their contrast.
    await startJob(page, /Refund a duplicate charge/);
    const card = page.getByRole("region", { name: APPROVAL });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page);
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    for (const path of ["/connections", "/runs", "/settings"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectAccessible(page);
      await expectNoSideScroll(page);
    }

    const back = phone ? await openRail(page, true) : page.getByRole("banner");
    await back.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  });
});

test.describe("phone ergonomics", () => {
  /** Every locator is at least 44px square and inside the 390px screen. */
  async function expectTouchTargets(locators: readonly Locator[]): Promise<void> {
    for (const locator of locators) {
      const box = await locator.boundingBox();
      if (box === null) throw new Error(`${locator} is not on screen`);
      expect.soft(box.height, `${locator} height`).toBeGreaterThanOrEqual(44);
      expect.soft(box.width, `${locator} width`).toBeGreaterThanOrEqual(44);
      expect.soft(box.x, `${locator} left`).toBeGreaterThanOrEqual(0);
      expect.soft(box.x + box.width, `${locator} right`).toBeLessThanOrEqual(390);
    }
  }

  test("controls are 44px touch targets and the app bar fits", async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), "Touch targets are a phone requirement.");
    await startJob(page, /Answer a billing inquiry/);
    const card = page.getByRole("region", { name: APPROVAL });
    await expect(card.getByRole("button", { name: "Approve" })).toBeEnabled({ timeout: 30_000 });
    await expectTouchTargets([
      page.getByRole("button", { name: "Open conversations" }),
      page.getByRole("button", { name: /^Connections: / }),
      page.getByRole("button", { name: "Open inspector" }),
      card.getByRole("button", { name: "Add a note" }),
      card.getByRole("button", { name: "Deny" }),
      card.getByRole("button", { name: "Approve" }),
      page.getByRole("button", { name: /^Checked \d+ sources/ }),
      page.getByRole("button", { name: /^Create Gmail draft/ }),
      page.getByRole("button", { name: "Stop" }),
    ]);
    await expect(page.getByRole("banner").getByText("Revenue Desk", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("banner").getByText("Local sandbox", { exact: true }),
    ).toBeVisible();

    // The navigation sheet: one row of screens, the theme, and each conversation's actions.
    const rail = await openRail(page, true);
    const links = rail.getByRole("navigation", { name: "Primary" }).getByRole("link");
    await expect(links).toHaveCount(4);
    await expectTouchTargets(await links.all());
    const tops = await Promise.all(
      (await links.all()).map(async (link) => (await link.boundingBox())?.y),
    );
    expect(new Set(tops).size).toBe(1);
    await expectTouchTargets([
      rail.getByRole("button", { name: "Switch to dark theme" }),
      rail.getByRole("button", { name: "Close" }),
      rail.getByRole("button", { name: "New chat" }),
      rail.getByRole("button", { name: /^Actions for / }).first(),
    ]);
    await page.keyboard.press("Escape");

    await page.goto("/settings");
    const financial = page.getByRole("group", { name: "Financial actions" });
    await expectTouchTargets(await financial.locator("label").all());
  });
});

test.describe("motion", () => {
  /** Holds the reply before its first event, so the Thinking line shows; returns its text. */
  async function showThinking(page: Page): Promise<Locator> {
    await installStreamHold(page);
    await page.goto("/");
    await holdStreamAt(page, '"type":"start"');
    await page
      .getByRole("list", { name: "Suggested jobs" })
      .getByRole("button", { name: /Answer a billing inquiry/ })
      .click();
    await waitUntilHeld(page);
    const status = page.getByRole("status").filter({ hasText: "Thinking" });
    await expect(status).toBeVisible();
    return status.locator(".rd-shimmer");
  }

  async function letItFinish(page: Page): Promise<void> {
    await releaseStream(page);
    await expect(page.getByRole("region", { name: APPROVAL })).toBeVisible({ timeout: 30_000 });
  }

  test("the Thinking line shimmers by default", async ({ page }) => {
    const shimmer = await showThinking(page);
    await expect(shimmer).toHaveCSS("animation-name", "rd-shimmer");
    await letItFinish(page);
  });

  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("the Thinking line holds still and transitions are instant", async ({ page }) => {
      const shimmer = await showThinking(page);
      await expect(shimmer).toHaveCSS("animation-name", "none");
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCSS(
        "transition-duration",
        /^0s(, 0s)*$/,
      );
      await letItFinish(page);
      // The approval card appears without an enter animation, and stays readable.
      const card = page.getByRole("region", { name: APPROVAL });
      await expect(card.getByRole("button", { name: "Approve" })).toHaveCSS(
        "transition-duration",
        /^0s(, 0s)*$/,
      );
      await expectAccessible(page);
    });
  });
});

test.describe("conversation rail", () => {
  test("search finds a conversation by title and says when nothing matches", async ({
    page,
  }, testInfo) => {
    const api = await sandboxApi();
    const title = uniqueTitle("Kiwi ledger");
    await api.expect("POST /api/conversations", { body: { title } });
    await page.goto("/");
    const rail = await openRail(page, isPhone(testInfo));
    const search = rail.getByRole("searchbox", { name: "Search conversations" });

    await search.fill(title);
    const rows = rail.getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(title);

    await search.fill(`${title} no such words`);
    await expect(rail.getByText("No conversations match.")).toBeVisible();
    await expect(rows).toHaveCount(0);

    await search.fill("");
    await expect(rail.getByRole("link", { name: new RegExp(title) })).toBeVisible();
    await expectNoSideScroll(page);
  });

  test("archiving the open conversation removes it and returns to a new chat", async ({
    page,
  }, testInfo) => {
    const api = await sandboxApi();
    const title = uniqueTitle("Archive me");
    const { conversation } = await api.expect("POST /api/conversations", { body: { title } });
    await page.goto(`/c/${conversation.id}`);
    const rail = await openRail(page, isPhone(testInfo));
    await rail.getByRole("button", { name: `Actions for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("Conversation archived.")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("list", { name: "Suggested jobs" })).toBeVisible();

    // Archived conversations are not listed or found.
    const again = await openRail(page, isPhone(testInfo));
    await again.getByRole("searchbox", { name: "Search conversations" }).fill(title);
    await expect(again.getByText("No conversations match.")).toBeVisible();
    const stored = await api.expect("GET /api/conversations/:conversationId", {
      params: { conversationId: conversation.id },
    });
    expect(stored.conversation.archivedAt).not.toBeNull();
  });
});

test.describe("runs", () => {
  test("the runs list names each run's conversation and opens its detail", async ({
    page,
  }, testInfo) => {
    const phone = isPhone(testInfo);
    // A finished run to find: the weekly digest posts without asking.
    const api = await sandboxApi();
    const title = uniqueTitle("Weekly digest");
    const { conversation } = await api.expect("POST /api/conversations", { body: { title } });
    await api.chat(conversation.id, J5_PROMPT);

    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
    const entry = phone
      ? page.getByRole("main").getByRole("button").filter({ hasText: title })
      : page.getByRole("main").getByRole("row").filter({ hasText: title });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Completed");
    await expectAccessible(page);
    await expectNoSideScroll(page);

    await entry.click();
    await expect(page).toHaveURL(/\/runs\/[^/]+$/);
    const detail = page.getByRole("dialog", { name: `Run: ${title}` });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Completed");
    await expect(detail).toContainText("Tool calls");
    await expect(detail).toContainText(/in Slack/);
    await expect(detail).toContainText("Approval policy");
    await expectAccessible(page);
    await expectNoSideScroll(page);

    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(page).toHaveURL(/\/runs$/);

    await entry.click();
    await page
      .getByRole("dialog", { name: `Run: ${title}` })
      .getByRole("link", { name: "Open conversation" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/c/${conversation.id}$`));
    await expect(page.getByText(J5_PROMPT, { exact: true })).toBeVisible();
  });
});

test.describe("answers", () => {
  test("numeric table columns line up on the right", async ({ page }) => {
    // The scripted jobs answer without tables, so this answer is streamed by the test.
    const table = [
      "| Customer | Invoice | Amount due | Days overdue | Note |",
      "|---|---|---|---|---|",
      "| Copperleaf Studios | 1043 | $3,600.00 | 70 | Call booked |",
      "| Tidewater Logistics | 1048 | $2,400.00 | 34 | – |",
      "| Bluefin Dental Group | 1055 | $750.00 | 8 | Partial payment |",
    ].join("\n");
    const chunks = [
      { type: "start", messageId: "msg_table" },
      { type: "start-step" },
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: `Overdue invoices:\n\n${table}\n` },
      { type: "text-end", id: "text_1" },
      { type: "finish-step" },
      { type: "finish", finishReason: "stop" },
    ];
    await page.route("**/api/chat", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
            body: `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          })
        : route.continue(),
    );
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message Revenue Desk" });
    await composer.fill("Show the overdue invoices as a table");
    await composer.press("Enter");
    const answer = page.getByRole("table");
    await expect(answer).toBeVisible({ timeout: 30_000 });

    const cell = (text: string) => answer.getByRole("cell", { name: text, exact: true });
    const header = (text: string) => answer.getByRole("columnheader", { name: text, exact: true });
    await expect(cell("$3,600.00")).toHaveCSS("text-align", "right");
    await expect(header("Amount due")).toHaveCSS("text-align", "right");
    await expect(cell("70")).toHaveCSS("text-align", "right");
    await expect(cell("1043")).toHaveCSS("text-align", "right");
    // Text columns stay on the left, including one with a dash for "nothing".
    await expect(cell("Copperleaf Studios")).not.toHaveCSS("text-align", "right");
    await expect(header("Note")).not.toHaveCSS("text-align", "right");
    await expect(cell("Call booked")).not.toHaveCSS("text-align", "right");
    await expectNoSideScroll(page);
  });
});
