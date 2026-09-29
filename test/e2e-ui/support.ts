// Helpers for the UI end-to-end suites: the running app's own API for setup
// and for the truth a page must show, and the shared screen checks (axe, no
// side scroll, keyboard focus).

import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ConnectionView } from "../../src/contracts/api.js";
import { ApiClient } from "../support/api-client.js";
import { E2E_PORT } from "./port.js";

/** The app that playwright.config.ts starts (dist/server/main.js with the real configuration). */
export const APP_URL = `http://127.0.0.1:${E2E_PORT}`;

export const APPROVAL = /^Approval needed: /;

export function isPhone(testInfo: TestInfo): boolean {
  return testInfo.project.name === "phone-chrome";
}

/** An API client with a session (cookie and CSRF token), as a browser tab has one. */
export async function appApi(baseUrl: string = APP_URL): Promise<ApiClient> {
  const api = new ApiClient(baseUrl);
  await api.session();
  return api;
}

/** A title no other test uses, so searches and archives touch only this test's rows. */
export function uniqueTitle(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The connections once the server's start-up check has finished: every
 * configured integration has left "unknown" (not checked yet).
 */
export async function checkedConnections(api: ApiClient): Promise<readonly ConnectionView[]> {
  let connections: readonly ConnectionView[] = [];
  await expect
    .poll(
      async () => {
        connections = (await api.expect("GET /api/connections")).items;
        return connections.filter((connection) => connection.state === "unknown").length;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(0);
  return connections;
}

export async function expectNoSideScroll(page: Page): Promise<void> {
  // A string, not a function: test code is type-checked without the DOM library.
  const overflow = Number(
    await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    ),
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The part of the DOM settleAnimations reads (test code is type-checked without the DOM library). */
type AnimationsDocument = {
  getAnimations(): {
    readonly effect: { getTiming(): { readonly iterations?: number } } | null;
    readonly playState: string;
  }[];
};

/** Waits for enter animations (a sheet fading in) to end; endless ones (spinners) are ignored. */
export async function settleAnimations(page: Page): Promise<void> {
  // A function, not a string: the app's Content-Security-Policy forbids evaluating strings.
  await page.waitForFunction(
    () =>
      (globalThis as unknown as { document: AnimationsDocument }).document
        .getAnimations()
        .every(
          (animation) =>
            animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY ||
            animation.playState !== "running",
        ),
    null,
    { timeout: 5_000 },
  );
}

/** axe finds no serious or critical violation on the page once it has settled. */
export async function expectAccessible(page: Page): Promise<void> {
  await settleAnimations(page);
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
}

/**
 * The conversation list: the left rail on desktop, the navigation sheet
 * (opened here) on a phone.
 */
export async function openRail(page: Page, phone: boolean): Promise<Locator> {
  if (!phone) return page.getByRole("complementary", { name: "Conversations" });
  await page.getByRole("button", { name: "Open conversations" }).click();
  const sheet = page.getByRole("dialog", { name: "Navigation" });
  await expect(sheet).toBeVisible();
  await settleAnimations(page);
  return sheet;
}

/** Whether `locator` holds the keyboard focus. */
export async function isFocused(locator: Locator): Promise<boolean> {
  // Typed structurally: test code is type-checked without the DOM library.
  return locator.evaluate(
    (element: { ownerDocument: { activeElement: unknown } }) =>
      element === element.ownerDocument.activeElement,
  );
}

/** Whether the focus ring is showing on `locator` (:focus-visible). */
export async function isFocusVisible(locator: Locator): Promise<boolean> {
  return locator.evaluate((element: { matches(selector: string): boolean }) =>
    element.matches(":focus-visible"),
  );
}

/**
 * Presses Tab (or Shift+Tab) until `target` has the focus; fails after
 * `limit` presses. Returns how many presses it took.
 */
export async function tabTo(
  page: Page,
  target: Locator,
  options: { readonly backwards?: boolean; readonly limit?: number } = {},
): Promise<number> {
  const key = options.backwards ? "Shift+Tab" : "Tab";
  const limit = options.limit ?? 80;
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press(key);
    if (await isFocused(target)) return presses;
  }
  throw new Error(`${key} did not reach the target in ${limit} presses`);
}
