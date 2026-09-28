// Stripe's form encoding: application/x-www-form-urlencoded with bracket
// syntax for nested objects and arrays, as the official client sends it:
//   {metadata: {order: "7"}, expand: ["charge"]}
//   -> metadata[order]=7&expand[0]=charge

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly FormValue[]
  | { readonly [key: string]: FormValue };

export type FormParams = { readonly [key: string]: FormValue };

function isParams(value: FormValue): value is FormParams {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatten(prefix: string, value: FormValue, out: [string, string][]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item: FormValue, index) => {
      flatten(`${prefix}[${index}]`, item, out);
    });
    return;
  }
  if (isParams(value)) {
    for (const [key, inner] of Object.entries(value)) flatten(`${prefix}[${key}]`, inner, out);
    return;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`form parameter ${prefix} is not a finite number`);
  }
  out.push([prefix, String(value)]);
}

/** Flattened [key, value] pairs, in insertion order. Null and undefined are omitted. */
export function formPairs(params: FormParams): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) flatten(key, value, out);
  return out;
}

/** Percent-encodes a key while keeping its brackets readable, as Stripe's clients do. */
function encodeKey(key: string): string {
  return encodeURIComponent(key).replace(/%5B/g, "[").replace(/%5D/g, "]");
}

export function encodeForm(params: FormParams): string {
  return formPairs(params)
    .map(([key, value]) => `${encodeKey(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
