// Money as integer minor units plus an ISO 4217 code (docs/ARCHITECTURE.md §8),
// formatted for approval cards and converted for providers that use decimals.

import type { Money } from "../../contracts/integration.js";

const exponents = new Map<string, number>();

/** True for a three-letter code that Intl recognises as a currency. */
export function isCurrencyCode(code: string): boolean {
  return currencyExponent(code) !== null;
}

/** Digits after the decimal point for a currency (USD 2, JPY 0, KWD 3); null if unknown. */
export function currencyExponent(code: string): number | null {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) return null;
  const cached = exponents.get(upper);
  if (cached !== undefined) return cached;
  try {
    const digits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: upper,
    }).resolvedOptions().maximumFractionDigits;
    const exponent = digits ?? 2;
    exponents.set(upper, exponent);
    return exponent;
  } catch {
    return null;
  }
}

function exponentOf(currency: string): number {
  return currencyExponent(currency) ?? 2;
}

export function money(amountMinor: number, currency: string): Money {
  return { amountMinor, currency: currency.toUpperCase() };
}

/** "$49.00", "€1,200.50", "¥5,000". Unknown codes fall back to "12.34 XYZ". */
export function formatMoney(value: Money): string {
  const exponent = exponentOf(value.currency);
  const major = value.amountMinor / 10 ** exponent;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(major);
  } catch {
    return `${major.toFixed(exponent)} ${value.currency}`;
  }
}

/** 49.99 USD -> 4999. Rounds half away from zero at the currency's precision. */
export function decimalToMinor(amount: number, currency: string): number {
  const scaled = amount * 10 ** exponentOf(currency);
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/** 4999 USD -> 49.99, as a JSON number for providers that take decimal amounts. */
export function minorToDecimal(amountMinor: number, currency: string): number {
  const exponent = exponentOf(currency);
  return Number((amountMinor / 10 ** exponent).toFixed(exponent));
}
