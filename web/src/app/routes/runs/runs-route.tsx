import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { navigate } from "@/app/router";
import { ErrorState, Page, PageHeader, Panel } from "@/components/app/page";
import { MetaChip, StatusText } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useResource } from "@/hooks/use-resource";
import { api, errorMessage } from "@/lib/api";
import { RUN_STATUSES, type RunSource, type RunStatus, type RunSummaryView } from "@/lib/contracts";
import { formatCost, formatDateTime, formatDuration, formatRelativeTime } from "@/lib/format";
import { KIND_LABELS, KIND_ORDER, RUN_STATUS_LABELS } from "@/lib/labels";
import { runHref } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { RunDetailSheet } from "./run-detail";

const PAGE_SIZE = 50;
const ALL = "all";

type Filters = { status: RunStatus | typeof ALL; source: RunSource | typeof ALL };

function runDuration(run: RunSummaryView): string {
  if (run.usage) return formatDuration(run.usage.durationMs);
  if (run.finishedAt) {
    return formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime());
  }
  return "";
}

function ToolCounts({ run }: { run: RunSummaryView }) {
  const total = KIND_ORDER.reduce((sum, kind) => sum + run.toolCallsByKind[kind], 0);
  if (total === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="inline-flex items-center gap-2.5 tabular-nums">
      {KIND_ORDER.map((kind) =>
        run.toolCallsByKind[kind] > 0 ? (
          <span key={kind} className="inline-flex items-baseline gap-1">
            <span className="text-foreground">{run.toolCallsByKind[kind]}</span>
            <span className="text-meta text-muted-foreground">{KIND_LABELS[kind]}</span>
          </span>
        ) : null,
      )}
    </span>
  );
}

function Approvals({ run }: { run: RunSummaryView }) {
  const { pending, approved, denied } = run.approvals;
  if (pending + approved + denied === 0) return <span className="text-muted-foreground">–</span>;
  const parts = [
    pending > 0 ? `${pending} waiting` : null,
    approved > 0 ? `${approved} approved` : null,
    denied > 0 ? `${denied} denied` : null,
  ].filter((part) => part !== null);
  return <span className={cn(pending > 0 && "text-warning")}>{parts.join(", ")}</span>;
}

