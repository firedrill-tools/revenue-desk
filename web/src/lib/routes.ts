// Client-side routes. Path-based (the server and Vite both fall back to
// index.html for any non-API path), parsed by a pure function so the router
// hook stays tiny and the table is testable.
//
// Alias-free and DOM-free so the Node test suite can import it.

export type Route =
  | { readonly name: "chat"; readonly conversationId: string | null }
  | { readonly name: "runs"; readonly runId: string | null }
  | { readonly name: "connections" }
  | { readonly name: "settings" }
  | { readonly name: "not_found"; readonly path: string };

export type RouteName = Route["name"];

/** Ids are opaque, but a route segment must be one plausible id, not a path. */
const ID_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return ID_SEGMENT.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): Route {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  const [first, second, ...rest] = segments;
  if (rest.length > 0) return { name: "not_found", path: pathname };

  if (first === undefined) return { name: "chat", conversationId: null };
  if (first === "c" && second !== undefined) {
    const conversationId = decodeSegment(second);
    return conversationId === null
      ? { name: "not_found", path: pathname }
      : { name: "chat", conversationId };
  }
  if (first === "runs") {
    if (second === undefined) return { name: "runs", runId: null };
    const runId = decodeSegment(second);
    return runId === null ? { name: "not_found", path: pathname } : { name: "runs", runId };
  }
  if (first === "connections" && second === undefined) return { name: "connections" };
  if (first === "settings" && second === undefined) return { name: "settings" };
  return { name: "not_found", path: pathname };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "chat":
      return route.conversationId === null ? "/" : `/c/${encodeURIComponent(route.conversationId)}`;
    case "runs":
      return route.runId === null ? "/runs" : `/runs/${encodeURIComponent(route.runId)}`;
    case "connections":
      return "/connections";
    case "settings":
      return "/settings";
    case "not_found":
      return route.path;
  }
}

export const chatHref = (conversationId: string | null): string =>
  hrefFor({ name: "chat", conversationId });
export const runHref = (runId: string | null): string => hrefFor({ name: "runs", runId });

/** Primary navigation, in app-bar order. */
export const NAV_ITEMS = [
  { name: "chat", label: "Chat", href: "/" },
  { name: "runs", label: "Runs", href: "/runs" },
  { name: "connections", label: "Connections", href: "/connections" },
  { name: "settings", label: "Settings", href: "/settings" },
] as const satisfies readonly {
  readonly name: Exclude<RouteName, "not_found">;
  readonly label: string;
  readonly href: string;
}[];

export const ROUTE_TITLES = {
  chat: "Chat",
  runs: "Runs",
  connections: "Connections",
  settings: "Settings",
  not_found: "Not found",
} as const satisfies Record<RouteName, string>;
