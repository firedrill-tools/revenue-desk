// Syntax highlighting for tool JSON (CodeBlock) and fenced code in replies
// (Streamdown). One shiki version (4.x, the direct dependency), the
// fine-grained core build with the JavaScript regex engine (no WASM), two
// themes and a handful of languages, each loaded on first use. Unknown
// languages render as plain text.
//
// This replaces @streamdown/code, which bundles every shiki language and
// theme of shiki 3 (docs/ARCHITECTURE.md §14, bundle size).
//
// Alias-free and DOM-free so the Node test suite can import it.

import type { HighlighterCore, LanguageRegistration, TokensResult } from "shiki/core";
import type { CodeHighlighterPlugin } from "streamdown";

type LanguageModule = { readonly default: LanguageRegistration[] };

const LANGUAGE_LOADERS = {
  json: () => import("shiki/langs/json.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  csv: () => import("shiki/langs/csv.mjs"),
} as const satisfies Record<string, () => Promise<LanguageModule>>;

export type SupportedLanguage = keyof typeof LANGUAGE_LOADERS;

const ALIASES: Readonly<Record<string, SupportedLanguage>> = {
  json: "json",
  jsonc: "json",
  json5: "json",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  shellscript: "shellscript",
  shell: "shellscript",
  bash: "shellscript",
  sh: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  csv: "csv",
};

export const THEMES = ["github-light", "github-dark"] as const;

export function resolveLanguage(language: string): SupportedLanguage | null {
  return ALIASES[language.trim().toLowerCase()] ?? null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Map<SupportedLanguage, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === null) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("shiki/themes/github-light.mjs"),
          import("shiki/themes/github-dark.mjs"),
        ]);
      return createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
    highlighterPromise.catch(() => {
      highlighterPromise = null;
    });
  }
  return highlighterPromise;
}

function ensureLanguage(highlighter: HighlighterCore, language: SupportedLanguage): Promise<void> {
  let loading = loadedLanguages.get(language);
  if (!loading) {
    loading = LANGUAGE_LOADERS[language]().then((module) =>
      highlighter.loadLanguage(...module.default),
    );
    loadedLanguages.set(language, loading);
    loading.catch(() => loadedLanguages.delete(language));
  }
  return loading;
}

/** Above this size, code is shown plain: highlighting would stall the page. */
export const MAX_HIGHLIGHT_CHARS = 60_000;
const CACHE_LIMIT = 200;
const cache = new Map<string, TokensResult>();
const waiters = new Map<string, Set<(result: TokensResult) => void>>();
const inflight = new Set<string>();

function remember(key: string, result: TokensResult): void {
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Returns cached tokens synchronously, or null and highlights in the
 * background, calling `callback` once the tokens are ready. Unsupported
 * languages and very large inputs stay null (render them plain).
 */
export function highlightTokens(
  code: string,
  language: string,
  callback?: (result: TokensResult) => void,
): TokensResult | null {
  const resolved = resolveLanguage(language);
  if (resolved === null || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = `${resolved}\u0000${code}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (callback) {
    const set = waiters.get(key) ?? new Set();
    set.add(callback);
    waiters.set(key, set);
  }
  if (!inflight.has(key)) {
    inflight.add(key);
    void (async () => {
      try {
        const highlighter = await getHighlighter();
        await ensureLanguage(highlighter, resolved);
        const result = highlighter.codeToTokens(code, {
          lang: resolved,
          themes: { light: THEMES[0], dark: THEMES[1] },
        });
        remember(key, result);
        for (const notify of waiters.get(key) ?? []) notify(result);
      } catch {
        // Highlighting is cosmetic: the code stays readable as plain text.
      } finally {
        inflight.delete(key);
        waiters.delete(key);
      }
    })();
  }
  return null;
}

/** Awaitable form, for tests and prefetching. */
export function highlightTokensAsync(code: string, language: string): Promise<TokensResult | null> {
  const cached = highlightTokens(code, language);
  if (cached) return Promise.resolve(cached);
  if (resolveLanguage(language) === null || code.length > MAX_HIGHLIGHT_CHARS) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const again = highlightTokens(code, language, resolve);
    if (again) resolve(again);
  });
}

/** Streamdown's code plugin, backed by the same highlighter. */
export const codeHighlighter: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage: (language) => resolveLanguage(language) !== null,
  getSupportedLanguages: () => Object.keys(ALIASES),
  getThemes: () => [THEMES[0], THEMES[1]],
  highlight: ({ code, language }, callback) => highlightTokens(code, language, callback),
};
