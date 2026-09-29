/**
 * Direct access to the real services for the live write tests' own setup,
 * checks and clean-up: the Composio SDK for the connected accounts, and the
 * Stripe and HubSpot REST APIs with the configured keys. The agent's actions
 * themselves always go through Revenue Desk (the headless CLI); these helpers
 * only prepare a test-safe target, confirm what the agent did and remove it.
 * Keys are never printed.
 */
import { Composio } from "@composio/core";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import { liveValue } from "../support.js";

// ---------------------------------------------------------------------------
// Composio (the connected Gmail, QuickBooks and Slack accounts)
// ---------------------------------------------------------------------------

let composio: Composio | undefined;

function composioClient(): Composio {
  const apiKey = liveValue("COMPOSIO_API_KEY");
  if (apiKey === null) throw new Error("COMPOSIO_API_KEY is not set in the live env file.");
  const baseURL = liveValue("COMPOSIO_BASE_URL");
  composio ??= new Composio({
    apiKey,
    ...(baseURL === null ? {} : { baseURL }),
    disableVersionCheck: true,
    allowTracking: false,
  });
  return composio;
}

export function composioUserId(): string {
  const userId = liveValue("COMPOSIO_USER_ID");
  if (userId === null) throw new Error("COMPOSIO_USER_ID is not set in the live env file.");
  return userId;
}

/** Runs one Composio tool for the configured user; throws on failure without the payload. */
export async function composioTool(slug: string, args: JsonObject): Promise<JsonValue> {
  const result = await composioClient().tools.execute(slug, {
    userId: composioUserId(),
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) throw new Error(`${slug} failed: ${result.error ?? "no reason given"}`);
  return result.data as JsonValue;
}

/** The connected accounts of one toolkit for the configured user, as JSON (never printed). */
export async function connectedAccounts(toolkit: string): Promise<readonly JsonValue[]> {
  const page = await composioClient().connectedAccounts.list({
    userIds: [composioUserId()],
    toolkitSlugs: [toolkit],
    statuses: ["ACTIVE"],
  });
  return JSON.parse(JSON.stringify(page.items)) as JsonValue[];
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function isArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** The first string under any of `keys`, searching the whole value. */
export function findString(value: JsonValue | undefined, keys: readonly string[]): string | null {
  if (isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct !== "") return direct;
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found !== null) return found;
  }
  return null;
}

/** Every object inside `value` (itself included) whose JSON contains `marker`. */
export function objectsMentioning(value: JsonValue | undefined, marker: string): JsonObject[] {
  const found: JsonObject[] = [];
  const walk = (node: JsonValue | undefined) => {
    if (isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      if (JSON.stringify(node).includes(marker)) found.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return found;
}

// ---------------------------------------------------------------------------
// Stripe (test mode only)
// ---------------------------------------------------------------------------

/** The configured key when it is a test-mode key; null otherwise. Never printed. */
export function stripeTestKey(): string | null {
  const key = liveValue("STRIPE_SECRET_KEY");
  return key !== null && /^(sk|rk)_test_/.test(key) ? key : null;
}

export async function stripeApi(
  method: "GET" | "POST" | "DELETE",
  path: string,
  form: Readonly<Record<string, string>> = {},
): Promise<JsonObject> {
  const key = stripeTestKey();
  if (key === null) throw new Error("Refusing: STRIPE_SECRET_KEY is not a test-mode key.");
  const base = liveValue("STRIPE_API_BASE_URL") ?? "https://api.stripe.com";
  const body = new URLSearchParams(form).toString();
  const url = method === "GET" && body !== "" ? `${base}${path}?${body}` : `${base}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    ...(method === "POST" ? { body } : {}),
  });
  const json = (await response.json()) as JsonObject;
  if (!response.ok) {
    const error = json.error as JsonObject | undefined;
    throw new Error(
      `Stripe ${method} ${path} answered ${response.status}: ${String(error?.message)}`,
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// HubSpot (a developer test or sandbox account only)
// ---------------------------------------------------------------------------

/** Account types HubSpot reports for accounts made for testing. */
export const HUBSPOT_TEST_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "DEVELOPER_TEST",
  "SANDBOX",
]);

export async function hubspotApi(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonObject,
): Promise<JsonObject | null> {
  const token = liveValue("HUBSPOT_ACCESS_TOKEN");
  if (token === null) throw new Error("HUBSPOT_ACCESS_TOKEN is not set in the live env file.");
  const base = liveValue("HUBSPOT_API_BASE_URL") ?? "https://api.hubapi.com";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  const json = (await response.json()) as JsonObject;
  if (!response.ok) {
    throw new Error(
      `HubSpot ${method} ${path} answered ${response.status}: ${String(json.message)}`,
    );
  }
  return json;
}
