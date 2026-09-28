import { Spinner } from "@/components/ui/spinner";
import type { ConnectionKind } from "@/lib/contracts";
import { KIND_LABELS, type StatusLabel, type Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-muted-foreground/45",
  running: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** An 8px status dot. Decorative: always pair it with a text label. */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_TONE[tone], className)}
    />
  );
}

/** Dot (or a 14px spinner for running work) plus label. */
export function StatusText({
  status,
  className,
  spinner = true,
}: {
  status: StatusLabel;
  className?: string;
  /** Show a spinner instead of the dot while running. */
  spinner?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      {status.tone === "running" && spinner ? (
        <Spinner aria-hidden="true" className="size-3.5 text-brand" />
      ) : (
        <StatusDot tone={status.tone} />
      )}
      {status.label}
    </span>
  );
}

/** Neutral outline chip for the connection kind: Composio, MCP, API. */
export function KindChip({ kind, className }: { kind: ConnectionKind; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[4px] border px-1.5 font-medium text-[11px] text-muted-foreground leading-none tracking-wide",
        className,
      )}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

/** A quiet label chip (for example "CLI" or "Local sandbox"). */
export function MetaChip({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[4px] bg-muted px-1.5 font-medium text-[11px] text-muted-foreground leading-none",
        className,
      )}
    >
      {children}
    </span>
  );
}
