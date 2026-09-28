import type { DynamicToolUIPart } from "ai";
import { useId, useState } from "react";
import { Link } from "@/app/router";
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
import {
  APPROVAL_STATE_LABELS,
  approvalFactRows,
  factKind,
  isLongText,
  type ToolApprovalModel,
} from "@/lib/tool-model";
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
    case "stopped":
    case "timed_out":
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

/**
 * The policy's reason in plain words. The server's text is written for the
 * model ("Blocked by policy: … The action was not run; do not retry it."),
 * so the prefix and the instruction to the model are left out.
 */
export function plainBlockedReason(reason: string | null): string {
  const fallback = "The workspace's approval policy does not allow this action.";
  if (reason === null || reason.trim() === "") return fallback;
  const stripped = reason.replace(/^\s*Blocked by policy:\s*/i, "").trim();
  const plain = stripped
    .split(/(?<=[.;])\s+/)
    .filter((sentence) => !/\bretry\b/i.test(sentence) && !/was not run/i.test(sentence))
    .join(" ")
    .trim()
    .replace(/;$/, ".");
  return plain === "" ? fallback : plain;
}

/** One fact of the card: warnings stand out, message bodies keep their lines, metadata is quiet. */
function FactRow({ label, value }: { label: string; value: string }) {
  const kind = factKind(label);
  const long = kind === "text" && isLongText(value);
  const [expanded, setExpanded] = useState(false);
  const valueId = useId();
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-2 text-body-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <dt
        className={cn(
          "text-muted-foreground",
          kind === "warning" && "font-medium text-warning",
          kind === "muted" && "text-meta",
        )}
      >
        {label}
      </dt>
      <dd className="min-w-0">
        <div
          id={valueId}
          className={cn(
            "min-w-0 break-words text-foreground tabular-nums",
            kind === "warning" && "font-medium text-warning",
            kind === "muted" && "font-mono text-meta text-muted-foreground leading-[18px]",
            kind === "text" && "whitespace-pre-wrap",
            long && !expanded && "max-h-40 overflow-hidden",
            kind === "plain" && looksLikeRecordIds(value) && "font-mono text-meta leading-[18px]",
          )}
        >
          {value}
        </div>
        {long ? (
          <button
            type="button"
            className="mt-1 text-meta text-brand hover:underline"
            aria-expanded={expanded}
            aria-controls={valueId}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
      </dd>
    </div>
  );
}

export type ApprovalCardProps = {
  approval: ToolApprovalModel;
  submission?: ApprovalSubmission | undefined;
  /** Absent: read-only (the Runs detail). */
  onDecide?: ((approved: boolean, reason?: string) => void) | undefined;
  /**
   * Rendered inside its call's block (ToolCallBlock): no border or radius of
   * its own, a divider above. A standalone card (a reloaded page's pending
   * approval) keeps its own border.
   */
  attached?: boolean;
  className?: string;
};

export function ApprovalCard({
  approval,
  submission,
  onDecide,
  attached = false,
  className,
}: ApprovalCardProps) {
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
      data-state={approval.state}
      className={cn(
        requested
          ? "gap-0 overflow-hidden p-0 shadow-none"
          : "flex-row items-start gap-2 rounded-lg border-transparent bg-surface-subtle px-3 py-2 text-body-sm",
        attached && "rounded-none border-0 border-t border-border",
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
              <FactRow key={`${row.label}:${row.value}`} label={row.label} value={row.value} />
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
            {noteOpen ? "Hide note" : "Add a note for the agent"}
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
        <StatusDot tone={APPROVAL_STATE_LABELS[approval.state].tone} className="mt-[5px]" />
        {approval.state === "blocked" ? (
          <p className="min-w-0 text-muted-foreground">
            <span className="font-medium text-foreground">Blocked by policy</span>
            <span aria-hidden="true"> · </span>
            {plainBlockedReason(approval.reason ?? facts.consequence)}{" "}
            <Link href="/settings" className="whitespace-nowrap">
              Review the policy
            </Link>
          </p>
        ) : (
          <p className="min-w-0 text-muted-foreground">
            <span className="font-medium text-foreground">
              {APPROVAL_STATE_LABELS[approval.state].label}
            </span>
            <span aria-hidden="true"> · </span>
            {facts.consequence}
            {approval.reason && approval.reason !== facts.consequence ? (
              <span className="mt-0.5 block text-meta">{approval.reason}</span>
            ) : null}
          </p>
        )}
      </ConfirmationRejected>
    </Confirmation>
  );
}
