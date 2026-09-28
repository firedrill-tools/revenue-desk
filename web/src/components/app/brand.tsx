import { cn } from "@/lib/utils";

/** The product mark (the favicon's ledger bars) and wordmark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-5 shrink-0 rounded-[5px]", className)}
    >
      <rect width="32" height="32" rx="7" className="fill-foreground" />
      <rect x="9" y="9" width="4" height="14" rx="1" className="fill-background" />
      <rect x="15" y="14" width="4" height="9" rx="1" className="fill-background" />
      <rect x="21" y="11" width="4" height="12" rx="1" className="fill-brand" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("whitespace-nowrap font-semibold text-[15px] tracking-[-0.01em]", className)}
    >
      Revenue Desk
    </span>
  );
}
