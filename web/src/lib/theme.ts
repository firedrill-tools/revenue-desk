import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "revenue-desk:theme";
const listeners = new Set<() => void>();

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
  for (const listener of listeners) listener();
}

function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** The applied theme and a setter; every caller stays in sync. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentTheme,
    () => "light" as const,
  );
  const setTheme = useCallback((next: Theme) => applyTheme(next), []);
  return [theme, setTheme];
}
