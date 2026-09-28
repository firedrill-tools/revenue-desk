import { ArrowUpRightIcon } from "lucide-react";
import { Link } from "@/app/router";
import type { InspectorTab } from "@/app/shell-context";
import { KindChip, StatusDot, StatusText } from "@/components/app/status";
import { ToolCallRow, type ToolTiming } from "@/components/app/tool-call";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RunDetailView } from "@/lib/contracts";
import { INTEGRATIONS } from "@/lib/contracts";
import {
  formatCost,
  formatCount,
  formatDuration,
  formatRelativeTime,
  pluralize,
} from "@/lib/format";
import { KIND_LABELS, KIND_ORDER, RUN_STATUS_LABELS, type Tone } from "@/lib/labels";
import type { ConversationUsage } from "@/lib/messages";
import { runHref } from "@/lib/routes";
import type { ToolRowModel } from "@/lib/tool-model";

export type InspectorData = {
  readonly rows: readonly ToolRowModel[];
  readonly usage: ConversationUsage;
  readonly latestRunId: string | null;
  readonly latestRun: RunDetailView | undefined;
  readonly timings: ReadonlyMap<string, ToolTiming>;
  readonly now: number;
};

function SectionTitle({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-baseline justify-between px-1 pb-1.5">
      <h3 className="font-medium text-meta text-muted-foreground">{children}</h3>
      {aside ? <span className="text-meta text-muted-foreground tabular-nums">{aside}</span> : null}
    </div>
  );
}

