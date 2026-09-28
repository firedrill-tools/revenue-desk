import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A scrolling screen with a centred column (Runs, Connections, Settings). */
export function Page({
  children,
  width = "wide",
}: {
  children: ReactNode;
  width?: "wide" | "narrow";
}) {
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto w-full px-4 pt-6 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-8",
          width === "wide" ? "max-w-[1120px]" : "max-w-[760px]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-1">
        <h1 className="font-semibold text-xl tracking-[-0.01em]">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-body text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A bordered panel (10px radius) for tables and forms. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border bg-background", className)}>{children}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-body text-muted-foreground">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="font-medium text-body-sm text-brand hover:underline"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
