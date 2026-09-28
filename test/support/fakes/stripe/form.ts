/**
 * Stripe's parameter encoding: `application/x-www-form-urlencoded` (and the
 * query string of GET and DELETE) with bracket syntax for nesting:
 * `metadata[order]=6735`, `expand[]=customer`, `items[0][price]=price_1`,
 * `created[gte]=1790000000`. Every leaf value is a string.
 */

export type FormValue = string | FormObject | FormValue[];
export interface FormObject {
  [key: string]: FormValue;
}

export type FormParseResult =
  | { readonly ok: true; readonly params: FormObject }
  | { readonly ok: false; readonly param: string; readonly message: string };

const KEY = /^([^[\]]+)((?:\[[^[\]]*\])*)$/;

/** Parses decoded key/value pairs (from URLSearchParams) into nested parameters. */
export function parseStripeParams(pairs: Iterable<[string, string]>): FormParseResult {
  const params: FormObject = {};
  for (const [key, value] of pairs) {
    const match = KEY.exec(key);
    if (match === null) return { ok: false, param: key, message: `Invalid parameter name: ${key}` };
    const root = match[1] as string;
    const path = [...(match[2] ?? "").matchAll(/\[([^[\]]*)\]/g)].map((part) => part[1] as string);
    const error = assign(params, root, path, value);
    if (error !== null) return { ok: false, param: root, message: error };
  }
  return { ok: true, params };
}

function assign(
  target: FormObject | FormValue[],
  key: string,
  path: readonly string[],
  value: string,
): string | null {
  const [next, ...rest] = path;
  if (Array.isArray(target)) {
    const index = key === "" ? target.length : Number(key);
    if (!Number.isInteger(index) || index < 0) return `Invalid array index: ${key}`;
    if (next === undefined) {
      target[index] = value;
      return null;
    }
    const child = target[index] ?? (isIndex(next) ? [] : {});
    if (typeof child === "string") return `Invalid array`;
    target[index] = child;
    return assign(child, next, rest, value);
  }
  if (next === undefined) {
    if (target[key] !== undefined && typeof target[key] !== "string") return "Invalid hash";
    target[key] = value;
    return null;
  }
  const existing = target[key];
  const child = existing ?? (isIndex(next) ? [] : {});
  if (typeof child === "string") return "Invalid hash";
  if (Array.isArray(child) !== isIndex(next))
    return isIndex(next) ? "Invalid array" : "Invalid hash";
  target[key] = child;
  return assign(child, next, rest, value);
}

/** `[]` and `[0]` address arrays; anything else addresses a hash. */
function isIndex(segment: string): boolean {
  return segment === "" || /^\d+$/.test(segment);
}

/** A canonical, order-independent JSON rendering (for idempotency fingerprints). */
export function canonical(value: FormValue | undefined): string {
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
