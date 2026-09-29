import { describe, expect, it } from "vitest";
import { abortable } from "../../../src/integrations/shared/abort.js";
import {
  domainOf,
  isInternalAddress,
  parseAddress,
} from "../../../src/integrations/shared/email.js";
import {
  currencyExponent,
  decimalToMinor,
  formatMoney,
  minorToDecimal,
} from "../../../src/integrations/shared/money.js";
import { unixSeconds } from "../../../src/integrations/shared/schema.js";
import {
  listOf,
  maskIdentifier,
  preview,
  scrub,
  sentence,
} from "../../../src/integrations/shared/text.js";
import { checkBaseUrl, isLoopbackHost, joinUrl } from "../../../src/integrations/shared/url.js";

describe("base URLs", () => {
  it("keeps a path prefix when joining", () => {
    expect(joinUrl("https://api.stripe.com", "/v1/charges")).toBe(
      "https://api.stripe.com/v1/charges",
    );
    expect(
      joinUrl("https://proxy.example/stripe/", "/v1/charges", { limit: 10, email: undefined }),
    ).toBe("https://proxy.example/stripe/v1/charges?limit=10");
    expect(joinUrl("https://x.test/a/b", "c/d", new URLSearchParams({ q: "a b" }))).toBe(
      "https://x.test/a/b/c/d?q=a+b",
    );
  });

  it("requires https, and refuses credentials, queries and fragments", () => {
    expect(checkBaseUrl("https://api.stripe.com/")).toEqual({
      ok: true,
      url: "https://api.stripe.com",
      host: "api.stripe.com",
    });
    expect(checkBaseUrl("https://proxy.example:8443/prefix/")).toEqual({
      ok: true,
      url: "https://proxy.example:8443/prefix",
      host: "proxy.example:8443",
    });
    for (const url of ["http://127.0.0.1:4555/prefix/", "http://localhost:1", "http://[::1]:2"]) {
      expect(checkBaseUrl(url)).toEqual({ ok: false, message: "must use https" });
    }
    expect(checkBaseUrl("http://api.stripe.com")).toMatchObject({ ok: false });
    expect(checkBaseUrl("ftp://api.stripe.com")).toMatchObject({ ok: false });
    expect(checkBaseUrl("https://user:pw@api.stripe.com")).toMatchObject({ ok: false });
    expect(checkBaseUrl("https://api.stripe.com?x=1")).toMatchObject({ ok: false });
    expect(checkBaseUrl("https://api.stripe.com#x")).toMatchObject({ ok: false });
    expect(checkBaseUrl("not a url")).toMatchObject({ ok: false });
  });

  it("accepts plain http on loopback only for a server on this machine, when asked", () => {
    const local = { allowLoopbackHttp: true };
    expect(checkBaseUrl("http://127.0.0.1:4555/mcp/", local)).toEqual({
      ok: true,
      url: "http://127.0.0.1:4555/mcp",
      host: "127.0.0.1:4555",
    });
    expect(checkBaseUrl("http://localhost:1/mcp", local)).toMatchObject({ ok: true });
    expect(checkBaseUrl("http://[::1]:2/mcp", local)).toMatchObject({ ok: true });
    expect(checkBaseUrl("http://mcp.example/mcp", local)).toEqual({
      ok: false,
      message: "must use https (plain http is accepted only for a server on this machine)",
    });
  });

  it("recognises loopback hosts only", () => {
    for (const host of ["localhost", "a.localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["api.stripe.com", "localhost.evil.test", "10.0.0.1", "128.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("money", () => {
  it("formats minor units at the currency's precision", () => {
    expect(formatMoney({ amountMinor: 4900, currency: "USD" })).toBe("$49.00");
    expect(formatMoney({ amountMinor: 120_050, currency: "EUR" })).toBe("€1,200.50");
    expect(formatMoney({ amountMinor: 5000, currency: "JPY" })).toBe("¥5,000");
    expect(formatMoney({ amountMinor: 1234, currency: "KWD" })).toMatch(/^KWD\s1\.234$/);
  });

  it("converts between decimals and minor units without float drift", () => {
    expect(currencyExponent("usd")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("XX")).toBeNull();
    expect(decimalToMinor(49.99, "USD")).toBe(4999);
    expect(decimalToMinor(0.29, "USD")).toBe(29);
    expect(decimalToMinor(1.005, "USD")).toBe(100);
    expect(decimalToMinor(5000, "JPY")).toBe(5000);
    expect(minorToDecimal(4999, "USD")).toBe(49.99);
    expect(minorToDecimal(1, "USD")).toBe(0.01);
    expect(minorToDecimal(5000, "JPY")).toBe(5000);
  });
});

describe("email addresses", () => {
  it("parses bare and display-name forms, lower-cased", () => {
    expect(parseAddress("Ana@Acme.test")).toBe("ana@acme.test");
    expect(parseAddress("Ana Diaz <ana@acme.test>")).toBe("ana@acme.test");
    expect(parseAddress('"Diaz, Ana" <ana@acme.test>')).toBe("ana@acme.test");
    expect(parseAddress("Ana Diaz")).toBeNull();
    expect(parseAddress("a@b")).toBeNull();
    expect(parseAddress("a@b.test, c@d.test")).toBeNull();
    expect(domainOf("ana@acme.test")).toBe("acme.test");
  });

  it("treats internal domains and their subdomains as internal", () => {
    const internal = ["Contoso.example", "@ops.example"];
    expect(isInternalAddress("ana@contoso.example", internal)).toBe(true);
    expect(isInternalAddress("ana@eu.contoso.example", internal)).toBe(true);
    expect(isInternalAddress("bo@ops.example", internal)).toBe(true);
    expect(isInternalAddress("ana@notcontoso.example", internal)).toBe(false);
    expect(isInternalAddress("ana@contoso.example.evil", internal)).toBe(false);
    expect(isInternalAddress("ana@contoso.example", [])).toBe(false);
  });
});

describe("text", () => {
  it("previews, lists, masks and scrubs", () => {
    expect(preview("  a\n\n b  ")).toBe("a b");
    expect(preview("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b", "c"])).toBe("a, b and c");
    expect(listOf(["a", "b", "c", "d", "e"])).toBe("a, b and 3 others");
    expect(sentence("Connected to Contoso Ltd.")).toBe("Connected to Contoso Ltd.");
    expect(sentence("Connected to Acme")).toBe("Connected to Acme.");
    expect(maskIdentifier("ca_1234567890c6M")).toBe("ca_…c6M");
    expect(maskIdentifier("20211234")).toBe("…234");
    expect(maskIdentifier("ab")).toBe("…");
    expect(scrub("token sk_test_abc123 leaked sk_test_abc123", ["sk_test_abc123"])).toBe(
      "token [redacted] leaked [redacted]",
    );
  });

  it("reads timestamps as UTC", () => {
    expect(unixSeconds("2026-09-01")).toBe(Date.UTC(2026, 8, 1) / 1000);
    expect(unixSeconds("2026-09-01T12:00:00+02:00")).toBe(Date.UTC(2026, 8, 1, 10) / 1000);
  });
});

describe("abortable", () => {
  it("settles with the work when it finishes first", async () => {
    await expect(abortable(Promise.resolve(1), new AbortController().signal)).resolves.toBe(1);
  });

  it("rejects on abort and hands a late value to discard", async () => {
    const controller = new AbortController();
    let finish: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const discarded: string[] = [];
    const pending = abortable(work, controller.signal, (value) => discarded.push(value));
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    finish("late");
    await work;
    await Promise.resolve();
    expect(discarded).toEqual(["late"]);
  });
});
