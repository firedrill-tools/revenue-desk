export type Theme = "light" | "dark";

const STORAGE_KEY = "revenue-desk:theme";

/** Light is the default; a saved choice (per browser) overrides it. */
export function readTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the theme still applies.
  }
}
