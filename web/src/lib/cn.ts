// Tailwind class merging that knows the app's type scale.
//
// shadcn's `cn` (the "cn" package: clsx plus tailwind-merge tables) does not
// know the custom sizes `text-body`, `text-body-sm` and `text-meta` from
// web/src/styles, so it files them under text colour and
// `cn("text-meta text-muted-foreground")` silently dropped the size. Rather
// than bundling the config compiler (about 70 kB), each custom size is swapped
// for an arbitrary font-size the default tables do understand, merged, and
// swapped back.
//
// Alias-free and DOM-free so the Node test suite can import it.

import { type ClassValue, clsx, twMerge } from "cn";

export const TYPE_SCALE = ["body", "body-sm", "meta"] as const;

const TO_PLACEHOLDER = new Map<string, string>(
  TYPE_SCALE.map((size) => [`text-${size}`, `text-[length:--rd-scale-${size}]`]),
);
const FROM_PLACEHOLDER = new Map<string, string>(
  [...TO_PLACEHOLDER].map(([name, placeholder]) => [placeholder, name]),
);

/** Splits `md:hover:text-meta!` into its variant prefix and utility, ignoring colons in brackets. */
export function splitVariants(token: string): { prefix: string; utility: string } {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) cut = index;
  }
  return { prefix: token.slice(0, cut + 1), utility: token.slice(cut + 1) };
}

function swap(token: string, table: ReadonlyMap<string, string>): string {
  const { prefix, utility } = splitVariants(token);
  const lead = utility.startsWith("!") ? "!" : "";
  const trail = utility.endsWith("!") && lead === "" ? "!" : "";
  const bare = utility.slice(lead.length, utility.length - trail.length);
  const replacement = table.get(bare);
  return replacement === undefined ? token : `${prefix}${lead}${replacement}${trail}`;
}

function swapAll(classes: string, table: ReadonlyMap<string, string>): string {
  return classes
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => swap(token, table))
    .join(" ");
}

export function cn(...inputs: ClassValue[]): string {
  return swapAll(twMerge(swapAll(clsx(...inputs), TO_PLACEHOLDER)), FROM_PLACEHOLDER);
}
