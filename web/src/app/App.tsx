import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { applyTheme, readTheme, type Theme } from "@/lib/theme";

type ServerState = "checking" | "connected" | "unreachable";

function useServerState(): ServerState {
  const [state, setState] = useState<ServerState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        const body: unknown = response.ok ? await response.json() : null;
        const ok =
          typeof body === "object" &&
          body !== null &&
          (body as { status?: unknown }).status === "ok";
        setState(ok ? "connected" : "unreachable");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unreachable");
      });
    return () => controller.abort();
  }, []);

  return state;
}

function ServerStatus({ state }: { state: ServerState }) {
  if (state === "checking") {
    return (
      <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        Checking server
      </span>
    );
  }
  const connected = state === "connected";
  return (
    <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
      <span
        aria-hidden="true"
        className={connected ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-danger"}
      />
      {connected ? "Server connected" : "Server unreachable"}
    </span>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const serverState = useServerState();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const nextTheme: Theme = theme === "dark" ? "light" : "dark";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <span className="font-semibold tracking-tight">Revenue Desk</span>
        <div className="flex items-center gap-3">
          <ServerStatus state={serverState} />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Switch to ${nextTheme} theme`}
            onClick={() => setTheme(nextTheme)}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-4 py-10">
        <h1 className="text-lg font-semibold tracking-tight">Revenue Desk</h1>
        <p className="mt-1 text-muted-foreground">
          Scaffold build. Chat, connections, runs and settings are not implemented yet.
        </p>
      </main>
    </div>
  );
}
