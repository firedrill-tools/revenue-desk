"use client";

// revenue-desk patch: the server reports the exact run cost (the Agent SDK's
// total_cost_usd), so cost comes from the `costUsd` prop instead of tokenlens
// price estimates (which do not know every Claude model and were the only
// reason to bundle tokenlens). Rows show token counts only. With no known
// context window (`maxTokens` 0) the percentage and ring are hidden.
// Earlier ai v7 patch kept: reasoningTokens and cacheReadTokens moved to
// outputTokenDetails and inputTokenDetails.

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { LanguageModelUsage } from "ai";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

type ModelId = string;

interface ContextSchema {
  usedTokens: number;
  /** The model's context window; 0 when unknown. */
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
  /** Exact cost reported by the server. */
  costUsd?: number;
}

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error("Context components must be used within Context");
  }

  return context;
};

const usedFraction = ({ usedTokens, maxTokens }: ContextSchema) =>
  maxTokens > 0 ? Math.min(1, usedTokens / maxTokens) : null;

const formatPercent = (fraction: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(fraction);

const formatCompact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    currency: "USD",
    style: "currency",
  }).format(value);

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({
  usedTokens,
  maxTokens,
  usage,
  modelId,
  costUsd,
  ...props
}: ContextProps) => {
  const contextValue = useMemo(
    () => ({ costUsd, maxTokens, modelId, usage, usedTokens }),
    [costUsd, maxTokens, modelId, usage, usedTokens]
  );

  return (
    <ContextContext.Provider value={contextValue}>
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextContext.Provider>
  );
};

const ContextIcon = () => {
  const context = useContextValue();
  const fraction = usedFraction(context);
  if (fraction === null) {
    return null;
  }
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const dashOffset = circumference * (1 - fraction);

  return (
    <svg
      aria-label="Model context usage"
      height="20"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const context = useContextValue();
  const fraction = usedFraction(context);

  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <span className="font-medium text-muted-foreground">
            {fraction === null
              ? formatCompact(context.usedTokens)
              : formatPercent(fraction)}
          </span>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({
  className,
  ...props
}: ContextContentProps) => (
  <HoverCardContent
    className={cn("min-w-60 divide-y overflow-hidden p-0", className)}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const context = useContextValue();
  const fraction = usedFraction(context);

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ??
        (fraction === null ? null : (
          <>
            <div className="flex items-center justify-between gap-3 text-xs">
              <p>{formatPercent(fraction)}</p>
              <p className="font-mono text-muted-foreground">
                {formatCompact(context.usedTokens)} /{" "}
                {formatCompact(context.maxTokens)}
              </p>
            </div>
            <div className="space-y-2">
              <Progress className="bg-muted" value={fraction * PERCENT_MAX} />
            </div>
          </>
        ))}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({
  children,
  className,
  ...props
}: ContextContentBodyProps) => (
  <div className={cn("w-full p-3", className)} {...props}>
    {children}
  </div>
);

export type ContextContentFooterProps = ComponentProps<"div">;

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { costUsd } = useContextValue();

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">Total cost</span>
          <span className="tabular-nums">{formatUsd(costUsd ?? 0)}</span>
        </>
      )}
    </div>
  );
};

const UsageRow = ({
  className,
  label,
  tokens,
  ...props
}: ComponentProps<"div"> & { label: string; tokens: number }) => (
  <div
    className={cn("flex items-center justify-between text-xs", className)}
    {...props}
  >
    <span className="text-muted-foreground">{label}</span>
    <span className="tabular-nums">{formatCompact(tokens)}</span>
  </div>
);

export type ContextInputUsageProps = ComponentProps<"div">;

export const ContextInputUsage = ({
  children,
  ...props
}: ContextInputUsageProps) => {
  const { usage } = useContextValue();
  const inputTokens = usage?.inputTokens ?? 0;

  if (children) {
    return children;
  }
  if (!inputTokens) {
    return null;
  }
  return <UsageRow label="Input" tokens={inputTokens} {...props} />;
};

export type ContextOutputUsageProps = ComponentProps<"div">;

export const ContextOutputUsage = ({
  children,
  ...props
}: ContextOutputUsageProps) => {
  const { usage } = useContextValue();
  const outputTokens = usage?.outputTokens ?? 0;

  if (children) {
    return children;
  }
  if (!outputTokens) {
    return null;
  }
  return <UsageRow label="Output" tokens={outputTokens} {...props} />;
};

export type ContextReasoningUsageProps = ComponentProps<"div">;

export const ContextReasoningUsage = ({
  children,
  ...props
}: ContextReasoningUsageProps) => {
  const { usage } = useContextValue();
  // ai v7: reasoning tokens moved to outputTokenDetails.
  const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens ?? 0;

  if (children) {
    return children;
  }
  if (!reasoningTokens) {
    return null;
  }
  return <UsageRow label="Reasoning" tokens={reasoningTokens} {...props} />;
};

export type ContextCacheUsageProps = ComponentProps<"div">;

export const ContextCacheUsage = ({
  children,
  ...props
}: ContextCacheUsageProps) => {
  const { usage } = useContextValue();
  // ai v7: cached input tokens moved to inputTokenDetails.
  const cacheTokens = usage?.inputTokenDetails?.cacheReadTokens ?? 0;

  if (children) {
    return children;
  }
  if (!cacheTokens) {
    return null;
  }
  return <UsageRow label="Cache" tokens={cacheTokens} {...props} />;
};
