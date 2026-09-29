import { MenuIcon, MoonIcon, PanelRightIcon, SunIcon } from "lucide-react";
import { Link } from "@/app/router";
import { useSessionState } from "@/app/session";
import { useShell } from "@/app/shell-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_ITEMS, type Route } from "@/lib/routes";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { BrandMark, Wordmark } from "./brand";
import { ConnectionsHealth } from "./connections-health";
import { StatusDot } from "./status";

export function isNavActive(route: Route, name: (typeof NAV_ITEMS)[number]["name"]): boolean {
  return route.name === name;
}

export function PrimaryNav({
  route,
  className,
  onNavigate,
}: {
  route: Route;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Primary" className={cn("flex items-center gap-0.5", className)}>
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(route, item.name);
        return (
          <Link
            key={item.name}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-2.5 font-medium text-body-sm no-underline transition-colors hover:no-underline pointer-coarse:h-11",
              active
                ? "bg-surface-hover text-foreground"
                : "text-muted-foreground hover:bg-surface-hover/70 hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ModelLabel() {
  const state = useSessionState();
  if (state.status === "loading") return <Skeleton className="hidden h-4 w-36 md:block" />;
  if (state.status === "error") return null;
  const { session } = state;
  if (!session.modelConfigured) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="hidden cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 font-medium text-meta text-warning sm:inline-flex">
            <StatusDot tone="warning" />
            No model key
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          ANTHROPIC_API_KEY is not set: add it and restart the server.
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="hidden cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-meta text-muted-foreground md:inline-flex">
          {session.model}
          <span aria-hidden="true" className="text-border-strong">
            /
          </span>
          {session.effort}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Model and effort for new runs · business date {session.businessDate}
      </TooltipContent>
    </Tooltip>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

export function AppBar({
  route,
  waitingApprovals = 0,
}: {
  route: Route;
  waitingApprovals?: number;
}) {
  const { setRailOpen, inspectorAvailable, inspectorOpen, setInspectorOpen } = useShell();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-2 sm:px-3">
      <Button
        variant="ghost"
        size="icon"
        className="relative text-muted-foreground lg:hidden"
        aria-label={
          waitingApprovals > 0
            ? `Open conversations, ${waitingApprovals} ${waitingApprovals === 1 ? "approval" : "approvals"} waiting`
            : "Open conversations"
        }
        onClick={() => setRailOpen(true)}
      >
        <MenuIcon />
        {waitingApprovals > 0 ? (
          <span
            aria-hidden="true"
            className="absolute top-1 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 font-semibold text-[10px] text-background tabular-nums leading-none"
          >
            {waitingApprovals}
          </span>
        ) : null}
      </Button>
      <Link
        href="/"
        className="flex items-center gap-2 rounded-md px-1 text-foreground no-underline hover:no-underline"
      >
        {/* Phones: the wordmark alone, so the bar keeps its 44px controls on screen. */}
        <BrandMark className="max-sm:hidden" />
        <Wordmark />
      </Link>

      <PrimaryNav route={route} className="ml-4 hidden md:flex" />

      <div className="ml-auto flex items-center gap-1">
        <ModelLabel />
        <ConnectionsHealth />
        {/* On phones the toggle lives in the navigation sheet, so the bar keeps 44px targets. */}
        <ThemeToggle className="max-sm:hidden" />
        {inspectorAvailable ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={inspectorOpen ? "Close inspector" : "Open inspector"}
            aria-pressed={inspectorOpen}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              inspectorOpen && "bg-muted text-foreground",
            )}
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <PanelRightIcon />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
