import { type ComponentProps, type MouseEvent, useMemo, useSyncExternalStore } from "react";
import { parseRoute, type Route } from "@/lib/routes";

// A tiny History API router: the server and Vite serve index.html for every
// non-API path, lib/routes.ts parses the path, and navigate() notifies
// subscribers. No dependency, no nested routes.

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const getPath = () => window.location.pathname;

export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (href === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getPath, () => "/");
  return useMemo(() => parseRoute(path), [path]);
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export type LinkProps = ComponentProps<"a"> & { href: string; replace?: boolean };

/** An anchor that navigates in place; modified clicks keep browser behaviour. */
export function Link({ href, replace, onClick, target, ...props }: LinkProps) {
  return (
    <a
      href={href}
      target={target}
      onClick={(event) => {
        onClick?.(event);
        if (target === undefined && isPlainLeftClick(event)) {
          event.preventDefault();
          navigate(href, { replace: replace ?? false });
        }
      }}
      {...props}
    />
  );
}
