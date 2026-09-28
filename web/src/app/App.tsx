import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { AppBar, PrimaryNav, ThemeToggle } from "@/components/app/app-bar";
import { BrandMark, Wordmark } from "@/components/app/brand";
import { ConversationRail } from "@/components/app/conversation-rail";
import { NoticeProvider } from "@/components/app/notices";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { focusPanelOnOpen } from "@/lib/focus";
import { ROUTE_TITLES, type Route } from "@/lib/routes";
import { Link, useRoute } from "./router";
import { SessionProvider, useSessionState } from "./session";
import { ShellProvider, useShell } from "./shell-context";

// Routes are code-split: the chat screen carries Streamdown and the
// highlighter, which Runs, Connections and Settings do not need.
const ChatRoute = lazy(() => import("./routes/chat/chat-route"));
const RunsRoute = lazy(() => import("./routes/runs/runs-route"));
const ConnectionsRoute = lazy(() => import("./routes/connections/connections-route"));
const SettingsRoute = lazy(() => import("./routes/settings/settings-route"));

function RouteFallback() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="font-medium">This page does not exist.</p>
      <Link href="/" className="text-body-sm">
        Go to chat
      </Link>
    </div>
  );
}

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case "chat":
      return <ChatRoute conversationId={route.conversationId} />;
    case "runs":
      return <RunsRoute runId={route.runId} />;
    case "connections":
      return <ConnectionsRoute />;
    case "settings":
      return <SettingsRoute />;
    case "not_found":
      return <NotFound />;
  }
}

function RailSheet({ route }: { route: Route }) {
  const { railOpen, setRailOpen } = useShell();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (desktop) return null;
  const close = () => setRailOpen(false);
  return (
    <Sheet open={railOpen} onOpenChange={setRailOpen}>
      <SheetContent
        side="left"
        onOpenAutoFocus={focusPanelOnOpen}
        className="gap-0 bg-surface-subtle p-0 pt-[env(safe-area-inset-top)] outline-none data-[side=left]:w-[300px] data-[side=left]:max-w-[85vw] data-[side=left]:sm:max-w-[300px]"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">Screens and conversations</SheetDescription>
        <ConversationRail
          route={route}
          onNavigate={close}
          header={
            <div className="border-b px-3 pt-3 pb-2">
              <div className="flex min-h-8 items-center gap-2 pr-12 pl-1">
                <BrandMark />
                <Wordmark />
                <ThemeToggle className="ml-auto sm:hidden" />
              </div>
              <PrimaryNav route={route} onNavigate={close} className="mt-2 flex-wrap" />
            </div>
          }
        />
      </SheetContent>
    </Sheet>
  );
}

function ServerUnavailable({ retry }: { retry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-medium">Revenue Desk's server is not reachable.</p>
      <p className="max-w-sm text-body-sm text-muted-foreground">
        Start it with <code className="rounded bg-muted px-1 py-0.5 text-meta">pnpm dev</code> or{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-meta">pnpm start</code>, then try again.
      </p>
      <Button variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const session = useSessionState();

  useEffect(() => {
    document.title =
      route.name === "chat" ? "Revenue Desk" : `${ROUTE_TITLES[route.name]} · Revenue Desk`;
  }, [route.name]);

  let content: ReactNode;
  if (session.status === "error") content = <ServerUnavailable retry={session.retry} />;
  else if (session.status === "loading") content = <RouteFallback />;
  else
    content = (
      <Suspense fallback={<RouteFallback />}>
        <RouteView route={route} />
      </Suspense>
    );

  return (
    <div className="relative flex h-dvh flex-col overflow-clip bg-background text-foreground">
      <AppBar route={route} />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Conversations"
          className="hidden w-[264px] shrink-0 border-r bg-surface-subtle lg:flex"
        >
          <ConversationRail route={route} />
        </aside>
        <RailSheet route={route} />
        <main className="flex min-w-0 flex-1 flex-col">{content}</main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <NoticeProvider>
        <ShellProvider>
          <Shell />
        </ShellProvider>
      </NoticeProvider>
    </SessionProvider>
  );
}
