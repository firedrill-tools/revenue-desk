import { ArrowRightIcon } from "lucide-react";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { INTEGRATIONS } from "@/lib/contracts";
import { JOB_SUGGESTIONS } from "@/lib/suggestions";

/** One line of copy and the five jobs as suggestion rows. No hero. */
export function ChatEmptyState({
  onPick,
  disabled = false,
}: {
  onPick: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-5">
      <p className="text-body text-muted-foreground">
        Revenue operations across your inbox, Stripe, QuickBooks, HubSpot and Slack. Refunds,
        invoices and outbound email wait for your approval.
      </p>
      <ul aria-label="Suggested jobs" className="divide-y overflow-hidden rounded-xl border">
        {JOB_SUGGESTIONS.map((job) => (
          <li key={job.id}>
            <Suggestion
              suggestion={job.prompt}
              onClick={onPick}
              disabled={disabled}
              variant="ghost"
              className="group/suggestion h-auto w-full items-start justify-between gap-4 whitespace-normal rounded-none px-4 py-3 text-left hover:bg-surface-subtle"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-body text-foreground">{job.title}</span>
                <span className="font-normal text-body-sm text-muted-foreground">
                  {job.systems.map((id) => INTEGRATIONS[id].label).join(" · ")}
                </span>
              </span>
              <ArrowRightIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/suggestion:opacity-100 group-focus-visible/suggestion:opacity-100"
              />
            </Suggestion>
          </li>
        ))}
      </ul>
    </div>
  );
}
