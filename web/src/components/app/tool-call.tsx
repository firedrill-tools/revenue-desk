import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolKindChip,
  ToolOutput,
  ToolStatusDot,
} from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration, formatElapsed, joinList, pluralize } from "@/lib/format";
import { isSettledStatus, KIND_LABELS, TOOL_ROW_STATUS_LABELS, type Tone } from "@/lib/labels";
import { presentValue } from "@/lib/present";
import { sourceLabels, type ToolRowModel } from "@/lib/tool-model";
import { cn } from "@/lib/utils";

/** When the chat first saw a call run, and when it settled (client clock). */
export type ToolTiming = { readonly startedAt: number; readonly finishedAt: number | null };

function durationLabel(row: ToolRowModel, timing: ToolTiming | undefined, now: number): string {
  if (!isSettledStatus(row.status)) {
    return row.status === "running" && timing ? formatElapsed(now - timing.startedAt) : "";
  }
  if (row.durationMs !== null) return formatDuration(row.durationMs);
  if (timing?.finishedAt) return formatDuration(timing.finishedAt - timing.startedAt);
  return "";
}

export type ToolCallRowProps = {
  row: ToolRowModel;
  timing?: ToolTiming | undefined;
  /** The ticking clock for live elapsed time. */
  now?: number;
  /** "flat" inside a group: no border of its own. */
  variant?: "card" | "flat";
  /** "compact" for narrow ledgers: no kind chip and no "Done" label. */
  density?: "full" | "compact";
  defaultOpen?: boolean;
  className?: string;
};

export function ToolCallRow({
  row,
  timing,
  now = Date.now(),
  variant = "card",
  density = "full",
  defaultOpen = false,
  className,
}: ToolCallRowProps) {
  const compact = density === "compact";
  const output = useMemo(() => presentValue(row.output), [row.output]);
  const duration = durationLabel(row, timing, now);

  return (
    <Tool
      defaultOpen={defaultOpen}
      className={cn(variant === "flat" && "border-0 bg-transparent", className)}
      data-status={row.status}
    >
      <ToolHeader
        type="dynamic-tool"
        state="input-available"
        toolName={row.toolName}
        title={row.title}
        status={TOOL_ROW_STATUS_LABELS[row.status]}
        statusLabel={row.status !== "succeeded" ? "visible" : compact ? "hidden" : "responsive"}
        meta={
          <>
            {row.integrationLabel ? (
              <span
                className={cn(
                  "truncate text-meta text-muted-foreground",
                  compact ? "inline" : "hidden sm:inline",
                )}
              >
                {row.integrationLabel}
              </span>
            ) : null}
            {row.kind && !compact ? <ToolKindChip>{KIND_LABELS[row.kind]}</ToolKindChip> : null}
          </>
        }
        trailing={
          duration === "" ? null : (
            <span className="min-w-[3.25rem] text-right tabular-nums">{duration}</span>
          )
        }
      />
      <ToolContent>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
          {row.integrationLabel ? <span>{row.integrationLabel}</span> : null}
          <code className="break-all font-mono text-[11px]">{row.operation ?? row.toolName}</code>
        </p>
        <ToolInput input={row.input} />
        <ToolOutput output={output} errorText={row.errorText} />
      </ToolContent>
    </Tool>
  );
}

function groupStatus(rows: readonly ToolRowModel[]): { tone: Tone; label: string } {
  const count = rows.length;
  const busy = rows.some((row) => !isSettledStatus(row.status));
  const failed = rows.filter((row) => row.status === "failed" || row.status === "rejected").length;
  const stopped = rows.filter(
    (row) => row.status === "stopped" || row.status === "timed_out",
  ).length;
  if (busy) return { tone: "running", label: `Checking ${pluralize(count, "source")}` };
  const notes = [failed > 0 ? `${failed} failed` : null, stopped > 0 ? `${stopped} stopped` : null]
    .filter((note) => note !== null)
    .join(", ");
  if (notes !== "") {
    return {
      tone: failed > 0 ? "warning" : "neutral",
      label: `Checked ${pluralize(count, "source")}, ${notes}`,
    };
  }
  return { tone: "success", label: `Checked ${pluralize(count, "source")}` };
}

/** Three or more consecutive reads, collapsed into one line. */
export function ReadsGroup({
  rows,
  timings,
  now,
}: {
  rows: readonly ToolRowModel[];
  timings?: ReadonlyMap<string, ToolTiming>;
  now?: number;
}) {
  const status = groupStatus(rows);
  const labels = sourceLabels(rows);

  return (
    <Collapsible className="group/reads w-full min-w-0 rounded-lg border bg-background">
      <CollapsibleTrigger className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex w-3.5 shrink-0 justify-center">
          <ToolStatusDot tone={status.tone} />
        </span>
        <span className="shrink-0 font-medium text-body-sm">{status.label}</span>
        <span className="min-w-0 truncate text-meta text-muted-foreground">{joinList(labels)}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/reads:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-px border-t p-1">
        {rows.map((row) => (
          <ToolCallRow
            key={row.toolCallId}
            row={row}
            timing={timings?.get(row.toolCallId)}
            {...(now === undefined ? {} : { now })}
            variant="flat"
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A tool row with its approval card beneath it. */
export function ToolCallBlock({
  children,
  approval,
}: {
  children: ReactNode;
  approval: ReactNode;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {children}
      {approval}
    </div>
  );
}
