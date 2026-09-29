import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SessionInfo } from "@/lib/contracts";

// GET /api/session once at boot: the CSRF token (kept inside lib/api.ts), the
// model label, the business date and whether a model key is configured.

type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly session: SessionInfo }
  | { readonly status: "error"; readonly retry: () => void };

const SessionContext = createContext<SessionState>({ status: "loading" });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const request = attempt === 0 ? api.session() : api.refreshSession();
    request.then(
      (session) => {
        if (active) setState({ status: "ready", session });
      },
      () => {
        if (active) setState({ status: "error", retry });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, retry]);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSessionState(): SessionState {
  return useContext(SessionContext);
}

/** The session once loaded; null while loading or after a failure. */
export function useSession(): SessionInfo | null {
  const state = useContext(SessionContext);
  return state.status === "ready" ? state.session : null;
}
