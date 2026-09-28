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
  /**
   * "compact" for narrow ledgers grouped by kind (the inspector): no
   * integration label (the titles name the system), no kind chip and no
   * "Done" label.
   */
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
        // A compact row stays on one line unless it has a status to spell out
        // (failed, denied, running), which would crowd the title on a phone.
        layout={compact && row.status === "succeeded" ? "inline" : "stacked"}
        meta={
          compact ? undefined : (
            <>
              {row.integrationLabel ? (
                <span className="truncate text-meta text-muted-foreground">
                  {row.integrationLabel}
                </span>
              ) : null}
              {row.kind ? <ToolKindChip>{KIND_LABELS[row.kind]}</ToolKindChip> : null}
            </>
          )
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

function groupStatus(
  rows: readonly ToolRowModel[],
  sources: number,
): { tone: Tone; label: string } {
  const busy = rows.some((row) => !isSettledStatus(row.status));
  const failed = rows.filter((row) => row.status === "failed" || row.status === "rejected").length;
  const stopped = rows.filter(
    (row) => row.status === "stopped" || row.status === "timed_out",
  ).length;
  if (busy) return { tone: "running", label: `Checking ${pluralize(sources, "source")}` };
  const notes = [failed > 0 ? `${failed} failed` : null, stopped > 0 ? `${stopped} stopped` : null]
    .filter((note) => note !== null)
    .join(", ");
  if (notes !== "") {
    return {
      tone: failed > 0 ? "warning" : "neutral",
      label: `Checked ${pluralize(sources, "source")}, ${notes}`,
    };
  }
  return { tone: "success", label: `Checked ${pluralize(sources, "source")}` };
}

/**
 * Three or more consecutive reads, collapsed into one line. A source is a
 * system (Stripe read twice is one source); the call count is shown beside
 * the systems, so "Checked 4 sources" never sits next to six names.
 */
export function ReadsGroup({
  rows,
  timings,
  now,
}: {
  rows: readonly ToolRowModel[];
  timings?: ReadonlyMap<string, ToolTiming>;
  now?: number;
}) {
  const labels = sourceLabels(rows);
  const status = groupStatus(rows, labels.length > 0 ? labels.length : rows.length);
  // The count keeps its unit on the same line when the systems wrap (phones).
  const calls = pluralize(rows.length, "call").replace(" ", "\u00a0");
  const detail = [labels.length > 0 ? joinList(labels) : null, calls]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <Collapsible
      data-slot="tool-reads"
      className="group/reads w-full min-w-0 overflow-hidden rounded-lg border bg-background"
    >
      <CollapsibleTrigger className="grid w-full min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_1rem] items-center gap-x-2.5 gap-y-0.5 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-sm:min-h-11 sm:h-9 sm:grid-cols-[0.875rem_max-content_minmax(0,1fr)_1rem] sm:py-0">
        <span className="col-start-1 row-start-1 flex h-5 justify-center sm:h-auto">
          <ToolStatusDot tone={status.tone} className="self-center" />
        </span>
        <span className="col-start-2 row-start-1 font-medium text-body-sm">{status.label}</span>
        <span className="col-start-2 row-start-2 min-w-0 text-meta text-muted-foreground sm:col-start-3 sm:row-start-1 sm:truncate">
          {detail}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="col-start-3 row-span-2 row-start-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/reads:rotate-90 sm:col-start-4 sm:row-span-1"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="divide-y border-t">
        {rows.map((row) => (
          <ToolCallRow
            key={row.toolCallId}
            row={row}
            timing={timings?.get(row.toolCallId)}
            {...(now === undefined ? {} : { now })}
            variant="flat"
            className="rounded-none"
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Consecutive calls with no text or approval between them: one bordered list. */
export function ToolCallList({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="tool-list"
      className="w-full min-w-0 divide-y overflow-hidden rounded-lg border bg-background"
    >
      {children}
    </div>
  );
}

/**
 * A call and its approval as one unit: the row (render it with
 * variant="flat") with the decision attached beneath it. `attention` marks a
 * decision that is still waiting for a person.
 */
export function ToolCallBlock({
  children,
  approval,
  attention = false,
}: {
  children: ReactNode;
  approval: ReactNode;
  attention?: boolean;
}) {
  return (
    <div
      data-slot="tool-block"
      data-attention={attention ? "" : undefined}
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-lg border bg-background",
        attention && "border-warning/45",
      )}
    >
      {children}
      {approval}
    </div>
  );
}
