import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { navigate } from "@/app/router";
import { useSession } from "@/app/session";
import { useNotify } from "@/components/app/notices";
import { ErrorState, Page, PageHeader, Panel } from "@/components/app/page";
import { KindChip, MetaChip, StatusText } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnections } from "@/hooks/use-api";
import { invalidate } from "@/hooks/use-resource";
import { api, errorMessage } from "@/lib/api";
import type { ConnectionView, IntegrationId } from "@/lib/contracts";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { CONNECTION_STATE_LABELS } from "@/lib/labels";
import { safeRedirectUrl, signInReturn } from "@/lib/urls";

type RowActions = {
  checking: ReadonlySet<IntegrationId>;
  connecting: IntegrationId | null;
  onCheck: (integration: IntegrationId) => void;
  onConnect: (integration: IntegrationId) => void;
};

function Missing({ connection }: { connection: ConnectionView }) {
  if (connection.missing.length === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {connection.missing.map((name) => (
        <code
          key={name}
          className="rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        >
          {name}
        </code>
      ))}
    </span>
  );
}

function StatusCell({ connection }: { connection: ConnectionView }) {
  const status = CONNECTION_STATE_LABELS[connection.state];
  return (
    <div className="min-w-0 space-y-0.5">
      <StatusText status={status} />
      {connection.detail && connection.state !== "connected" ? (
        <p className="max-w-[18rem] whitespace-normal text-meta text-muted-foreground">
          {connection.detail}
        </p>
      ) : null}
    </div>
  );
}

