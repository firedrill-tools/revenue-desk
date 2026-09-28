import type { DynamicToolUIPart } from "ai";
import { useId, useState } from "react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/hooks/use-now";
import { INTEGRATIONS } from "@/lib/contracts";
import { formatCountdown, looksLikeRecordIds, msUntil } from "@/lib/format";
import { ACTION_CLASS_LABELS, isHighRiskClass } from "@/lib/labels";
import { approvalFactRows, type ToolApprovalModel } from "@/lib/tool-model";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status";

/** A decision in flight: pending until the server's tool-approval-response chunk arrives. */
export type ApprovalSubmission = {
  readonly approved: boolean;
  readonly status: "sending" | "failed";
  readonly error?: string;
};

type ConfirmationApproval = NonNullable<DynamicToolUIPart["approval"]>;

/** The AI SDK approval and part state that Confirmation switches on. */
function confirmationProps(approval: ToolApprovalModel): {
  approval: ConfirmationApproval;
  state: DynamicToolUIPart["state"];
} {
  switch (approval.state) {
    case "requested":
      return { approval: { id: approval.id }, state: "approval-requested" };
    case "approved":
      return {
        approval: {
          id: approval.id,
          approved: true,
          ...(approval.reason ? { reason: approval.reason } : {}),
        },
        state: "approval-responded",
      };
    case "denied":
    case "blocked":
      return {
        approval: {
          id: approval.id,
          approved: false,
          isAutomatic: approval.state === "blocked",
          ...(approval.reason ? { reason: approval.reason } : {}),
        },
        state: "output-denied",
      };
  }
}

function Expiry({ expiresAt }: { expiresAt: string }) {
  const now = useNow(1_000);
  const remaining = msUntil(expiresAt, now);
  if (remaining === null) return null;
  return (
    <span className="tabular-nums">
      {remaining === 0 ? "Expiring" : `Expires in ${formatCountdown(remaining)}`}
    </span>
  );
}

export type ApprovalCardProps = {
  approval: ToolApprovalModel;
  submission?: ApprovalSubmission | undefined;
  /** Absent: read-only (the Runs detail). */
  onDecide?: ((approved: boolean, reason?: string) => void) | undefined;
  className?: string;
};

export function ApprovalCard({ approval, submission, onDecide, className }: ApprovalCardProps) {
  const { facts } = approval;
  const rows = approvalFactRows(facts);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const highRisk = isHighRiskClass(facts.actionClass);
  const sending = submission?.status === "sending";
  const requested = approval.state === "requested";
  const props = confirmationProps(approval);
  const meta: string[] = [];
  if (facts.actionClass) meta.push(ACTION_CLASS_LABELS[facts.actionClass]);
  if (facts.integration) meta.push(INTEGRATIONS[facts.integration].label);

  const decide = (approved: boolean) => onDecide?.(approved, note.trim() === "" ? undefined : note);

  return (
    <Confirmation
      approval={props.approval}
      state={props.state}
      aria-label={requested ? `Approval needed: ${facts.consequence}` : undefined}
      className={cn(
        requested
          ? "gap-0 overflow-hidden p-0 shadow-none"
          : "flex-row items-start gap-2 rounded-lg border-transparent bg-surface-subtle px-3 py-2 text-body-sm",
        className,
      )}
    >
      <ConfirmationRequest>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3.5">
          <span className="inline-flex items-center gap-1.5 font-medium text-meta text-warning">
            <StatusDot tone="warning" />
            Approval needed
          </span>
          <span className="flex items-center gap-2 text-meta text-muted-foreground">
            {meta.length > 0 ? <span>{meta.join(" · ")}</span> : null}
            {facts.expiresAt ? <Expiry expiresAt={facts.expiresAt} /> : null}
          </span>
        </div>
        <ConfirmationTitle className="px-4 pt-1.5 font-semibold text-[15px] leading-6">
          {facts.consequence}
        </ConfirmationTitle>
        {rows.length > 0 ? (
          <dl className="mx-4 mt-3 divide-y border-y">
            {rows.map((row) => (
              <div
                key={`${row.label}:${row.value}`}
                className="grid grid-cols-[minmax(5.5rem,32%)_1fr] gap-3 py-2 text-body-sm"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd
                  className={cn(
                    "min-w-0 break-words text-foreground tabular-nums",
                    looksLikeRecordIds(row.value) && "font-mono text-meta leading-[18px]",
                  )}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {noteOpen && onDecide ? (
          <div className="px-4 pt-3">
            <label htmlFor={noteId} className="mb-1.5 block text-meta text-muted-foreground">
              Note for the agent (optional)
            </label>
            <Textarea
              id={noteId}
              value={note}
              maxLength={500}
              disabled={sending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="For example: refund only after the customer confirms the card."
              className="min-h-14 md:text-body-sm"
            />
          </div>
        ) : null}
        {submission?.status === "failed" ? (
          <p className="px-4 pt-3 text-body-sm text-danger">{submission.error}</p>
        ) : null}
        {!onDecide ? (
          <p className="px-4 py-3 text-body-sm text-muted-foreground">
            Waiting for a decision in the conversation.
          </p>
        ) : null}
      </ConfirmationRequest>

      {onDecide ? (
        <ConfirmationActions className="w-full justify-between gap-2 self-stretch px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 text-muted-foreground"
            disabled={sending}
            aria-expanded={noteOpen}
            onClick={() => setNoteOpen((open) => !open)}
          >
            {noteOpen ? "Hide note" : "Add a note"}
          </Button>
          <span className="flex items-center gap-2">
            <ConfirmationAction variant="outline" disabled={sending} onClick={() => decide(false)}>
              {sending && submission?.approved === false ? (
                <Spinner aria-hidden="true" className="size-3.5" />
              ) : null}
              Deny
            </ConfirmationAction>
            <ConfirmationAction
              disabled={sending}
              className={cn(
                "h-8 px-3 text-sm",
                highRisk && "bg-danger text-danger-foreground hover:bg-danger/90",
              )}
              onClick={() => decide(true)}
            >
              {sending && submission?.approved ? (
                <Spinner aria-hidden="true" className="size-3.5" />
              ) : null}
              Approve
            </ConfirmationAction>
          </span>
        </ConfirmationActions>
      ) : null}

      <ConfirmationAccepted>
        <StatusDot tone="success" className="mt-[5px]" />
        <p className="min-w-0 text-muted-foreground">
          <span className="font-medium text-foreground">Approved</span>
          <span aria-hidden="true"> · </span>
          {facts.consequence}
        </p>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <StatusDot
          tone={approval.state === "blocked" ? "neutral" : "danger"}
          className="mt-[5px]"
        />
        <p className="min-w-0 text-muted-foreground">
          <span className="font-medium text-foreground">
            {approval.state === "blocked" ? "Blocked by policy" : "Denied"}
          </span>
          <span aria-hidden="true"> · </span>
          {facts.consequence}
          {approval.reason ? (
            <span className="mt-0.5 block text-meta">{approval.reason}</span>
          ) : null}
        </p>
      </ConfirmationRejected>
    </Confirmation>
  );
}
