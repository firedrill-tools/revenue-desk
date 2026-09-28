import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// A small data hook: load by key, keep the last data while reloading or
// polling (no flashing skeletons), abort on key change, and reload when a
// topic is invalidated anywhere in the app.

export type Topic = "conversations" | "connections" | "runs" | "settings";

const topicListeners = new Map<Topic, Set<() => void>>();

/** Asks every mounted resource subscribed to `topic` to reload. */
export function invalidate(...topics: Topic[]): void {
  for (const topic of topics) {
    for (const listener of topicListeners.get(topic) ?? []) listener();
  }
}

function subscribe(topic: Topic, listener: () => void): () => void {
  const listeners = topicListeners.get(topic) ?? new Set();
  listeners.add(listener);
  topicListeners.set(topic, listeners);
  return () => listeners.delete(listener);
}

export type Resource<T> = {
  readonly data: T | undefined;
  readonly error: unknown;
  /** True only while nothing has loaded for the current key. */
  readonly loading: boolean;
  /** True during any request, including background reloads. */
  readonly refreshing: boolean;
  readonly reload: () => void;
  readonly mutate: (next: T | ((current: T | undefined) => T)) => void;
};

export type ResourceOptions<T> = {
  /** Reload when these topics are invalidated. */
  readonly topics?: readonly Topic[];
  /** Poll interval for the current data; null or 0 disables polling. */
  readonly pollMs?: number | null | ((data: T | undefined) => number | null);
};

export function useResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  options: ResourceOptions<T> = {},
): Resource<T> {
  const [state, setState] = useState<{
    key: string | null;
    data: T | undefined;
    error: unknown;
    refreshing: boolean;
  }>({ key, data: undefined, error: undefined, refreshing: key !== null });
  const [generation, setGeneration] = useState(0);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  // A new key starts from nothing: never show the previous key's data.
  if (state.key !== key) {
    setState({ key, data: undefined, error: undefined, refreshing: key !== null });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: generation re-runs the load on purpose.
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setState((current) => (current.key === key ? { ...current, refreshing: true } : current));
    loadRef.current(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setState({ key, data, error: undefined, refreshing: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) =>
          current.key === key ? { ...current, error, refreshing: false } : current,
        );
      },
    );
    return () => controller.abort();
  }, [key, generation]);

  const topics = options.topics?.join(",") ?? "";
  useEffect(() => {
    if (topics === "") return;
    const unsubscribers = topics.split(",").map((topic) => subscribe(topic as Topic, reload));
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [topics, reload]);

  const { pollMs } = options;
  const interval = typeof pollMs === "function" ? pollMs(state.data) : (pollMs ?? null);
  useEffect(() => {
    if (key === null || !interval || interval <= 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, interval);
    return () => clearInterval(timer);
  }, [key, interval, reload]);

  const mutate = useCallback((next: T | ((current: T | undefined) => T)) => {
    setState((current) => ({
      ...current,
      data: typeof next === "function" ? (next as (value: T | undefined) => T)(current.data) : next,
    }));
  }, []);

  const current =
    state.key === key ? state : { data: undefined, error: undefined, refreshing: true };
  return {
    data: current.data,
    error: current.data === undefined ? current.error : undefined,
    loading: key !== null && current.data === undefined && current.error === undefined,
    refreshing: current.refreshing,
    reload,
    mutate,
  };
}
