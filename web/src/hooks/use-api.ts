import { api } from "@/lib/api";
import type {
  ConnectionView,
  ConversationSummary,
  Page,
  PolicyView,
  RunDetailView,
  WorkspaceSettings,
} from "@/lib/contracts";
import { type Resource, useResource } from "./use-resource";

// Resource hooks for the screens. Each reloads when its topic is invalidated
// (hooks/use-resource.ts) and polls only while something is in flight.

/** While a configured integration has not been checked yet (the server's boot checks), poll often. */
const UNCHECKED_POLL_MS = 2_000;

export function useConnections(): Resource<readonly ConnectionView[]> {
  return useResource(
    "connections",
    async (signal) => (await api.request("GET /api/connections", { signal })).items,
    {
      topics: ["connections"],
      // Every view of the connections (app bar, empty chat, Connections) settles on the checks.
      pollMs: (items) =>
        items?.some((item) => item.state === "unknown") ? UNCHECKED_POLL_MS : 60_000,
    },
  );
}

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

export function useConversations(query: string): Resource<Page<ConversationSummary>> {
  const q = query.trim();
  return useResource(
    `conversations:${q}`,
    (signal) =>
      api.request("GET /api/conversations", {
        query: { limit: 100, ...(q === "" ? {} : { q }) },
        signal,
      }),
    {
      topics: ["conversations"],
      pollMs: (page) =>
        page?.items.some((item) => item.status === "running" || item.status === "awaiting_approval")
          ? ACTIVE_POLL_MS
          : IDLE_POLL_MS,
    },
  );
}

export function useRunDetail(runId: string | null): Resource<RunDetailView> {
  return useResource(
    runId === null ? null : `run:${runId}`,
    (signal) => {
      if (runId === null) throw new Error("unreachable");
      return api.request("GET /api/runs/:runId", { params: { runId }, signal });
    },
    {
      topics: ["runs"],
      pollMs: (run) => (run === undefined || run.status === "running" ? ACTIVE_POLL_MS : null),
    },
  );
}

export function useSettings(): Resource<WorkspaceSettings> {
  return useResource(
    "settings",
    async (signal) => (await api.request("GET /api/settings", { signal })).settings,
    { topics: ["settings"] },
  );
}

export function usePolicies(): Resource<readonly PolicyView[]> {
  return useResource(
    "policies",
    async (signal) => (await api.request("GET /api/policies", { signal })).policies,
    { topics: ["settings"] },
  );
}
