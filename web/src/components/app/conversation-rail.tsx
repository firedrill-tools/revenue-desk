import { ArchiveIcon, EllipsisIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, navigate } from "@/app/router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useConversations } from "@/hooks/use-api";
import { invalidate } from "@/hooks/use-resource";
import { api, errorMessage } from "@/lib/api";
import type { ConversationSummary } from "@/lib/contracts";
import { conversationTitle, groupByRecency } from "@/lib/conversations";
import { formatRelativeTime, pluralize } from "@/lib/format";
import { chatHref, type Route } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useNotify } from "./notices";
import { MetaChip, StatusDot } from "./status";

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function ConversationMarker({ conversation }: { conversation: ConversationSummary }) {
  switch (conversation.status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-brand">
          <Spinner aria-hidden="true" className="size-3" />
          Running
        </span>
      );
    case "awaiting_approval":
      return (
        <span className="inline-flex items-center gap-1.5 text-warning">
          <StatusDot tone="warning" />
          {conversation.pendingApprovals > 1
            ? `${pluralize(conversation.pendingApprovals, "approval")} waiting`
            : "Needs approval"}
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 text-danger">
          <StatusDot tone="danger" />
          Failed
        </span>
      );
    case "idle":
      return null;
  }
}

function ConversationRow({
  conversation,
  selected,
  now,
  onNavigate,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  now: Date;
  onNavigate?: (() => void) | undefined;
}) {
  const notify = useNotify();

  const archive = async () => {
    try {
      await api.request("PATCH /api/conversations/:conversationId", {
        params: { conversationId: conversation.id },
        body: { archived: true },
      });
      invalidate("conversations");
      if (selected) navigate("/", { replace: true });
      notify({ message: "Conversation archived." });
    } catch (error) {
      notify({
        tone: "danger",
        message: errorMessage(error, "The conversation was not archived."),
      });
    }
  };

  return (
    <li className="group/row relative">
      <Link
        href={chatHref(conversation.id)}
        aria-current={selected ? "page" : undefined}
        onClick={onNavigate}
        className={cn(
          "flex flex-col gap-0.5 rounded-md py-2 pr-9 pl-2.5 text-foreground no-underline transition-colors hover:no-underline pointer-coarse:pr-12",
          selected ? "bg-brand-subtle" : "hover:bg-surface-hover",
        )}
      >
        <span className={cn("truncate text-body-sm", selected && "font-medium")}>
          {conversationTitle(conversation)}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
          <ConversationMarker conversation={conversation} />
          {conversation.status === "idle" || conversation.status === "error" ? (
            <span className="truncate">{formatRelativeTime(conversation.updatedAt, now)}</span>
          ) : null}
          {conversation.source === "cli" ? <MetaChip>CLI</MetaChip> : null}
        </span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${conversationTitle(conversation)}`}
            className="absolute top-2 right-1.5 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 aria-expanded:opacity-100 pointer-coarse:top-1/2 pointer-coarse:right-0 pointer-coarse:-translate-y-1/2 pointer-coarse:opacity-100"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={() => void archive()}>
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Title widths of the placeholder rows, keyed by position. */
const RAIL_SKELETON_ROWS = [
  { key: "a", width: "w-40" },
  { key: "b", width: "w-32" },
  { key: "c", width: "w-44" },
  { key: "d", width: "w-28" },
  { key: "e", width: "w-36" },
  { key: "f", width: "w-40" },
  { key: "g", width: "w-24" },
] as const;

function RailSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-1 px-2 pt-1">
      <Skeleton className="mx-2.5 mt-2 mb-3 h-3 w-12" />
      {RAIL_SKELETON_ROWS.map((row) => (
        <div key={row.key} className="space-y-1.5 px-2.5 py-2">
          <Skeleton className={cn("h-3.5", row.width)} />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function ConversationRail({
  route,
  onNavigate,
  header,
}: {
  route: Route;
  onNavigate?: () => void;
  /** Extra content above New chat (the phone sheet puts navigation here). */
  header?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const { data, error, loading, reload } = useConversations(debounced);
  const selectedId = route.name === "chat" ? route.conversationId : null;
  const now = new Date();
  const groups = data ? groupByRecency(data.items, now) : [];

  return (
    <div className="flex min-h-0 w-full flex-col">
      {header}
      <div className="space-y-2 p-3 pb-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 bg-background"
          onClick={() => {
            navigate("/");
            onNavigate?.();
          }}
        >
          <PlusIcon />
          New chat
        </Button>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="h-8 bg-background pl-8 md:text-body-sm"
          />
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">
        {loading ? <RailSkeleton /> : null}
        {error ? (
          <div className="px-4.5 py-3 text-body-sm text-muted-foreground">
            <p>Conversations did not load.</p>
            <Button variant="link" className="h-auto px-0 text-brand" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : null}
        {data && data.items.length === 0 ? (
          <p className="px-4.5 py-3 text-body-sm text-muted-foreground">
            {debounced.trim() === "" ? "No conversations yet." : "No conversations match."}
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label} className="px-2 pt-2">
            <h2 className="px-2.5 pt-1 pb-1.5 font-medium text-meta text-muted-foreground">
              {group.label}
            </h2>
            <ul className="space-y-px">
              {group.items.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  selected={conversation.id === selectedId}
                  now={now}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </section>
        ))}
        {data?.nextCursor ? (
          <p className="px-4.5 pt-3 text-meta text-muted-foreground">
            Showing the 100 most recent. Search to find older conversations.
          </p>
        ) : null}
      </div>
    </div>
  );
}