function ActivityTab({ data }: { data: InspectorData }) {
  const approvals = data.rows.flatMap((row) =>
    row.approval ? [{ row, approval: row.approval }] : [],
  );
  if (data.rows.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-body-sm text-muted-foreground">
        Tool calls appear here as the agent works.
      </p>
    );
  }
  return (
    <div className="space-y-5">
      {KIND_ORDER.map((kind) => {
        const rows = data.rows.filter((row) => row.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} aria-label={`${KIND_LABELS[kind]} calls`}>
            <SectionTitle aside={pluralize(rows.length, "call")}>{KIND_LABELS[kind]}</SectionTitle>
            <div className="divide-y rounded-lg border">
              {rows.map((row) => (
                <ToolCallRow
                  key={row.toolCallId}
                  row={row}
                  timing={data.timings.get(row.toolCallId)}
                  now={data.now}
                  variant="flat"
                  density="compact"
                  className="rounded-none"
                />
              ))}
            </div>
          </section>
        );
      })}
      {data.rows.some((row) => row.kind === null) ? (
        <section aria-label="Rejected calls">
          <SectionTitle>Unknown tools</SectionTitle>
          <div className="divide-y rounded-lg border">
            {data.rows
              .filter((row) => row.kind === null)
              .map((row) => (
                <ToolCallRow
                  key={row.toolCallId}
                  row={row}
                  variant="flat"
                  className="rounded-none"
                />
              ))}
          </div>
        </section>
      ) : null}
      {approvals.length > 0 ? (
        <section aria-label="Approvals">
          <SectionTitle aside={pluralize(approvals.length, "approval")}>Approvals</SectionTitle>
          <ul className="divide-y rounded-lg border">
            {approvals.map(({ row, approval }) => {
              const state: { tone: Tone; label: string } =
                approval.state === "requested"
                  ? { tone: "warning", label: "Waiting" }
                  : approval.state === "approved"
                    ? { tone: "success", label: "Approved" }
                    : approval.state === "blocked"
                      ? { tone: "neutral", label: "Blocked" }
                      : { tone: "danger", label: "Denied" };
              return (
                <li key={approval.id} className="flex items-start gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-body-sm">{approval.facts.consequence}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
                      {row.integrationLabel}
                      {row.kind ? <KindChip kind={row.kind} /> : null}
                    </p>
                  </div>
                  <StatusText status={state} className="text-meta text-muted-foreground" />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-body-sm text-muted-foreground">{label}</dt>
      <dd className="text-body-sm tabular-nums">{value === "" ? "–" : value}</dd>
    </div>
  );
}

function RunTab({ data }: { data: InspectorData }) {
  const run = data.latestRun;
  if (data.latestRunId === null) {
    return (
      <p className="px-1 py-6 text-center text-body-sm text-muted-foreground">
        Cost, tokens and turns appear after the first run.
      </p>
    );
  }
  if (!run) {
    return (
      <div className="space-y-3 px-1 pt-1">
        <Skeleton className="h-4 w-32" />
        {["a", "b", "c", "d", "e"].map((key) => (
          <Skeleton key={key} className="h-3.5 w-full" />
        ))}
      </div>
    );
  }
  const usage = run.usage;
  return (
    <div className="space-y-5">
      <section aria-label="Latest run">
        <div className="flex items-center justify-between px-1 pb-2">
          <StatusText status={RUN_STATUS_LABELS[run.status]} className="font-medium text-body-sm" />
          <Link
            href={runHref(run.id)}
            className="inline-flex items-center gap-1 text-meta no-underline hover:underline"
          >
            Open run
            <ArrowUpRightIcon className="size-3.5" />
          </Link>
        </div>
        <dl className="divide-y rounded-lg border px-3">
          <Fact label="Started" value={formatRelativeTime(run.startedAt)} />
          <Fact label="Model" value={`${run.model} / ${run.effort}`} />
          <Fact label="Duration" value={usage ? formatDuration(usage.durationMs) : ""} />
          <Fact label="Cost" value={usage ? formatCost(usage.costUsd) : ""} />
          <Fact label="Input tokens" value={usage ? formatCount(usage.inputTokens) : ""} />
          <Fact label="Output tokens" value={usage ? formatCount(usage.outputTokens) : ""} />
          <Fact label="Cache reads" value={usage ? formatCount(usage.cacheReadTokens) : ""} />
          <Fact label="Cache writes" value={usage ? formatCount(usage.cacheCreationTokens) : ""} />
          <Fact label="Turns" value={usage ? String(usage.numTurns) : ""} />
          <Fact label="Model requests" value={usage ? String(usage.modelRequests) : ""} />
        </dl>
        {run.error ? (
          <p className="px-1 pt-2 text-body-sm text-danger">{run.error.message}</p>
        ) : null}
      </section>
      <section aria-label="Connections for this run">
        <SectionTitle>Connections for this run</SectionTitle>
        <ul className="divide-y rounded-lg border">
          {run.connections.map((connection) => (
            <li key={connection.integration} className="flex items-start gap-2 px-3 py-2">
              <StatusDot
                tone={connection.availability === "ready" ? "success" : "warning"}
                className="mt-[5px]"
              />
              <div className="min-w-0 flex-1">
                <p className="text-body-sm">{INTEGRATIONS[connection.integration].label}</p>
                {connection.detail ? (
                  <p className="text-meta text-muted-foreground">{connection.detail}</p>
                ) : null}
              </div>
              <KindChip kind={connection.kind} className="mt-px" />
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Conversation total">
        <dl className="rounded-lg border px-3">
          <Fact
            label={`Conversation, ${pluralize(data.usage.runs, "run")}`}
            value={formatCost(data.usage.costUsd)}
          />
        </dl>
      </section>
    </div>
  );
}

export function InspectorPanel({
  data,
  tab,
  onTabChange,
}: {
  data: InspectorData;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
}) {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value === "run" ? "run" : "activity")}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <div className="flex h-11 shrink-0 items-end border-b px-4">
        <TabsList variant="line" className="h-full gap-4 p-0">
          <TabsTrigger value="activity" className="h-full flex-none px-0 text-body-sm">
            Activity
          </TabsTrigger>
          <TabsTrigger value="run" className="h-full flex-none px-0 text-body-sm">
            Run
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <TabsContent value="activity">
          <ActivityTab data={data} />
        </TabsContent>
        <TabsContent value="run">
          <RunTab data={data} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
