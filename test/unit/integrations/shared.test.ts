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
import {
  checkVendorUrl,
  isLoopbackHost,
  isPrivateNetworkHost,
  joinUrl,
} from "../../../src/integrations/shared/url.js";
import {
  COMPOSIO_API_BASE_URL,
  HUBSPOT_API_BASE_URL,
  HUBSPOT_MCP_SERVER_API_HOST,
  STRIPE_API_BASE_URL,
} from "../../../src/integrations/shared/vendors.js";

describe("URLs", () => {
  it("pins every vendor endpoint to the vendor's own HTTPS host", () => {
    expect(COMPOSIO_API_BASE_URL).toBe("https://backend.composio.dev");
    expect(STRIPE_API_BASE_URL).toBe("https://api.stripe.com");
    expect(HUBSPOT_API_BASE_URL).toBe("https://api.hubapi.com");
    expect(HUBSPOT_MCP_SERVER_API_HOST).toBe("api.hubspot.com");
  });

  it("joins a path, keeping any prefix, then the query", () => {
    expect(joinUrl("https://api.stripe.com", "/v1/charges")).toBe(
      "https://api.stripe.com/v1/charges",
    );
    expect(joinUrl("https://api.stripe.com/", "/v1/charges", { limit: 10, email: undefined })).toBe(
      "https://api.stripe.com/v1/charges?limit=10",
    );
    expect(joinUrl("https://x.test/a/b", "c/d", new URLSearchParams({ q: "a b" }))).toBe(
      "https://x.test/a/b/c/d?q=a+b",
    );
  });

  it("recognises loopback hosts only", () => {
    for (const host of ["localhost", "a.localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["api.stripe.com", "localhost.evil.test", "10.0.0.1", "128.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("recognises hosts on this machine or a private network, as the URL parser writes them", () => {
    const hostname = (url: string) => new URL(url).hostname;
    for (const url of [
      "https://localhost/",
      "https://LOCALHOST./",
      "https://app.localhost/",
      "https://127.0.0.1/",
      "https://0x7f.1/",
      "https://2130706433/",
      "https://0.0.0.0/",
      "https://10.20.30.40/",
      "https://100.64.0.1/",
      "https://169.254.169.254/",
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://192.168.1.1/",
      "https://198.18.0.1/",
      "https://224.0.0.1/",
      "https://[::]/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:10.0.0.1]/",
      "https://[64:ff9b::192.168.0.1]/",
      "https://[fe80::1]/",
      "https://[fc00::1]/",
      "https://[fd12:3456::1]/",
      "https://printer.local/",
      "https://composio.internal/",
      "https://intranet/",
    ]) {
      expect(isPrivateNetworkHost(hostname(url)), url).toBe(true);
    }
    for (const url of [
      "https://backend.composio.dev/",
      "https://connect.composio.dev/",
      "https://api.stripe.com/",
      "https://8.8.8.8/",
      "https://172.32.0.1/",
      "https://100.128.0.1/",
      "https://192.169.0.1/",
      "https://[2606:4700::1111]/",
      "https://[::ffff:8.8.8.8]/",
      "https://localhost.evil.test/",
    ]) {
      expect(isPrivateNetworkHost(hostname(url)), url).toBe(false);
    }
  });

  it("accepts a vendor URL only when it is HTTPS on a public host, and never repeats it", () => {
    expect(checkVendorUrl("https://backend.composio.dev/tool_router/trs_1/mcp")).toMatchObject({
      ok: true,
    });
    expect(checkVendorUrl("http://backend.composio.dev/mcp")).toEqual({
      ok: false,
      reason: "is not HTTPS",
    });
    expect(checkVendorUrl("https://user:pw@backend.composio.dev/mcp")).toEqual({
      ok: false,
      reason: "contains credentials",
    });
    expect(checkVendorUrl("https://127.0.0.1:4450/mcp")).toEqual({
      ok: false,
      reason: "points at this machine or a private network",
    });
    expect(checkVendorUrl("not a url")).toEqual({ ok: false, reason: "is not a valid URL" });
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
