// How model text is rendered as Markdown (Streamdown) without letting it make
// the browser fetch anything.
//
// The model's replies and reasoning can repeat text from email, CRM notes,
// invoices or Slack. A Markdown or HTML image in them would make the browser
// request its URL as soon as it renders: an outbound transfer (the URL can
// carry data) with no approval and no action-log row. So images are never
// rendered: Streamdown's harden step allows no image source, and the `img`
// element itself becomes its alt text. Links stay links; they need a click.
// The server's Content-Security-Policy (src/server/security.ts) is the
// second barrier.
//
// Alias-free and DOM-free so the Node test suite can import it.

import { createElement, type ReactNode } from "react";
import { type Components, defaultRehypePlugins } from "streamdown";

type Pluggable = (typeof defaultRehypePlugins)[string];

/** Streamdown's own harden step, with every image source refused. */
function hardenWithoutImages(): Pluggable {
  const entry = defaultRehypePlugins.harden;
  const plugin = Array.isArray(entry) ? entry[0] : entry;
  const options = Array.isArray(entry) && typeof entry[1] === "object" ? entry[1] : {};
  return [plugin, { ...options, allowedImagePrefixes: [], allowDataImages: false }] as Pluggable;
}

/** Streamdown's default rehype steps (raw HTML, sanitize, harden) with images refused. */
export const SAFE_REHYPE_PLUGINS: Pluggable[] = Object.entries(defaultRehypePlugins).map(
  ([name, plugin]) => (name === "harden" ? hardenWithoutImages() : plugin),
);

/** "[image: status]" in place of an image. */
export function imagePlaceholder(alt: unknown): string {
  const text = typeof alt === "string" ? alt.trim() : "";
  return text === "" ? "[image]" : `[image: ${text}]`;
}

function ImageAsText({ alt }: { readonly alt?: unknown }): ReactNode {
  return createElement("span", { className: "text-muted-foreground" }, imagePlaceholder(alt));
}

/** Element overrides for model text: an image renders as its alt text, never as <img>. */
export const SAFE_COMPONENTS: Components = {
  img: ImageAsText as Components["img"],
};