function Actions({ connection, actions }: { connection: ConnectionView; actions: RowActions }) {
  const checking = actions.checking.has(connection.integration);
  const configured = connection.state !== "not_configured" && connection.state !== "invalid";
  return (
    <div className="flex items-center justify-end gap-1.5">
      {connection.canConnect ? (
        <Button
          size="sm"
          onClick={() => actions.onConnect(connection.integration)}
          disabled={actions.connecting !== null}
        >
          {actions.connecting === connection.integration ? (
            <Spinner aria-hidden="true" className="size-3.5" />
          ) : (
            <ExternalLinkIcon />
          )}
          Connect
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={checking || !configured}
        onClick={() => actions.onCheck(connection.integration)}
        aria-label={`Check ${connection.label}`}
      >
        {checking ? <Spinner aria-hidden="true" className="size-3.5" /> : <RefreshCwIcon />}
        Check
      </Button>
    </div>
  );
}

function LastChecked({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">Never</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{formatRelativeTime(iso)}</span>
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}

function ConnectionsTable({
  connections,
  actions,
}: {
  connections: readonly ConnectionView[];
  actions: RowActions;
}) {
  const head = "h-9 font-medium text-meta text-muted-foreground";
  return (
    <Table className="text-body-sm">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={`${head} pl-4`}>Integration</TableHead>
          <TableHead className={head}>Status</TableHead>
          <TableHead className={head}>Endpoint</TableHead>
          <TableHead className={head}>Last checked</TableHead>
          <TableHead className={head}>Missing</TableHead>
          <TableHead className={`${head} pr-4 text-right`}>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {connections.map((connection) => (
          <TableRow key={connection.integration} className="align-top hover:bg-transparent">
            <TableCell className="py-3 pl-4 align-top">
              <div className="flex items-center gap-2">
                <span className="font-medium">{connection.label}</span>
                <KindChip kind={connection.kind} />
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {connection.profile}
              </p>
            </TableCell>
            <TableCell className="py-3 align-top">
              <StatusCell connection={connection} />
            </TableCell>
            <TableCell className="py-3 align-top font-mono text-meta text-muted-foreground">
              {connection.endpointLabel ?? "–"}
              {connection.accountHint ? (
                <p className="mt-0.5 text-[11px]">{connection.accountHint}</p>
              ) : null}
            </TableCell>
            <TableCell className="py-3 align-top tabular-nums">
              <LastChecked iso={connection.checkedAt} />
            </TableCell>
            <TableCell className="py-3 align-top">
              <Missing connection={connection} />
            </TableCell>
            <TableCell className="py-2.5 pr-4 align-top">
              <Actions connection={connection} actions={actions} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ConnectionsList({
  connections,
  actions,
}: {
  connections: readonly ConnectionView[];
  actions: RowActions;
}) {
  return (
    <ul className="divide-y">
      {connections.map((connection) => (
        <li key={connection.integration} className="space-y-2.5 px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="font-medium text-body">{connection.label}</span>
              <KindChip kind={connection.kind} />
            </span>
            <StatusText
              status={CONNECTION_STATE_LABELS[connection.state]}
              className="text-body-sm"
            />
          </div>
          {connection.detail && connection.state !== "connected" ? (
            <p className="text-body-sm text-muted-foreground">{connection.detail}</p>
          ) : null}
          {/* The actions sit beside the facts when they fit, so each item is a line shorter. */}
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2.5">
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
              <dt className="text-muted-foreground">Endpoint</dt>
              <dd className="min-w-0 break-all font-mono">{connection.endpointLabel ?? "–"}</dd>
              <dt className="text-muted-foreground">Checked</dt>
              <dd>
                <LastChecked iso={connection.checkedAt} />
              </dd>
              {connection.missing.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">Missing</dt>
                  <dd>
                    <Missing connection={connection} />
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="ml-auto">
              <Actions connection={connection} actions={actions} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y" aria-hidden="true">
      {["a", "b", "c", "d", "e", "f"].map((key) => (
        <div key={key} className="flex items-center gap-6 px-4 py-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="hidden h-4 w-40 md:block" />
          <Skeleton className="ml-auto h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

export default function ConnectionsRoute() {
  const session = useSession();
  const notify = useNotify();
  const { data, error, loading, reload, mutate } = useConnections();
  const [checking, setChecking] = useState<ReadonlySet<IntegrationId>>(new Set());
  const [connecting, setConnecting] = useState<IntegrationId | null>(null);

  const replace = (connection: ConnectionView) =>
    mutate((current) =>
      (current ?? []).map((item) =>
        item.integration === connection.integration ? connection : item,
      ),
    );

  /** A read-only check; `announce` says the outcome (after a sign-in). */
  const check = async (integration: IntegrationId, announce = false) => {
    setChecking((current) => new Set(current).add(integration));
    try {
      const { connection } = await api.request("POST /api/connections/:integration/check", {
        params: { integration },
      });
      replace(connection);
      // The app bar's summary and any other view of the connections follow.
      invalidate("connections");
      if (announce) {
        notify(
          connection.state === "connected"
            ? { tone: "success", message: `${connection.label} is connected.` }
            : {
                tone: "warning",
                message: `${connection.label} is not connected: ${CONNECTION_STATE_LABELS[connection.state].label.toLowerCase()}.`,
              },
        );
      }
    } catch (checkError) {
      notify({ tone: "danger", message: errorMessage(checkError, "The check did not finish.") });
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(integration);
        return next;
      });
    }
  };

  const checkAll = () => {
    for (const connection of data ?? []) {
      if (connection.state !== "not_configured" && connection.state !== "invalid") {
        void check(connection.integration);
      }
    }
  };

  // Back from Composio's sign-in: the server's callback opens this page as
  // /connections?connected=<integration> in the sign-in tab. Check that
  // integration once so the page says whether sign-in worked.
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    const integration = signInReturn(window.location.search);
    if (integration === null) return;
    navigate("/connections", { replace: true });
    void checkRef.current(integration, true);
  }, []);

  // The tab that started a sign-in checks again when the person comes back to it.
  const [awaitingSignIn, setAwaitingSignIn] = useState<IntegrationId | null>(null);
  useEffect(() => {
    if (awaitingSignIn === null) return;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      setAwaitingSignIn(null);
      void checkRef.current(awaitingSignIn, true);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [awaitingSignIn]);

  const connect = async (integration: IntegrationId) => {
    // Opened synchronously in the click, so the browser does not block it,
    // then pointed at Composio's sign-in once the server returns the link.
    const tab = window.open("about:blank", "_blank");
    setConnecting(integration);
    try {
      const { redirectUrl } = await api.request("POST /api/connections/:integration/connect", {
        params: { integration },
      });
      const url = safeRedirectUrl(redirectUrl);
      if (url === null) throw new Error("unsafe redirect");
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      setAwaitingSignIn(integration);
      notify({ message: "Finish signing in in the new tab, then come back here." });
    } catch (connectError) {
      tab?.close();
      notify({
        tone: "danger",
        message: errorMessage(connectError, "The sign-in link could not be created."),
      });
    } finally {
      setConnecting(null);
      invalidate("connections");
    }
  };

  const actions: RowActions = {
    checking,
    connecting,
    onCheck: (id) => void check(id),
    onConnect: (id) => void connect(id),
  };
  const connections = data ?? [];

  return (
    <Page>
      <PageHeader
        title="Connections"
        description="How Revenue Desk reaches each system. Checks are read-only; configuration comes from the server's environment."
        actions={
          <>
            {session?.mode === "sandbox" ? <MetaChip>Local sandbox</MetaChip> : null}
            <Button
              variant="outline"
              size="sm"
              onClick={checkAll}
              disabled={!data || checking.size > 0}
            >
              {checking.size > 0 ? (
                <Spinner aria-hidden="true" className="size-3.5" />
              ) : (
                <RefreshCwIcon />
              )}
              Check all
            </Button>
          </>
        }
      />
      <Panel className="overflow-hidden">
        {loading ? <ListSkeleton /> : null}
        {error ? (
          <ErrorState message={errorMessage(error, "Connections did not load.")} onRetry={reload} />
        ) : null}
        {connections.length > 0 ? (
          <>
            <div className="hidden lg:block">
              <ConnectionsTable connections={connections} actions={actions} />
            </div>
            <div className="lg:hidden">
              <ConnectionsList connections={connections} actions={actions} />
            </div>
          </>
        ) : null}
      </Panel>
    </Page>
  );
}
