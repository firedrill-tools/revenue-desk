import { useCallback, useState } from "react";

// Per-browser conveniences only (theme, inspector open, rail width). Storage
// can be unavailable (private windows, blocked site data), so every access is
// guarded and the default applies.

function read<T>(key: string, fallback: T, parse: (raw: string) => T | undefined): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

export function useLocalState<T extends string | boolean>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback, parse));
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // Not persisted; the value still applies for this page.
      }
    },
    [key],
  );
  return [value, update];
}

export const parseBoolean = (raw: string): boolean | undefined =>
  raw === "true" ? true : raw === "false" ? false : undefined;
