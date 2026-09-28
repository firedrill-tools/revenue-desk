import { describe, expect, it } from "vitest";
import { canonical, parseStripeParams } from "../../support/fakes/stripe/form.js";

const parse = (query: string) => parseStripeParams(new URLSearchParams(query));

describe("Stripe bracket-syntax parameters", () => {
  it("parses flat, nested, appended and indexed parameters", () => {
    expect(
      parse(
        "charge=ch_1&metadata[order]=6735&metadata[note]=a%20b&expand[]=charge&expand[]=payment_intent&items[0][price]=p1&items[1][price]=p2&created[gte]=10",
      ),
    ).toEqual({
      ok: true,
      params: {
        charge: "ch_1",
        metadata: { order: "6735", note: "a b" },
        expand: ["charge", "payment_intent"],
        items: [{ price: "p1" }, { price: "p2" }],
        created: { gte: "10" },
      },
    });
  });

  it("refuses a key that is both a value and a hash", () => {
    expect(parse("metadata=x&metadata[a]=1")).toMatchObject({ ok: false, param: "metadata" });
    expect(parse("expand[]=a&expand[b]=c")).toMatchObject({ ok: false, param: "expand" });
  });

  it("renders a canonical, order-independent fingerprint", () => {
    const first = parse("a=1&metadata[x]=1&metadata[y]=2");
    const second = parse("metadata[y]=2&a=1&metadata[x]=1");
    if (!first.ok || !second.ok) throw new Error("parse failed");
    expect(canonical(first.params)).toBe(canonical(second.params));
    expect(canonical(first.params)).not.toBe(canonical({ a: "2" }));
  });
});
