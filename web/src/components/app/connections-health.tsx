import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "@/app/router";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnections } from "@/hooks/use-api";
import type { ConnectionView } from "@/lib/contracts";
import { CONNECTION_STATE_LABELS, type Tone } from "@/lib/labels";
import { KindChip, StatusDot, StatusText } from "./status";

/** The worst state among the connections, for the trigger's dot. */
export function overallTone(connections: readonly ConnectionView[]): Tone {
  const tones = connections.map((connection) => CONNECTION_STATE_LABELS[connection.state].tone);
  if (tones.includes("danger")) return "danger";
  if (tones.includes("warning")) return "warning";
  if (tones.length > 0 && tones.every((tone) => tone === "success")) return "success";
  return "neutral";
}

export function ConnectionsHealth() {
  const { data, error, loading } = useConnections();
  const connections = data ?? [];
  const connected = connections.filter((connection) => connection.state === "connected").length;
  const tone = error ? "danger" : overallTone(connections);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 px-2 text-muted-foreground hover:text-foreground"
          aria-label={
            loading
              ? "Connections: checking"
              : `Connections: ${connected} of ${connections.length} connected`
          }
        >
          <StatusDot tone={loading ? "neutral" : tone} />
          <span className="hidden text-body-sm sm:inline">Connections</span>
          {loading ? null : (
            <span className="text-meta tabular-nums">
              {connected}/{connections.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="flex items-baseline justify-between border-b px-3 py-2.5">
          <p className="font-medium text-body-sm">Connections</p>
          {loading ? null : (
            <p className="text-meta text-muted-foreground tabular-nums">
              {connected} of {connections.length} connected
            </p>
          )}
        </div>
        <ul className="py-1">
          {loading
            ? ["a", "b", "c", "d", "e", "f"].map((key) => (
                <li key={key} className="flex items-center gap-3 px-3 py-2">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="ml-auto h-3.5 w-20" />
                </li>
              ))
            : null}
          {error ? (
            <li className="px-3 py-2 text-body-sm text-muted-foreground">
              Connection status is unavailable.
            </li>
          ) : null}
          {connections.map((connection) => (
            <li key={connection.integration} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 truncate text-body-sm">{connection.label}</span>
              <KindChip kind={connection.kind} />
              <StatusText
                status={CONNECTION_STATE_LABELS[connection.state]}
                className="ml-auto text-meta text-muted-foreground"
              />
            </li>
          ))}
        </ul>
        <div className="border-t p-1">
          <Button asChild variant="ghost" size="sm" className="w-full justify-between text-body-sm">
            <Link
              href="/connections"
              className="text-foreground no-underline hover:no-underline"
              onClick={() => setOpen(false)}
            >
              Manage connections
              <ArrowRightIcon />
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
