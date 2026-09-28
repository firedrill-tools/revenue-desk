/** Stripe request parameters: typed readers with Stripe's validation errors. */

import { invalid } from "./errors.js";
import type { FormObject, FormValue } from "./form.js";
import type { Subscription } from "./state.js";

type SubscriptionStatus = Subscription["status"];

export const LIST_PARAMS = ["limit", "starting_after", "ending_before", "created"] as const;
export const REFUND_REASONS = ["duplicate", "fraudulent", "requested_by_customer"] as const;
export const SUBSCRIPTION_STATUSES = [
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "trialing",
  "paused",
  "all",
  "ended",
] as const;
export const INVOICE_STATUSES = ["draft", "open", "paid", "uncollectible", "void"] as const;

export function newestFirst(
  a: { readonly created: number; readonly id: string },
  b: { readonly created: number; readonly id: string },
): number {
  return b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function objectName(url: string): string {
  const resource = url.split("/").at(-1) ?? "object";
  return resource.endsWith("s") ? resource.slice(0, -1) : resource;
}

export function stringParam(params: FormObject, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw invalid(`Invalid string: ${name}`, { param: name, saved: false });
  return value;
}

export function intParam(
  params: FormObject,
  name: string,
  bounds: { readonly min?: number; readonly max?: number } = {},
): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw invalid(`Invalid integer: ${typeof value === "string" ? value : "[object]"}`, {
      code: "parameter_invalid_integer",
      param: name,
      saved: false,
    });
  }
  const number = Number(value);
  if (
    (bounds.min !== undefined && number < bounds.min) ||
    (bounds.max !== undefined && number > bounds.max)
  ) {
    const range =
      bounds.max === undefined
        ? `greater than or equal to ${bounds.min}`
        : `between ${bounds.min ?? 0} and ${bounds.max}`;
    throw invalid(`This value must be ${range}.`, {
      code: "parameter_invalid_integer",
      param: name,
      saved: false,
    });
  }
  return number;
}

export function boolParam(params: FormObject, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(`Invalid boolean: ${typeof value === "string" ? value : "[object]"}`, {
    param: name,
    saved: false,
  });
}

export function enumParam<const T extends readonly string[]>(
  params: FormObject,
  name: string,
  values: T,
): T[number] | undefined {
  const value = stringParam(params, name);
  if (value === undefined) return undefined;
  if (!values.includes(value)) {
    const list =
      values.length > 1 ? `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}` : values[0];
    throw invalid(`Invalid ${name}: must be one of ${list}`, { param: name, saved: false });
  }
  return value;
}

export function metadataParam(params: FormObject): Record<string, string> {
  const value = params.metadata;
  if (value === undefined || value === "") return {};
  if (typeof value === "string" || Array.isArray(value)) {
    throw invalid("Invalid object", { param: "metadata", saved: false });
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length > 50)
    throw invalid("You can specify up to 50 metadata keys.", { param: "metadata", saved: false });
  for (const [key, entry] of entries) {
    if (typeof entry !== "string")
      throw invalid("Invalid object", { param: `metadata[${key}]`, saved: false });
    if (key.length > 40)
      throw invalid("Metadata keys can be up to 40 characters long.", {
        param: `metadata[${key}]`,
        saved: false,
      });
    if (entry.length > 500)
      throw invalid("Metadata values can be up to 500 characters long.", {
        param: `metadata[${key}]`,
        saved: false,
      });
    out[key] = entry;
  }
  return out;
}

/** `created=123` or `created[gte]=…&created[lt]=…` as a predicate. */
export function rangeParam(params: FormObject, name: string): (value: number) => boolean {
  const value = params[name];
  if (value === undefined) return () => true;
  const asInt = (raw: FormValue | undefined, param: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      throw invalid(`Invalid integer: ${typeof raw === "string" ? raw : "[object]"}`, {
        code: "parameter_invalid_integer",
        param,
        saved: false,
      });
    }
    return Number(raw);
  };
  if (typeof value === "string") {
    const exact = asInt(value, name);
    return (candidate) => candidate === exact;
  }
  if (Array.isArray(value)) throw invalid("Invalid hash", { param: name, saved: false });
  for (const key of Object.keys(value)) {
    if (!["gt", "gte", "lt", "lte"].includes(key)) {
      throw invalid(`Received unknown parameter: ${name}[${key}]`, {
        code: "parameter_unknown",
        param: `${name}[${key}]`,
        saved: false,
      });
    }
  }
  const gt = asInt(value.gt, `${name}[gt]`);
  const gte = asInt(value.gte, `${name}[gte]`);
  const lt = asInt(value.lt, `${name}[lt]`);
  const lte = asInt(value.lte, `${name}[lte]`);
  return (candidate) =>
    (gt === undefined || candidate > gt) &&
    (gte === undefined || candidate >= gte) &&
    (lt === undefined || candidate < lt) &&
    (lte === undefined || candidate <= lte);
}

export function expandParam(params: FormObject): string[] {
  const value = params.expand;
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) throw invalid("Invalid array", { param: "expand", saved: false });
  return value.map((entry) => {
    if (typeof entry !== "string")
      throw invalid("Invalid array", { param: "expand", saved: false });
    return entry;
  });
}

export function subscriptionStatusMatches(
  status: SubscriptionStatus,
  filter: (typeof SUBSCRIPTION_STATUSES)[number] | undefined,
): boolean {
  if (filter === undefined) return status !== "canceled";
  if (filter === "all") return true;
  if (filter === "ended") return status === "canceled";
  return status === filter;
}

export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}
