// Helpers for the UI end-to-end suites: the sandbox's API for setup, the
// shared screen checks (axe, no side scroll) and a way to hold the chat
// stream so a transient state (Thinking, a running call) can be checked.

import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { ApiClient } from "../support/api-client.js";

/** The sandbox that playwright.config.ts starts (dist/server/main.js). */
export const SANDBOX_URL = "http://127.0.0.1:4320";

export const APPROVAL = /^Approval needed: /;

export function isPhone(testInfo: TestInfo): boolean {
  return testInfo.project.name === "phone-chrome";
}

/** An API client with a session (cookie and CSRF token), for setup and clean-up. */
export async function sandboxApi(baseUrl: string = SANDBOX_URL): Promise<ApiClient> {
  const api = new ApiClient(baseUrl);
  await api.session();
  return api;
}

/** A title no other test uses, so searches and archives touch only this test's rows. */
export function uniqueTitle(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Starts one of the five jobs from the empty chat's suggestions. */
export async function startJob(page: Page, title: RegExp | string, base = ""): Promise<void> {
  await page.goto(`${base}/`);
  await page
    .getByRole("list", { name: "Suggested jobs" })
    .getByRole("button", { name: title })
    .click();
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
 * Stops every run still active in the sandbox, so a test that ends at an
 * approval (or fails there) never leaves the next one at the four-run limit.
 */
export async function stopActiveRuns(baseUrl: string = SANDBOX_URL): Promise<void> {
  const api = await sandboxApi(baseUrl);
  const { items } = await api.expect("GET /api/runs", {
    query: { status: "running", limit: 50 },
  });
  for (const run of items) {
    await api.call("POST /api/runs/:runId/stop", { params: { runId: run.id } });
  }
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

// Holds the chat's response stream in the browser before (or after) the first
// SSE event that matches, until released. Installed with addInitScript; it
// wraps fetch for /api/chat only and passes every byte through unchanged.
const STREAM_HOLD = `(() => {
  const original = window.fetch.bind(window);
  const hold = { match: null, paused: false, release: null };
  window.__rdHold = hold;
  window.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.href).pathname;
    if (!/^\\/api\\/chat(\\/|$)/.test(path) || !response.body || response.status !== 200) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const body = new ReadableStream({
      async start(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer) controller.enqueue(encoder.encode(buffer));
              controller.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\\n\\n")) !== -1) {
              const event = buffer.slice(0, end + 2);
              buffer = buffer.slice(end + 2);
              if (hold.match && event.includes(hold.match)) {
                hold.match = null;
                await new Promise((resume) => {
                  hold.paused = true;
                  hold.release = () => { hold.paused = false; hold.release = null; resume(); };
                });
              }
              controller.enqueue(encoder.encode(event));
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
})();`;

/** Installs the stream hold for every page of the context (call before goto). */
export async function installStreamHold(page: Page): Promise<void> {
  await page.context().addInitScript(STREAM_HOLD);
}

/** The next SSE event containing `text` waits until releaseStream(). */
export async function holdStreamAt(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.__rdHold.match = ${JSON.stringify(text)};`);
}

export async function waitUntilHeld(page: Page): Promise<void> {
  // A function, not a string: the app's Content-Security-Policy forbids evaluating strings.
  await page.waitForFunction(
    () => (globalThis as unknown as { __rdHold?: { paused: boolean } }).__rdHold?.paused === true,
    null,
    { timeout: 30_000 },
  );
}

export async function releaseStream(page: Page): Promise<void> {
  await page.evaluate("window.__rdHold.release && window.__rdHold.release()");
}
