// The live write suite's QuickBooks guard (test/live/writes/quickbooks-sandbox.ts):
// the write test runs only when every active QuickBooks account uses Intuit's
// sandbox server, judged by the account's base URL value, never by text that
// merely mentions the sandbox.

import { describe, expect, it } from "vitest";
import {
  QUICKBOOKS_PRODUCTION_URL,
  QUICKBOOKS_SANDBOX_URL,
  quickBooksWriteRefusal,
} from "../live/writes/quickbooks-sandbox.js";

const account = (baseUrl: string) => ({
  id: "ca_placeholder",
  status: "ACTIVE",
  state: { authScheme: "OAUTH2", val: { full: baseUrl, generic_id: "75" } },
});

describe("quickBooksWriteRefusal", () => {
  it("allows writes when every active account uses the sandbox server", () => {
    expect(quickBooksWriteRefusal([account(QUICKBOOKS_SANDBOX_URL)])).toBeNull();
    expect(
      quickBooksWriteRefusal([
        account(`${QUICKBOOKS_SANDBOX_URL}/`),
        account(`${QUICKBOOKS_SANDBOX_URL}/v3`),
      ]),
    ).toBeNull();
  });

  it("refuses a real company, or any real company beside a sandbox one", () => {
    expect(quickBooksWriteRefusal([account(QUICKBOOKS_PRODUCTION_URL)])).toMatch(/^Refused: /);
    expect(
      quickBooksWriteRefusal([account(QUICKBOOKS_SANDBOX_URL), account(QUICKBOOKS_PRODUCTION_URL)]),
    ).toMatch(/^Refused: /);
  });

  it("refuses when no account says which server it uses, or there is none", () => {
    expect(quickBooksWriteRefusal([{ id: "ca_placeholder", status: "ACTIVE" }])).toMatch(
      /^Refused: /,
    );
    expect(quickBooksWriteRefusal([])).toBe(
      "Refused: the Composio user has no active QuickBooks account.",
    );
  });

  it("is not fooled by text that only mentions the sandbox", () => {
    const described = {
      ...account(QUICKBOOKS_PRODUCTION_URL),
      note: `Keep the default ${QUICKBOOKS_PRODUCTION_URL} for real company data; use ${QUICKBOOKS_SANDBOX_URL} only for testing.`,
    };
    expect(quickBooksWriteRefusal([described])).toMatch(/^Refused: /);
    const mentionOnly = {
      id: "ca_placeholder",
      description: `use ${QUICKBOOKS_SANDBOX_URL} only for testing`,
    };
    expect(quickBooksWriteRefusal([mentionOnly])).toMatch(/^Refused: /);
  });
});
