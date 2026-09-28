// The lean highlighter (web/src/lib/highlight.ts): one shiki 4 core build,
// a few languages loaded on demand, two themes, used by CodeBlock and as
// Streamdown's code plugin.

import { describe, expect, it } from "vitest";
import {
  codeHighlighter,
  highlightTokens,
  highlightTokensAsync,
  MAX_HIGHLIGHT_CHARS,
  resolveLanguage,
} from "../../../web/src/lib/highlight.js";

describe("resolveLanguage", () => {
  it("maps aliases to the bundled languages", () => {
    expect(resolveLanguage("JSON")).toBe("json");
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("sh")).toBe("shellscript");
    expect(resolveLanguage("yml")).toBe("yaml");
    expect(resolveLanguage("python")).toBeNull();
  });
});

describe("highlightTokens", () => {
  it("highlights JSON with light and dark colours per token", async () => {
    const result = await highlightTokensAsync('{"amount": 4900}', "json");
    expect(result).not.toBeNull();
    const first = result?.tokens[0]?.[0];
    expect(first?.content).toBe("{");
    expect(first?.htmlStyle).toMatchObject({
      color: expect.any(String),
      "--shiki-dark": expect.any(String),
    });
    // Now cached: available synchronously.
    expect(highlightTokens('{"amount": 4900}', "json")).toBe(result);
  });

  it("notifies every waiter for the same code once", async () => {
    const code = '{"id": "re_1"}';
    const results = await Promise.all([
      highlightTokensAsync(code, "json"),
      highlightTokensAsync(code, "json"),
    ]);
    expect(results[0]).toBe(results[1]);
  });

  it("leaves unknown languages and oversized input plain", async () => {
    expect(await highlightTokensAsync("print(1)", "python")).toBeNull();
    expect(await highlightTokensAsync("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "json")).toBeNull();
  });

  it("serves Streamdown through the plugin interface", async () => {
    expect(codeHighlighter.supportsLanguage("bash")).toBe(true);
    expect(codeHighlighter.supportsLanguage("mermaid")).toBe(false);
    expect(codeHighlighter.getThemes()).toEqual(["github-light", "github-dark"]);
    const result = await new Promise((resolve) => {
      const sync = codeHighlighter.highlight(
        { code: "SELECT 1;", language: "sql", themes: ["github-light", "github-dark"] },
        resolve,
      );
      if (sync) resolve(sync);
    });
    expect(result).toMatchObject({ tokens: expect.any(Array) });
  });
});
