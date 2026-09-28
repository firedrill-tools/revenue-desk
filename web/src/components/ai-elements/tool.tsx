"use client";

// revenue-desk patch (docs/ARCHITECTURE.md §9, Appendix A): restyled.
// - The yellow/green/blue rounded-full badges become a status dot (a 14px
//   spinner while running) plus a plain label.
// - ToolHeader takes `status` (tone and label), `meta` (integration label and
//   the neutral connection-kind chip) and `trailing` (tabular duration or live
//   elapsed time) slots.
// - #490: ToolInput returns null while the input is still streaming.
// - Input and output render through the app's lean CodeBlock and scroll
//   inside their own block.

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "group/tool not-prose w-full min-w-0 rounded-lg border bg-background",
      className
    )}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolStatusTone =
  | "neutral"
  | "running"
  | "success"
  | "warning"
  | "danger";

export type ToolStatusValue = { tone: ToolStatusTone; label: string };

const statusByState: Record<ToolPart["state"], ToolStatusValue> = {
  "approval-requested": { tone: "warning", label: "Awaiting approval" },
  "approval-responded": { tone: "neutral", label: "Decided" },
  "input-available": { tone: "running", label: "Running" },
  "input-streaming": { tone: "neutral", label: "Preparing" },
  "output-available": { tone: "success", label: "Done" },
  "output-denied": { tone: "danger", label: "Denied" },
  "output-error": { tone: "danger", label: "Failed" },
};

const dotTone: Record<ToolStatusTone, string> = {
  neutral: "bg-muted-foreground/45",
  running: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export const getToolStatus = (state: ToolPart["state"]): ToolStatusValue =>
  statusByState[state];

export type ToolStatusDotProps = { tone: ToolStatusTone; className?: string };

/** A 8px dot, or a 14px spinner while running. Decorative: pair it with a label. */
export const ToolStatusDot = ({ tone, className }: ToolStatusDotProps) =>
  tone === "running" ? (
    <Spinner
      aria-hidden="true"
      className={cn("size-3.5 shrink-0 text-brand", className)}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        dotTone[tone],
        className
      )}
    />
  );

/** Neutral outline chip naming how a call reaches its system: Composio, MCP, API. */
export const ToolKindChip = ({
  className,
  ...props
}: ComponentProps<"span">) => (
  <span
    className={cn(
      "inline-flex h-[18px] shrink-0 items-center rounded-[4px] border px-1.5 font-medium text-[11px] text-muted-foreground leading-none tracking-wide",
      className
    )}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  className?: string;
  /** Overrides the label derived from `state`. */
  status?: ToolStatusValue;
  /** After the title: the integration label and the kind chip. */
  meta?: ReactNode;
  /** Right side, before the chevron: duration or live elapsed time. */
  trailing?: ReactNode;
  /**
   * The status label: always visible, visible from the sm breakpoint, or
   * only for screen readers (the dot remains visible in every case).
   */
  statusLabel?: "visible" | "responsive" | "hidden";
  /**
   * "stacked" (default): one line from the sm breakpoint; on phones the meta,
   * status and time move to a second line under the title. "inline": always
   * one line, for narrow ledgers without meta (the inspector).
   */
  layout?: "stacked" | "inline";
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  status,
  meta,
  trailing,
  statusLabel = "visible",
  layout = "stacked",
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const resolved = status ?? getToolStatus(state);

  const label = (
    <span
      className={cn(
        statusLabel === "responsive" && "sr-only sm:not-sr-only",
        statusLabel === "hidden" && "sr-only"
      )}
    >
      {resolved.label}
    </span>
  );

  if (layout === "inline") {
    return (
      <CollapsibleTrigger
        className={cn(
          "grid h-9 w-full min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_auto_1rem] items-center gap-x-2.5 rounded-lg px-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-sm:h-11",
          className
        )}
        {...props}
      >
        <span className="flex justify-center">
          <ToolStatusDot tone={resolved.tone} />
        </span>
        <span className="truncate font-medium text-body-sm text-foreground">
          {title ?? derivedName}
        </span>
        <span className="flex shrink-0 items-center justify-end gap-2 text-meta text-muted-foreground tabular-nums">
          {label}
          {trailing}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/tool:rotate-90"
        />
      </CollapsibleTrigger>
    );
  }

  // revenue-desk patch: one line from the sm breakpoint; on phones the title
  // gets its own line (never truncated to a few letters) and the meta, status
  // and time move to a second line, which also makes the row a 44px target.
  return (
    <CollapsibleTrigger
      className={cn(
        "grid w-full min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_auto_1rem] items-center gap-x-2.5 gap-y-0.5 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-sm:min-h-11 sm:h-9 sm:grid-cols-[0.875rem_minmax(0,max-content)_minmax(0,1fr)_auto_1rem] sm:py-0",
        className
      )}
      {...props}
    >
      <span className="col-start-1 row-start-1 flex h-5 justify-center self-start sm:h-auto sm:self-center">
        <ToolStatusDot tone={resolved.tone} className="self-center" />
      </span>
      <span className="col-span-2 col-start-2 row-start-1 truncate font-medium text-body-sm text-foreground sm:col-span-1">
        {title ?? derivedName}
      </span>
      <span className="col-start-2 row-start-2 flex min-w-0 items-center gap-2 empty:hidden sm:col-start-3 sm:row-start-1">
        {meta}
      </span>
      <span className="col-start-3 row-start-2 flex shrink-0 items-center justify-end gap-2 text-meta text-muted-foreground tabular-nums sm:col-start-4 sm:row-start-1">
        {label}
        {trailing}
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className="col-start-4 row-span-2 row-start-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/tool:rotate-90 sm:col-start-5 sm:row-span-1"
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "space-y-3 border-t px-3 py-3 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
);

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <h4 className="font-medium text-meta text-muted-foreground">{children}</h4>
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  // revenue-desk patch (#490): input is undefined while it is still streaming,
  // and JSON.stringify(undefined) is undefined, which crashed CodeBlock.
  if (input === undefined) {
    return null;
  }

  return (
    <div className={cn("min-w-0 space-y-1.5", className)} {...props}>
      <SectionLabel>Input</SectionLabel>
      <CodeBlock code={JSON.stringify(input, null, 2) ?? ""} language="json" />
    </div>
  );
};

/** How an output is shown: JSON is pretty-printed and highlighted, text stays text. */
export type ToolOutputView = { language: "json" | "text"; code: string };

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolOutputView | null;
  errorText: string | null | undefined;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  return (
    <div className={cn("min-w-0 space-y-1.5", className)} {...props}>
      <SectionLabel>{errorText ? "Error" : "Result"}</SectionLabel>
      {errorText ? (
        <p className="whitespace-pre-wrap break-words rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-body-sm text-danger">
          {errorText}
        </p>
      ) : null}
      {output ? <CodeBlock code={output.code} language={output.language} /> : null}
    </div>
  );
};
