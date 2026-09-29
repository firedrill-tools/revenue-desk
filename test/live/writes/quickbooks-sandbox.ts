/**
 * The QuickBooks write test's guard: it writes only when every active
 * QuickBooks account of the Composio user is connected to Intuit's sandbox
 * server, so a real company is never written to. The base URL must be a
 * value of the account (a connection field such as "Base URL"), not text
 * that merely mentions the sandbox (Composio's own field description names
 * both servers). No imports with side effects: a unit test checks it.
 */
import type { JsonValue } from "../../../src/contracts/json.js";

export const QUICKBOOKS_SANDBOX_URL = "https://sandbox-quickbooks.api.intuit.com";
export const QUICKBOOKS_PRODUCTION_URL = "https://quickbooks.api.intuit.com";

function strings(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function isServer(value: string, server: string): boolean {
  const url = value.replace(/\/+$/, "");
  return url === server || url.startsWith(`${server}/`);
}

/**
 * Why the QuickBooks write test must not run against these active accounts,
 * or null when every one of them uses the sandbox server.
 */
export function quickBooksWriteRefusal(activeAccounts: readonly JsonValue[]): string | null {
  if (activeAccounts.length === 0) {
    return "Refused: the Composio user has no active QuickBooks account.";
  }
  for (const account of activeAccounts) {
    const values = strings(account);
    const sandbox = values.some((value) => isServer(value, QUICKBOOKS_SANDBOX_URL));
    const production = values.some((value) => isServer(value, QUICKBOOKS_PRODUCTION_URL));
    if (!sandbox || production) {
      return `Refused: an active QuickBooks account does not use ${QUICKBOOKS_SANDBOX_URL}, so it may be a real company.`;
    }
  }
  return null;
}
