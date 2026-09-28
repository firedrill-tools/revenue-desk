import { useSyncExternalStore } from "react";

/** Matches a CSS media query and follows its changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tailwind's lg and xl breakpoints (docs/ARCHITECTURE.md §9, Shell). */
export const DESKTOP_QUERY = "(min-width: 1024px)";
export const WIDE_QUERY = "(min-width: 1280px)";
export const PHONE_QUERY = "(max-width: 639px)";