function StartedCell({ iso }: { iso: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{formatRelativeTime(iso)}</span>
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}

function RunsTable({
  runs,
  selectedId,
}: {
  runs: readonly RunSummaryView[];
  selectedId: string | null;
}) {
  return (
    <Table className="text-body-sm">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-9 pl-4 font-medium text-meta text-muted-foreground">
            Started
          </TableHead>
          <TableHead className="h-9 font-medium text-meta text-muted-foreground">Status</TableHead>
          <TableHead className="h-9 font-medium text-meta text-muted-foreground">Source</TableHead>
          <TableHead className="h-9 font-medium text-meta text-muted-foreground">Model</TableHead>
          <TableHead className="h-9 text-right font-medium text-meta text-muted-foreground">
            Duration
          </TableHead>
          <TableHead className="h-9 text-right font-medium text-meta text-muted-foreground">
            Cost
          </TableHead>
          <TableHead className="h-9 font-medium text-meta text-muted-foreground">
            Tool calls
          </TableHead>
          <TableHead className="h-9 pr-4 font-medium text-meta text-muted-foreground">
            Approvals
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow
            key={run.id}
            data-state={run.id === selectedId ? "selected" : undefined}
            className="cursor-pointer data-[state=selected]:bg-brand-subtle"
            onClick={() => navigate(runHref(run.id))}
          >
            <TableCell className="h-11 pl-4">
              <a
                href={runHref(run.id)}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(runHref(run.id));
                }}
                className="text-foreground no-underline hover:underline"
              >
                <StartedCell iso={run.startedAt} />
              </a>
            </TableCell>
            <TableCell>
              <StatusText status={RUN_STATUS_LABELS[run.status]} />
            </TableCell>
            <TableCell>
              {run.source === "cli" ? <MetaChip>CLI</MetaChip> : <MetaChip>App</MetaChip>}
            </TableCell>
            <TableCell className="font-mono text-meta text-muted-foreground">
              {run.model}
              <span className="text-border-strong"> / </span>
              {run.effort}
            </TableCell>
            <TableCell className="text-right tabular-nums">{runDuration(run) || "–"}</TableCell>
            <TableCell className="text-right tabular-nums">
              {run.usage ? formatCost(run.usage.costUsd) : "–"}
            </TableCell>
            <TableCell>
              <ToolCounts run={run} />
            </TableCell>
            <TableCell className="pr-4">
              <Approvals run={run} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunsList({ runs }: { runs: readonly RunSummaryView[] }) {
  return (
    <ul className="divide-y">
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => navigate(runHref(run.id))}
            className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-surface-subtle"
          >
            <span className="flex items-center justify-between gap-3">
              <StatusText status={RUN_STATUS_LABELS[run.status]} className="text-body-sm" />
              <span className="text-meta text-muted-foreground">
                {formatRelativeTime(run.startedAt)}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground tabular-nums">
              {run.source === "cli" ? <MetaChip>CLI</MetaChip> : null}
              <span>{runDuration(run) || "–"}</span>
              <span>{run.usage ? formatCost(run.usage.costUsd) : "–"}</span>
              <ToolCounts run={run} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TableSkeleton() {
  return (
    <div className="divide-y" aria-hidden="true">
      {["a", "b", "c", "d", "e", "f"].map((key) => (
        <div key={key} className="flex items-center gap-6 px-4 py-3.5">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="hidden h-3.5 w-10 md:block" />
          <Skeleton className="hidden h-3.5 w-36 md:block" />
          <Skeleton className="ml-auto h-3.5 w-14" />
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}

export default function RunsRoute({ runId }: { runId: string | null }) {
  const [filters, setFilters] = useState<Filters>({ status: ALL, source: ALL });
  // Pages grow the limit of one request, so polling refreshes everything shown
  // and "Show more" keeps the rows on screen while it loads.
  const [pages, setPages] = useState(1);
  const pagesRef = useRef(pages);
  useLayoutEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  const key = `runs:${filters.status}:${filters.source}`;
  const { data, error, loading, reload } = useResource(
    key,
    (signal) =>
      api.request("GET /api/runs", {
        query: {
          limit: PAGE_SIZE * pagesRef.current,
          ...(filters.status === ALL ? {} : { status: filters.status }),
          ...(filters.source === ALL ? {} : { source: filters.source }),
        },
        signal,
      }),
    {
      topics: ["runs"],
      pollMs: (page) => (page?.items.some((run) => run.status === "running") ? 3_000 : 30_000),
    },
  );
  useEffect(() => {
    if (pages > 1) reload();
  }, [pages, reload]);
  const runs = data?.items ?? [];
  const filtered = filters.status !== ALL || filters.source !== ALL;

  return (
    <Page>
      <PageHeader
        title="Runs"
        description="Every agent run from the app and the CLI, with its tool calls and approvals."
        actions={
          <>
            <Select
              value={filters.status}
              onValueChange={(value) => {
                setPages(1);
                setFilters((current) => ({ ...current, status: value as Filters["status"] }));
              }}
            >
              <SelectTrigger
                aria-label="Filter by status"
                className="h-8 min-w-[8.5rem] text-body-sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {RUN_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {RUN_STATUS_LABELS[status].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.source}
              onValueChange={(value) => {
                setPages(1);
                setFilters((current) => ({ ...current, source: value as Filters["source"] }));
              }}
            >
              <SelectTrigger
                aria-label="Filter by source"
                className="h-8 min-w-[7.5rem] text-body-sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All sources</SelectItem>
                <SelectItem value="ui">App</SelectItem>
                <SelectItem value="cli">CLI</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      />

      <Panel className="overflow-hidden">
        {loading ? <TableSkeleton /> : null}
        {error ? (
          <ErrorState message={errorMessage(error, "Runs did not load.")} onRetry={reload} />
        ) : null}
        {data && runs.length === 0 ? (
          <p className="px-4 py-12 text-center text-body text-muted-foreground">
            {filtered
              ? "No runs match these filters."
              : "No runs yet. Runs appear here once you ask Revenue Desk something."}
          </p>
        ) : null}
        {runs.length > 0 ? (
          <>
            <div className="hidden md:block">
              <RunsTable runs={runs} selectedId={runId} />
            </div>
            <div className="md:hidden">
              <RunsList runs={runs} />
            </div>
          </>
        ) : null}
      </Panel>
      {data?.nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setPages((value) => value + 1)}>
            Show more
          </Button>
        </div>
      ) : null}

      <RunDetailSheet runId={runId} onClose={() => navigate(runHref(null))} />
    </Page>
  );
}
