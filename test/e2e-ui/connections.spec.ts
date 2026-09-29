// Connections in every state (docs/ARCHITECTURE.md §9): this suite starts its
// own sandbox on the production build, with the local fakes arranged so that
// Gmail is connected; Google Calendar, QuickBooks and Slack (Composio) need
// sign-in; Stripe answers its read-only check with a 500; and HubSpot has no
// token.
// Connect runs the whole sign-in: the fake's hosted page completes it and
// sends the new tab back to the app, which checks the connection.

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ApiClient } from "../support/api-client.js";
import { type Harness, startHarness } from "../support/harness.js";
import { expectAccessible, expectNoSideScroll, isPhone } from "./support.js";

let harness: Harness;
let api: ApiClient;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  harness = await startHarness({
    server: "process",
    entry: "built",
    env: { HUBSPOT_ACCESS_TOKEN: "" },
    arrange: (fakes) => {
      fakes.composio.setConnection("googlecalendar", null);
      fakes.stripe.faults.serverError(/\/v1\/balance/, { times: Number.POSITIVE_INFINITY });
    },
  });
  if (harness.api === null || harness.url === null) throw new Error("The harness has no server");
  api = harness.api;
  await api.session();
});

test.afterAll(async () => {
  await harness?.close();
});

/** One integration's row (desktop table) or item (phone list). */
function connection(page: Page, label: string, phone: boolean): Locator {
  const name = page.getByText(label, { exact: true });
  return phone
    ? page.getByRole("main").getByRole("listitem").filter({ has: name })
    : page.getByRole("main").getByRole("row").filter({ has: name });
}

async function openConnections(page: Page): Promise<void> {
  await page.goto(`${harness.url}/connections`);
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
}

test("every connection state reads plainly: connected, sign-in, not configured, error", async ({
  page,
}, testInfo) => {
  const phone = isPhone(testInfo);
  await openConnections(page);

  const gmail = connection(page, "Gmail", phone);
  await expect(gmail).toContainText("Connected");
  await expect(gmail.getByRole("button", { name: "Check Gmail" })).toBeEnabled();
  await expect(gmail.getByRole("button", { name: "Connect" })).toHaveCount(0);

  // Composio toolkits nobody signed in to: Connect starts Composio's sign-in.
  for (const label of ["Google Calendar", "QuickBooks Online", "Slack"]) {
    const item = connection(page, label, phone);
    await expect(item).toContainText("Needs sign-in");
    await expect(item.getByRole("button", { name: "Connect" })).toBeEnabled();
  }

  const hubspot = connection(page, "HubSpot", phone);
  await expect(hubspot).toContainText("Not configured");
  await expect(hubspot.getByText("HUBSPOT_ACCESS_TOKEN", { exact: true })).toBeVisible();
  await expect(hubspot).toContainText(
    "Add these to the file DOTENV_PATH names, then restart Revenue Desk.",
  );
  // Nothing to check until the server has a token; the button says why.
  await expect(
    hubspot.getByRole("button", { name: "Check HubSpot: configure it first" }),
  ).toBeDisabled();

  const stripe = connection(page, "Stripe", phone);
  await expect(stripe).toContainText("Error");
  // A plain sentence with the next step, then Stripe's own words.
  await expect(stripe).toContainText("Stripe did not answer the check");
  await expect(stripe).toContainText("Try Check again later.");

  // The three connection kinds are explained on the page.
  await expect(page.getByText(/Composio holds each sign-in/)).toBeVisible();

  // The app bar summarises the same states.
  await expect(page.getByRole("button", { name: "Connections: 1 of 6 connected" })).toBeVisible();

  await expectAccessible(page);
  await expectNoSideScroll(page);
});

test("Check runs the read-only probe again and keeps a failing system in error", async ({
  page,
}, testInfo) => {
  const phone = isPhone(testInfo);
  await openConnections(page);
  const stripe = connection(page, "Stripe", phone);
  await stripe.getByRole("button", { name: "Check Stripe" }).click();
  await expect(stripe.getByRole("button", { name: "Check Stripe" })).toBeEnabled();
  await expect(stripe).toContainText("Error");
  const gmail = connection(page, "Gmail", phone);
  await gmail.getByRole("button", { name: "Check Gmail" }).click();
  await expect(gmail.getByRole("button", { name: "Check Gmail" })).toBeEnabled();
  await expect(gmail).toContainText("Connected");
});

test("Connect signs in in a new tab, which comes back and confirms the connection", async ({
  page,
}, testInfo) => {
  const phone = isPhone(testInfo);
  // Each project starts from a calendar that needs sign-in.
  harness.fakes.composio.setConnection("googlecalendar", null);
  await api.expect("POST /api/connections/:integration/check", {
    params: { integration: "google_calendar" },
  });
  await openConnections(page);
  const calendar = connection(page, "Google Calendar", phone);
  await expect(calendar).toContainText("Needs sign-in");

  const opened = page.context().waitForEvent("page");
  await calendar.getByRole("button", { name: "Connect" }).click();
  const signIn = await opened;
  await expect(
    page.getByText("Finish signing in in the new tab, then come back here."),
  ).toBeVisible();

  // The fake's hosted sign-in completes and redirects to /connections?connected=…,
  // where the app checks that integration and drops the parameter.
  await signIn.waitForURL(`${harness.url}/connections`, { timeout: 30_000 });
  await expect(signIn.getByText("Google Calendar is connected.")).toBeVisible({ timeout: 30_000 });
  await expect(connection(signIn, "Google Calendar", phone)).toContainText("Connected");
  const link = harness.fakes.composio.links.at(-1);
  expect(link?.toolkit).toBe("googlecalendar");
  expect(link?.completed).toBe(true);
  await signIn.close();

  // Back in the first tab, the connection is checked again when it regains focus.
  await page.bringToFront();
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByText("Google Calendar is connected.")).toBeVisible({ timeout: 30_000 });
  await expect(calendar).toContainText("Connected");
  await expect(calendar.getByRole("button", { name: "Connect" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connections: 2 of 6 connected" })).toBeVisible();
});
