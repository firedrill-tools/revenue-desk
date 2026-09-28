/**
 * Facts of the Kestrel Analytics fixtures that the scripts use, named once.
 * test/unit/scenarios/scenarios.test.ts checks every one against
 * test/fixtures/business, so a fixture edit cannot silently break a script.
 */
import { createHash } from "node:crypto";

export const BUSINESS_DATE = "2026-09-28";
export const NOW_ISO = "2026-09-28T13:00:00Z";
export const DIGEST_FROM = "2026-09-21";

export const MAYA = { email: "maya@kestrel.test", hubspotOwner: "71003" } as const;
export const JORDAN = { email: "jordan@kestrel.test", hubspotOwner: "71001" } as const;

export const HARBOR_PINE = {
  name: "Harbor & Pine Outfitters",
  contactEmail: "dana@harborpine.test",
  gmailThread: "199a1e0c4b7f2001",
  stripeCustomer: "cus_KAharborpine",
  paidCharge: "ch_KAhp_0922a",
  duplicateCharge: "ch_KAhp_0922b",
  chargeAmountMinor: 49_000,
  quickbooksCustomer: "58",
  hubspotCompany: "30011001",
  hubspotContact: "51011001",
} as const;

export const COPPERLEAF = {
  name: "Copperleaf Studios",
  contactEmail: "theo@copperleaf.test",
  reminderThread: "198cb2d7e9f05005",
  invoice: "1043",
  hubspotCompany: "30011002",
  hubspotContact: "51011002",
} as const;

export const TIDEWATER = {
  contactEmail: "omar@tidewater.test",
  gmailThread: "1990d6a2c3e41002",
  invoice: "1048",
} as const;

export const MERIDIAN = { invoice: "1051", unrecordedCharge: "ch_KAmer_0910" } as const;

export const BLUEFIN = { contactEmail: "lena@bluefin.test", invoice: "1055" } as const;

export const SOLSTICE = {
  name: "Solstice Energy Cooperative",
  contactEmail: "marco@solstice.test",
  givenName: "Marco",
  familyName: "Bellini",
  hubspotDeal: "90011004",
  hubspotContact: "51011007",
  quickbooksItem: "3",
  amountMinor: 1_800_000,
  dueDate: "2026-10-28",
  /** The ids the QuickBooks fake gives the first new customer and invoice. */
  expectedCustomerId: "68",
  expectedInvoiceId: "158",
  expectedDocNumber: "1058",
} as const;

/** The Idempotency-Key / requestid of a write: hex sha256 of `${runId}:${toolUseId}` (docs/ARCHITECTURE.md §5). */
export function expectedIdempotencyKey(runId: string, toolUseId: string): string {
  return createHash("sha256").update(`${runId}:${toolUseId}`).digest("hex");
}

/** Collects verification problems with a terse API. */
export class Checks {
  readonly problems: string[] = [];

  that(condition: boolean, message: string): this {
    if (!condition) this.problems.push(message);
    return this;
  }

  equal<T>(actual: T, expected: T, message: string): this {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) this.problems.push(`${message}: expected ${e}, got ${a}`);
    return this;
  }
}

/** The first line of a tool result, for the model's replies. */
export function firstLine(text: string | undefined): string {
  return (text ?? "no result").split("\n")[0]?.slice(0, 300) ?? "";
}
