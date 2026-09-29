/**
 * The Kestrel Analytics fixtures describe one coherent company: every id a
 * record names exists in its system, amounts add up across systems, every
 * address is fictional (.test), and product code never reaches the fakes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSINESS_FIXTURES_DIR, loadBusinessFixtures } from "../../support/fakes/fixtures.js";

const fixtures = loadBusinessFixtures();
const { company, stripe, hubspot, gmail, calendar } = fixtures;

describe("business fixtures: one fictional company", () => {
  it("uses only .test domains for every address and link", () => {
    for (const file of readdirSync(BUSINESS_FIXTURES_DIR)) {
      const text = readFileSync(join(BUSINESS_FIXTURES_DIR, file), "utf8");
      for (const [, domain] of text.matchAll(/[\w.+-]+@([\w.-]+)/g)) {
        expect(domain?.endsWith(".test"), `${file}: ${domain}`).toBe(true);
      }
      for (const [url] of text.matchAll(/https?:\/\/[^\s"]+/g)) {
        expect(new URL(url).hostname.endsWith(".test"), `${file}: ${url}`).toBe(true);
      }
    }
  });

  it("names each customer consistently in every system that knows it", () => {
    for (const customer of company.customers) {
      if (customer.stripeCustomer !== null) {
        expect(
          stripe.customers.find((entry) => entry.id === customer.stripeCustomer),
          customer.key,
        ).toMatchObject({
          name: customer.name,
          email: customer.contact.email,
        });
      }
      if (customer.hubspotCompany !== null) {
        expect(
          hubspot.objects.companies.find((entry) => entry.id === customer.hubspotCompany)
            ?.properties,
          customer.key,
        ).toMatchObject({
          name: customer.name,
          domain: customer.domain,
        });
      }
      if (customer.hubspotContact !== null) {
        expect(
          hubspot.objects.contacts.find((entry) => entry.id === customer.hubspotContact)?.properties
            .email,
          customer.key,
        ).toBe(customer.contact.email);
      }
      expect(customer.contact.email.endsWith(`@${customer.domain}`), customer.key).toBe(true);
    }
  });

  it("dates everything on or before the business date", () => {
    expect(company.asOf.slice(0, 10)).toBe(company.businessDate);
    const asOf = Date.parse(company.asOf) / 1000;
    for (const charge of stripe.charges)
      expect(charge.created, charge.id).toBeLessThanOrEqual(asOf);
    for (const message of gmail.messages)
      expect(Date.parse(message.date) / 1000, message.id).toBeLessThanOrEqual(asOf);
  });
});

describe("business fixtures: Stripe", () => {
  const charges = new Map(stripe.charges.map((charge) => [charge.id, charge]));

  it("links charges, invoices, subscriptions and refunds to records that exist", () => {
    const customers = new Set(stripe.customers.map((customer) => customer.id));
    const invoices = new Map(stripe.invoices.map((invoice) => [invoice.id, invoice]));
    for (const charge of stripe.charges) {
      expect(customers.has(charge.customer), charge.id).toBe(true);
      if (charge.invoice !== null)
        expect(invoices.get(charge.invoice)?.charge, charge.id).toBe(charge.id);
    }
    for (const invoice of stripe.invoices) {
      if (invoice.charge !== null)
        expect(charges.get(invoice.charge)?.invoice, invoice.id).toBe(invoice.id);
      const total = invoice.lines.reduce((sum, line) => sum + line.amount, 0);
      expect(total, invoice.id).toBe(invoice.amount_due);
    }
    for (const subscription of stripe.subscriptions) {
      expect(customers.has(subscription.customer), subscription.id).toBe(true);
      if (subscription.latest_invoice !== null)
        expect(invoices.has(subscription.latest_invoice), subscription.id).toBe(true);
    }
    expect(new Set(stripe.charges.map((charge) => charge.payment_intent)).size).toBe(
      stripe.charges.length,
    );
  });

  it("keeps each charge's amount_refunded equal to its refunds", () => {
    for (const charge of stripe.charges) {
      const refunded = stripe.refunds
        .filter((refund) => refund.charge === charge.id)
        .reduce((sum, refund) => sum + refund.amount, 0);
      expect(charge.amount_refunded ?? 0, charge.id).toBe(refunded);
    }
  });

  it("holds the J1/J2 duplicate: two equal September charges minutes apart, one without an invoice", () => {
    const september = stripe.charges.filter(
      (charge) =>
        charge.customer === "cus_KAharborpine" &&
        charge.created >= Date.parse("2026-09-22T00:00:00Z") / 1000,
    );
    expect(september.map((charge) => [charge.amount, charge.invoice === null])).toEqual([
      [49_000, false],
      [49_000, true],
    ]);
    const [first, second] = september;
    expect((second?.created ?? 0) - (first?.created ?? 0)).toBeLessThan(600);
  });
});

describe("business fixtures: HubSpot, Gmail and Calendar", () => {
  it("associates only objects and owners that exist", () => {
    const ids = new Map(
      Object.entries(hubspot.objects).map(([type, records]) => [
        type,
        new Set(records.map((record) => record.id)),
      ]),
    );
    for (const edge of hubspot.associations) {
      expect(ids.get(edge.from)?.has(edge.fromId), `${edge.from} ${edge.fromId}`).toBe(true);
      expect(ids.get(edge.to)?.has(edge.toId), `${edge.to} ${edge.toId}`).toBe(true);
    }
    const owners = new Set(hubspot.owners.map((owner) => owner.id));
    for (const records of Object.values(hubspot.objects)) {
      for (const record of records) {
        const owner = record.properties.hubspot_owner_id;
        if (owner !== undefined) expect(owners.has(owner), record.id).toBe(true);
      }
    }
    expect(hubspot.owners.some((owner) => owner.userId === hubspot.token.userId)).toBe(true);
  });

  it("holds the J4 story: the Solstice deal closed won this week with its contact and company", () => {
    const deal = hubspot.objects.deals.find((record) =>
      record.properties.dealname?.startsWith("Solstice"),
    );
    expect(deal?.properties).toMatchObject({ dealstage: "closedwon", amount: "18000" });
    expect(
      deal?.properties.closedate !== undefined && deal.properties.closedate >= "2026-09-21",
    ).toBe(true);
    const linked = hubspot.associations
      .filter((edge) => edge.from === "deals" && edge.fromId === deal?.id)
      .map((edge) => edge.to);
    expect(linked.sort()).toEqual(["companies", "contacts"]);
  });

  it("keeps Gmail threads whole: a thread id is its first message's id", () => {
    const threads = new Map<string, typeof gmail.messages>();
    for (const message of gmail.messages)
      threads.set(message.threadId, [...(threads.get(message.threadId) ?? []), message]);
    for (const [threadId, messages] of threads) {
      const first = [...messages].sort((a, b) => a.date.localeCompare(b.date))[0];
      expect(first?.id, threadId).toBe(threadId);
    }
    const labels = new Set(gmail.labels.map((label) => label.id));
    for (const message of gmail.messages)
      for (const label of message.labelIds)
        expect(labels.has(label), `${message.id} ${label}`).toBe(true);
  });

  it("schedules calendar events inside the week", () => {
    for (const event of calendar.events) {
      expect(event.start < event.end, event.id).toBe(true);
      expect(event.start >= "2026-09-28" && event.start < "2026-10-03", event.id).toBe(true);
    }
  });
});

describe("fakes stay out of product code", () => {
  it("no module under src/ imports test support", () => {
    const root = resolve(import.meta.dirname, "../../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(entry) &&
          /from\s+["'][^"']*test\/(support|fixtures|scenarios)/.test(readFileSync(path, "utf8"))
        ) {
          offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
