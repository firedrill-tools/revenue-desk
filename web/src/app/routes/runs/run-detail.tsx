import { ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/app/router";
import { ApprovalCard } from "@/components/app/approval-card";
import { ErrorState } from "@/components/app/page";
import { KindChip, MetaChip, StatusDot, StatusText } from "@/components/app/status";
import { ToolCallBlock, ToolCallRow } from "@/components/app/tool-call";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunDetail } from "@/hooks/use-api";
import { PHONE_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { errorMessage } from "@/lib/api";
import { ACTION_CLASSES, INTEGRATIONS, type RunDetailView } from "@/lib/contracts";
import { focusPanelOnOpen } from "@/lib/focus";
import { formatCost, formatCount, formatDateTime, formatDuration, shortId } from "@/lib/format";
import {
  ACTION_CLASS_LABELS,
  APPROVAL_MODE_LABELS,
  APPROVAL_STATUS_LABELS,
  RUN_STATUS_LABELS,
} from "@/lib/labels";
import { chatHref } from "@/lib/routes";
import { toolRowFromView } from "@/lib/tool-model";

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium text-body-sm">{title}</h3>
        {aside ? <span className="text-meta text-muted-foreground">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="space-y-0.5 bg-background px-3 py-2.5">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="font-medium text-body tabular-nums">{value === "" ? "–" : value}</dd>
      {sub ? <dd className="text-meta text-muted-foreground tabular-nums">{sub}</dd> : null}
    </div>
  );
}

const DECIDER_LABELS = {
  user: "you",
  timeout: "timeout",
  stop: "stop",
  restart: "server restart",
} as const;

function RunDetailBody({ run }: { run: RunDetailView }) {
  const usage = run.usage;
  const duration = usage
    ? formatDuration(usage.durationMs)
    : run.finishedAt
      ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
      : "";

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        <Stat
          label="Duration"
          value={duration}
          {...(usage ? { sub: `API ${formatDuration(usage.durationApiMs)}` } : {})}
        />
        <Stat label="Cost" value={usage ? formatCost(usage.costUsd) : ""} />
        <Stat
          label="Tokens"
          value={usage ? formatCount(usage.inputTokens + usage.outputTokens) : ""}
          {...(usage
            ? {
                sub: `${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out`,
              }
            : {})}
        />
        <Stat
          label="Turns"
          value={usage ? String(usage.numTurns) : ""}
          {...(usage ? { sub: `${usage.modelRequests} model requests` } : {})}
        />
      </dl>

      {run.error ? (
        <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2.5 text-body-sm text-danger">
          {run.error.message}
        </p>
      ) : null}

      <Section
        title="Tool calls"
        aside={run.toolCalls.length > 0 ? String(run.toolCalls.length) : undefined}
      >
        {run.toolCalls.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">This run called no tools.</p>
        ) : (
          <div className="space-y-2">
            {run.toolCalls.map((call) => {
              const row = toolRowFromView(call, run.approvals);
              return (
                <ToolCallBlock
                  key={call.id}
                  approval={row.approval ? <ApprovalCard approval={row.approval} /> : null}
                >
                  <ToolCallRow row={row} />
                </ToolCallBlock>
              );
            })}
          </div>
        )}
      </Section>

      {run.approvals.length > 0 ? (
        <Section title="Approvals" aside={String(run.approvals.length)}>
          <ul className="divide-y rounded-lg border">
            {run.approvals.map((approval) => (
              <li key={approval.id} className="space-y-1 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-body-sm">{approval.consequence}</p>
                  <StatusText
                    status={APPROVAL_STATUS_LABELS[approval.status]}
                    className="text-meta text-muted-foreground"
                  />
                </div>
                <p className="text-meta text-muted-foreground">
                  {ACTION_CLASS_LABELS[approval.actionClass]} · requested{" "}
                  {formatDateTime(approval.requestedAt)}
                  {approval.decidedBy
                    ? ` · decided by ${DECIDER_LABELS[approval.decidedBy]}${approval.decidedAt ? ` ${formatDateTime(approval.decidedAt)}` : ""}`
                    : ""}
                </p>
                {approval.reason ? (
                  <p className="text-meta text-muted-foreground">“{approval.reason}”</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Connections">
        <ul className="divide-y rounded-lg border">
          {run.connections.map((connection) => (
            <li key={connection.integration} className="flex items-start gap-2.5 px-3 py-2">
              <StatusDot
                tone={connection.availability === "ready" ? "success" : "warning"}
                className="mt-[5px]"
              />
              <div className="min-w-0 flex-1">
                <p className="text-body-sm">{INTEGRATIONS[connection.integration].label}</p>
                <p className="text-meta text-muted-foreground">
                  {connection.availability === "ready"
                    ? "Ready"
                    : (connection.detail ?? "Unavailable")}
                  {connection.endpointLabel ? ` · ${connection.endpointLabel}` : ""}
                </p>
              </div>
              <KindChip kind={connection.kind} className="mt-px" />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Approval policy">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-5">
          {ACTION_CLASSES.map((actionClass) => (
            <div key={actionClass} className="space-y-0.5 bg-background px-3 py-2">
              <dt className="text-meta text-muted-foreground">
                {ACTION_CLASS_LABELS[actionClass]}
              </dt>
              <dd className="font-medium text-body-sm">
                {APPROVAL_MODE_LABELS[run.policy[actionClass]]}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <p className="font-mono text-[11px] text-muted-foreground">
        {run.id}
        {run.terminalReason ? ` · ${run.terminalReason}` : ""}
        {run.stopReason ? ` · stop: ${run.stopReason}` : ""}
      </p>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <Skeleton className="h-[72px] w-full rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-9 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function RunDetailSheet({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const { data: run, error, loading, reload } = useRunDetail(runId);

  return (
    <Sheet open={runId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side={phone ? "bottom" : "right"}
        onOpenAutoFocus={focusPanelOnOpen}
        className={
          phone
            ? "gap-0 rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)] outline-none data-[side=bottom]:h-[92dvh]"
            : "gap-0 p-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]"
        }
      >
        <div className="border-b px-5 pt-4 pb-3.5 pr-12">
          <SheetTitle className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-semibold text-base">
            Run
            {runId ? (
              <span className="font-mono font-normal text-meta text-muted-foreground">
                {shortId(runId, 12)}
              </span>
            ) : null}
            {run ? (
              <StatusText
                status={RUN_STATUS_LABELS[run.status]}
                className="font-normal text-body-sm"
              />
            ) : null}
          </SheetTitle>
          <SheetDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
            {run ? (
              <>
                <span>{formatDateTime(run.startedAt)}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">
                  {run.model} / {run.effort}
                </span>
                <MetaChip>{run.source === "cli" ? "CLI" : "App"}</MetaChip>
                {run.mode === "headless" ? <MetaChip>Headless</MetaChip> : null}
                <Link
                  href={chatHref(run.conversationId)}
                  className="ml-auto inline-flex items-center gap-1 no-underline hover:underline"
                >
                  Open conversation
                  <ArrowUpRightIcon className="size-3.5" />
                </Link>
              </>
            ) : (
              <span>Loading run</span>
            )}
          </SheetDescription>
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          {loading ? <DetailSkeleton /> : null}
          {error ? (
            <ErrorState message={errorMessage(error, "The run did not load.")} onRetry={reload} />
          ) : null}
          {run ? <RunDetailBody run={run} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
