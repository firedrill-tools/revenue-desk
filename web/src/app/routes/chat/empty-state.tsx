import { ArrowRightIcon, CircleAlertIcon } from "lucide-react";
import { Link } from "@/app/router";
import { useSession } from "@/app/session";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { StatusDot } from "@/components/app/status";
import { useConnections, useConversations, usePolicies, useSettings } from "@/hooks/use-api";
import { awaitingConversations, conversationTitle, waitingMarker } from "@/lib/conversations";
import { chatHref } from "@/lib/routes";
import {
  approvalSentence,
  connectedCount,
  type JobSuggestion,
  jobSuggestions,
  jobSystems,
} from "@/lib/suggestions";

/** Why nothing can run yet, when the server has no model key. */
export function ModelKeyMissing() {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/5 px-3 py-2.5 text-body-sm"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        <span className="font-medium">Revenue Desk can't run yet:</span> ANTHROPIC_API_KEY is not
        set. Add it to the file <code className="font-mono text-meta">DOTENV_PATH</code> names
        (README › Setup, step 3) and restart the server.
      </p>
    </div>
  );
}

/** Conversations whose approval waits for the user, so a new chat does not hide them. */
function WaitingForYou() {
  const { data } = useConversations("");
  const waiting = awaitingConversations(data?.items ?? []);
  if (waiting.length === 0) return null;
  return (
    <section aria-labelledby="waiting-heading" className="space-y-2">
      <h2 id="waiting-heading" className="font-medium text-body-sm text-warning">
        Waiting for your decision
      </h2>
      <ul className="divide-y overflow-hidden rounded-xl border border-warning/35">
        {waiting.map((conversation) => (
          <li key={conversation.id}>
            <Link
              href={chatHref(conversation.id)}
              className="flex flex-col gap-0.5 px-4 py-2.5 text-foreground no-underline hover:bg-surface-subtle hover:no-underline"
            >
              <span className="font-medium text-body">{conversationTitle(conversation)}</span>
              <span className="inline-flex min-w-0 items-center gap-1.5 text-body-sm text-warning">
                <StatusDot tone="warning" />
                <span className="truncate">{waitingMarker(conversation)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One line of copy and the five jobs as suggestion rows. No hero. Built from
 * the workspace: jobs post to its notices channel, systems that are not
 * connected are marked, and the approval line follows the saved policy.
 */
export function ChatEmptyState({
  onPick,
  disabled = false,
  showWaiting = false,
}: {
  /** The job's prompt is sent; its title names the conversation. */
  onPick: (job: JobSuggestion) => void;
  disabled?: boolean;
  /** List the conversations waiting for an approval (the new-chat screen). */
  showWaiting?: boolean;
}) {
  const session = useSession();
  const connections = useConnections().data ?? null;
  const policies = usePolicies().data ?? null;
  const settings = useSettings().data ?? null;
  const modelMissing = session?.modelConfigured === false;
  const jobs = jobSuggestions(settings?.notifySlackChannel ?? null);
  const count = connections === null ? null : connectedCount(connections);

  return (
    <div className="flex w-full flex-col gap-5">
      {modelMissing ? <ModelKeyMissing /> : null}
      {showWaiting ? <WaitingForYou /> : null}
      <div className="space-y-1.5">
        <p className="text-body text-muted-foreground">
          Revenue operations across your inbox, Stripe, QuickBooks, HubSpot and Slack.{" "}
          {approvalSentence(policies)}
        </p>
        {count !== null && count.connected < count.total ? (
          <p className="text-body-sm text-muted-foreground">
            {count.connected} of {count.total} systems are connected.{" "}
            <Link href="/connections">Set up connections →</Link>
          </p>
        ) : null}
      </div>
      <ul aria-label="Suggested jobs" className="divide-y overflow-hidden rounded-xl border">
        {jobs.map((job) => (
          <li key={job.id}>
            <Suggestion
              suggestion={job.prompt}
              onClick={() => onPick(job)}
              disabled={disabled || modelMissing}
              variant="ghost"
              className="group/suggestion h-auto w-full items-start justify-between gap-4 whitespace-normal rounded-none px-4 py-3 text-left hover:bg-surface-subtle"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-body text-foreground">{job.title}</span>
                <span className="font-normal text-body-sm text-muted-foreground">
                  {jobSystems(job, connections).map((system, index) => (
                    <span key={system.label}>
                      {index > 0 ? " · " : ""}
                      {system.connected ? (
                        system.label
                      ) : (
                        <span className="text-warning">{system.label} (not connected)</span>
                      )}
                    </span>
                  ))}
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
