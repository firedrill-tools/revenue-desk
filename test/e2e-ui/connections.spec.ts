// Connections as the server really checked them (docs/ARCHITECTURE.md §9), in
// the running app with the real configuration. Each test reads the server's
// own view (GET /api/connections, once its start-up check has finished) and
// asserts that the page shows exactly that: each state in words, the missing
// variables, Connect where Composio can sign in, Check where there is
// something to check, and the app bar's count.
//
// Check is a read-only probe and is clicked. Connect starts a real Composio
// sign-in for the configured user, so it is never clicked here.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { CONNECTION_STATE_LABELS } from "../../web/src/lib/labels.js";
import {
  appApi,
  checkedConnections,
  expectAccessible,
  expectNoSideScroll,
  isPhone,
} from "./support.js";

/** One integration's row (desktop table) or item (phone list). */
function connection(page: Page, label: string, phone: boolean): Locator {
  const name = page.getByText(label, { exact: true });
  return phone
    ? page.getByRole("main").getByRole("listitem").filter({ has: name })
    : page.getByRole("main").getByRole("row").filter({ has: name });
}

async function openConnections(page: Page): Promise<void> {
  await page.goto("/connections");
  await expect(page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
}

test("every connection shows the state the server checked, and what to do next", async ({
  page,
}, testInfo) => {
  const phone = isPhone(testInfo);
  const connections = await checkedConnections(await appApi());
  expect(connections).toHaveLength(6);
  await openConnections(page);

  for (const view of connections) {
    const row = connection(page, view.label, phone);
    await expect(row, view.label).toContainText(CONNECTION_STATE_LABELS[view.state].label);

    // Connect only where Composio can start a sign-in; it is not clicked.
    const connect = row.getByRole("button", { name: "Connect", exact: true });
    if (view.canConnect) await expect(connect).toBeEnabled();
    else await expect(connect).toHaveCount(0);

    if (view.state === "not_configured" || view.state === "invalid") {
      // Nothing to check until the server is configured; the button says why.
      await expect(
        row.getByRole("button", { name: `Check ${view.label}: configure it first` }),
      ).toBeDisabled();
      for (const variable of view.missing) {
        await expect(row.getByText(variable, { exact: true })).toBeVisible();
      }
    } else {
      await expect(row.getByRole("button", { name: `Check ${view.label}` })).toBeEnabled();
    }
  }

  // The three connection kinds are explained on the page.
  await expect(page.getByText(/Composio holds each sign-in/)).toBeVisible();
  // The app bar summarises the same states.
  const connected = connections.filter((view) => view.state === "connected").length;
  await expect(
    page.getByRole("button", { name: `Connections: ${connected} of 6 connected` }),
  ).toBeVisible();

  await expectAccessible(page);
  await expectNoSideScroll(page);
});

test("Check runs the read-only probe again and the row follows the server", async ({
  page,
}, testInfo) => {
  const phone = isPhone(testInfo);
  const api = await appApi();
  const connections = await checkedConnections(api);
  const checkable = connections.filter(
    (view) => view.state !== "not_configured" && view.state !== "invalid",
  );
  test.skip(checkable.length === 0, "Nothing is configured, so there is nothing to check.");
  await openConnections(page);

  for (const view of checkable) {
    const row = connection(page, view.label, phone);
    const check = row.getByRole("button", { name: `Check ${view.label}` });
    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/connections/${view.integration}/check`) &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    );
    await check.click();
    await answered;
    await expect(check).toBeEnabled({ timeout: 60_000 });
    // The row shows what the server now says.
    const now = (await api.expect("GET /api/connections")).items.find(
      (entry) => entry.integration === view.integration,
    );
    if (now === undefined) throw new Error(`${view.integration} is missing`);
    await expect(row).toContainText(CONNECTION_STATE_LABELS[now.state].label);
    expect(now.checkedAt).not.toBeNull();
  }
});
