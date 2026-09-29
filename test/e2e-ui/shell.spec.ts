// The app around the chat, in the running app with the real configuration
// and a fresh database (playwright.config.ts): the new chat, every screen in
// light and dark, the phone layout, reduced motion, the conversation rail,
// the Runs screen, and that the browser talks to nothing but Revenue Desk.
// No test here starts a job: a run needs the real model and is in
// chat.live.spec.ts (`pnpm test:live:ui`).

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  appApi,
  expectAccessible,
  expectNoSideScroll,
  isPhone,
  openRail,
  uniqueTitle,
} from "./support.js";

const SCREENS = ["/", "/connections", "/runs", "/settings"] as const;

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

test.describe("the new chat", () => {
  test("offers the five jobs when a model key is set, and fits the screen", async ({ page }) => {
    const session = await (await appApi()).session();
    await page.goto("/");
    const jobs = page.getByRole("list", { name: "Suggested jobs" }).getByRole("button");
    await expect(jobs).toHaveCount(5);
    for (const job of await jobs.all()) {
      if (session.modelConfigured) await expect(job).toBeEnabled();
      else await expect(job).toBeDisabled();
    }
    await expect(page.getByRole("textbox", { name: "Message Revenue Desk" })).toBeVisible();
    // Without a key the app says so before anyone starts a job (see no-model-key.spec.ts).
    await expect(page.getByText("Revenue Desk can't run yet:")).toHaveCount(
      session.modelConfigured ? 0 : 1,
    );
    await expectAccessible(page);
    await expectNoSideScroll(page);
  });
});

test.describe("theme", () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate("localStorage.removeItem('revenue-desk:theme')");
  });

  test("dark mode applies to every screen, stays after a reload and keeps contrast", async ({
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
    for (const path of SCREENS) {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
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
    const api = await appApi();
    await api.expect("POST /api/conversations", { body: { title: uniqueTitle("Touch") } });
    await page.goto("/");
    await expectTouchTargets([
      page.getByRole("button", { name: "Open conversations" }),
      page.getByRole("button", { name: /^Connections: / }),
      page.getByRole("button", { name: "Send", exact: true }),
    ]);
    await expect(page.getByRole("banner").getByText("Revenue Desk", { exact: true })).toBeVisible();

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

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("transitions are instant", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCSS(
      "transition-duration",
      /^0s(, 0s)*$/,
    );
    await page.goto("/connections");
    await expect(page.getByRole("button", { name: "Check all" })).toHaveCSS(
      "transition-duration",
      /^0s(, 0s)*$/,
    );
  });
});

test.describe("conversation rail", () => {
  test("search finds a conversation by title and says when nothing matches", async ({
    page,
  }, testInfo) => {
    const api = await appApi();
    const title = uniqueTitle("Ledger review");
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
    const api = await appApi();
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
  test("a new workspace has no runs, and the screen says so", async ({ page }) => {
    const { items } = await (await appApi()).expect("GET /api/runs", { query: { limit: 1 } });
    test.skip(items.length > 0, "This database already has runs.");
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
    await expect(
      page.getByText("No runs yet. Runs appear here once you ask Revenue Desk something."),
    ).toBeVisible();
    await expectAccessible(page);
    await expectNoSideScroll(page);
  });
});

test.describe("privacy", () => {
  test("every screen loads from Revenue Desk alone, under its Content-Security-Policy", async ({
    page,
  }) => {
    const hosts = new Set<string>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
    });
    const home = await page.goto("/");
    // The page carries the policy that keeps it that way.
    expect(home?.headers()["content-security-policy"]).toContain("img-src 'self' data:");
    for (const path of SCREENS) {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
    }
    expect([...hosts]).toEqual(["127.0.0.1:4320"]);
  });
});
