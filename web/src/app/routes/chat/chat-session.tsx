import { useChat } from "@ai-sdk/react";
import { CircleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShell } from "@/app/shell-context";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ApprovalCard, type ApprovalSubmission } from "@/components/app/approval-card";
import { useNotify } from "@/components/app/notices";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { PHONE_QUERY, useMediaQuery, WIDE_QUERY } from "@/hooks/use-media-query";
import { useNow } from "@/hooks/use-now";
import { invalidate } from "@/hooks/use-resource";
import { api, errorMessage, parseTransportError } from "@/lib/api";
import { chatErrorMessage, createChatTransport, decideApproval, stopRun } from "@/lib/chat";
import type {
  ApprovalView,
  ChatUIMessage,
  ConversationDetail,
  RunDetailView,
  StatusData,
  ToolCallView,
} from "@/lib/contracts";
import { focusPanelOnOpen } from "@/lib/focus";
import {
  conversationUsage,
  describeActivity,
  inFlightAssistantMessage,
  isRunSettled,
  orphanApprovals,
  prepareInitialMessages,
  streamingRunId,
  toolParts,
} from "@/lib/messages";
import { approvalFactsFromView, mergeToolRow, toolRowFromPart } from "@/lib/tool-model";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { ChatEmptyState } from "./empty-state";
import { type InspectorData, InspectorPanel } from "./inspector";
import { CHAT_COLUMN, COMPOSER_DOCK } from "./layout";
import { consumePendingPrompt, peekPendingPrompt } from "./pending-prompts";
import { ActivityLine, type ThreadContext, ThreadMessages } from "./thread";
import { useToolTimings } from "./use-tool-timings";

/** The status line waits this long for new tokens before it appears. */
const ACTIVITY_DELAY_MS = 300;
/** Run details kept for the thread and inspector (newest runs). */
const MAX_RUN_DETAILS = 20;
/** If no abort chunk arrives, Stop becomes available again. */
const STOP_GRACE_MS = 10_000;

/** The server marks the conversation running once the chat request lands; refresh the rail then. */
function markRunStarting(): void {
  setTimeout(() => invalidate("conversations"), 400);
}

function useRunDetails(messages: readonly ChatUIMessage[]) {
  const [runs, setRuns] = useState<ReadonlyMap<string, RunDetailView>>(new Map());
  const requested = useRef(new Set<string>());
  const runIds = useMemo(() => {
    const ids: string[] = [];
    for (const message of messages) {
      const runId = message.role === "assistant" ? message.metadata?.runId : undefined;
      if (runId && !ids.includes(runId)) ids.push(runId);
    }
    return ids.slice(-MAX_RUN_DETAILS);
  }, [messages]);

  const fetchRun = useCallback(async (runId: string) => {
    requested.current.add(runId);
    try {
      const run = await api.request("GET /api/runs/:runId", { params: { runId } });
      setRuns((current) => new Map(current).set(runId, run));
    } catch {
      // Details are an enrichment (durations, errors); the thread renders without them.
    }
  }, []);

  useEffect(() => {
    for (const runId of runIds) {
      if (!requested.current.has(runId)) void fetchRun(runId);
    }
  }, [runIds, fetchRun]);

  return { runs, runIds, refetch: fetchRun };
}

export function ChatSession({ detail }: { detail: ConversationDetail }) {
  const conversationId = detail.conversation.id;
  const notify = useNotify();
  const shell = useShell();
  const wide = useMediaQuery(WIDE_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);

  const [initialPrompt] = useState(() => peekPendingPrompt(conversationId));
  const [initialMessages] = useState(() => prepareInitialMessages(detail));
  const [transport] = useState(() => createChatTransport<ChatUIMessage>());
  const [modelStatus, setModelStatus] = useState<StatusData | null>(null);
  const progressRef = useRef<(toolCallId: string, elapsedMs: number) => void>(() => {});
  const finishedRef = useRef<(message: ChatUIMessage) => void>(() => {});

  const { messages, status, error, sendMessage, regenerate, resumeStream, clearError } =
    useChat<ChatUIMessage>({
      id: conversationId,
      messages: initialMessages,
      transport,
      // A brand-new conversation has no run to resume, and a resume that ends
      // empty would reset the status while the first message is streaming.
      resume: initialPrompt === null,
      throttle: 50,
      onData: (part) => {
        if (part.type === "data-status") setModelStatus(part.data);
        else if (part.type === "data-progress") {
          progressRef.current(part.data.toolCallId, part.data.elapsedMs);
        }
      },
      onFinish: ({ message }) => {
        setModelStatus(null);
        finishedRef.current(message);
      },
      onError: () => {
        setModelStatus(null);
        invalidate("conversations");
      },
    });

  const { timings, reportProgress } = useToolTimings(messages);
  const { runs, runIds, refetch } = useRunDetails(messages);
  useLayoutEffect(() => {
    progressRef.current = reportProgress;
    finishedRef.current = (message) => {
      invalidate("conversations", "runs");
      const runId = message.metadata?.runId;
      if (runId) void refetch(runId);
    };
  });

  // The first prompt of a new conversation (left by the new-chat screen).
  // Sent on the next tick: useChat stops its chat in an effect cleanup, so
  // React's development double mount would abort a request started here and
  // the remount would find the prompt already taken. The timer is cleared
  // instead, and the prompt is taken only when the request really starts.
  useEffect(() => {
    if (initialPrompt === null) return;
    const timer = setTimeout(() => {
      if (consumePendingPrompt(conversationId) !== initialPrompt) return;
      void sendMessage({ text: initialPrompt });
      markRunStarting();
    }, 0);
    return () => clearTimeout(timer);
  }, [conversationId, initialPrompt, sendMessage]);

  const running = status === "submitted" || status === "streaming";
  const now = useNow(1_000, running);

  // --- Stop -----------------------------------------------------------------
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), STOP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [stopping]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      let runId = streamingRunId(messages, status);
      if (runId === null) {
        const latest = await api.request("GET /api/conversations/:conversationId", {
          params: { conversationId },
        });
        runId = latest.conversation.activeRunId;
      }
      if (runId === null || (await stopRun(runId)) === "not_running") setStopping(false);
    } catch (stopError) {
      setStopping(false);
      notify({ tone: "danger", message: errorMessage(stopError, "The run could not be stopped.") });
    }
  }, [messages, status, conversationId, notify]);

  // --- Approvals --------------------------------------------------------------
  const [submissions, setSubmissions] = useState<Readonly<Record<string, ApprovalSubmission>>>({});
  const [decidedOrphans, setDecidedOrphans] = useState<ReadonlySet<string>>(new Set());
  const decide = useCallback(async (approvalId: string, approved: boolean, reason?: string) => {
    setSubmissions((current) => ({ ...current, [approvalId]: { approved, status: "sending" } }));
    try {
      await decideApproval(approvalId, { approved, ...(reason ? { reason } : {}) });
      invalidate("conversations");
    } catch (decisionError) {
      const message =
        decisionError instanceof Error ? decisionError.message : "The decision could not be sent.";
      setSubmissions((current) => ({
        ...current,
        [approvalId]: { approved, status: "failed", error: message },
      }));
    }
  }, []);
  const decideOrphan = useCallback(
    async (approvalId: string, approved: boolean, reason?: string) => {
      await decide(approvalId, approved, reason);
      setDecidedOrphans((current) => new Set(current).add(approvalId));
    },
    [decide],
  );
  const orphans: ApprovalView[] = useMemo(
    () =>
      orphanApprovals(detail.pendingApprovals, messages).filter(
        (approval) => !decidedOrphans.has(approval.id),
      ),
    [detail.pendingApprovals, messages, decidedOrphans],
  );

  // --- Status line (after a pause with no new tokens) ---------------------------
  const [quiet, setQuiet] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every message update restarts the pause.
  useEffect(() => {
    setQuiet(false);
    if (!running) return;
    const timer = setTimeout(() => setQuiet(true), ACTIVITY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [messages, running]);
  const activity = describeActivity(status, messages, modelStatus);
  const showActivity =
    activity !== null && (quiet || activity.kind === "retrying" || activity.kind === "compacting");

  // --- Derived views --------------------------------------------------------------
  const logRows = useMemo(() => {
    const map = new Map<string, ToolCallView>();
    for (const run of runs.values())
      for (const call of run.toolCalls) map.set(call.toolCallId, call);
    return map;
  }, [runs]);

  const streamingMessageId = inFlightAssistantMessage(messages, status)?.id ?? null;

  const context = useMemo<ThreadContext>(
    () => ({ now, timings, logRows, runs, submissions, onDecide: decide }),
    [now, timings, logRows, runs, submissions, decide],
  );

  const usage = useMemo(() => conversationUsage(messages), [messages]);
  const latestRunId = runIds.at(-1) ?? null;
  const inspectorData = useMemo<InspectorData>(() => {
    const settledById = new Map<string, boolean>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const settled = isRunSettled(message, message.id === streamingMessageId);
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") settledById.set(part.toolCallId, settled);
      }
    }
    return {
      rows: toolParts(messages).map((part) =>
        mergeToolRow(
          toolRowFromPart(part, settledById.get(part.toolCallId) ?? true),
          logRows.get(part.toolCallId),
        ),
      ),
      usage,
      latestRunId,
      latestRun: latestRunId ? runs.get(latestRunId) : undefined,
      timings,
      now,
    };
  }, [messages, streamingMessageId, logRows, usage, latestRunId, runs, timings, now]);

  const chatError = error ? parseTransportError(error) : null;
  const lastIsUser = messages.at(-1)?.role === "user";
  const retry = () => {
    clearError();
    if (lastIsUser) void regenerate();
    else void resumeStream();
  };

  const send = (text: string) => {
    clearError();
    void sendMessage({ text });
    markRunStarting();
  };

  const inspector = (
    <InspectorPanel
      data={inspectorData}
      tab={shell.inspectorTab}
      onTabChange={shell.setInspectorTab}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className={cn(CHAT_COLUMN, "gap-6 pt-6 pb-10")}>
            {messages.length === 0 && !running ? (
              <ChatEmptyState onPick={send} />
            ) : (
              <ThreadMessages
                messages={messages}
                streamingMessageId={streamingMessageId}
                context={context}
              />
            )}
            {orphans.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={{
                  id: approval.id,
                  state: "requested",
                  facts: approvalFactsFromView(approval),
                  reason: null,
                }}
                submission={submissions[approval.id]}
                onDecide={(approved, reason) => void decideOrphan(approval.id, approved, reason)}
              />
            ))}
            {showActivity && activity ? <ActivityLine activity={activity} /> : null}
            {error ? (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-danger/25 bg-danger/5 py-2 pr-2 pl-3 text-body-sm"
              >
                <p className="flex min-w-0 items-start gap-2 text-danger">
                  <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {chatErrorMessage(chatError)}
                </p>
                <Button variant="outline" size="sm" onClick={retry}>
                  {lastIsUser ? "Try again" : "Reconnect"}
                </Button>
              </div>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton className="bottom-3 size-8 border-border bg-background shadow-popover" />
        </Conversation>
        <div className={COMPOSER_DOCK}>
          <div className={CHAT_COLUMN}>
            <Composer
              status={status}
              running={running}
              stopping={stopping}
              onSend={send}
              onStop={() => void stop()}
              usage={usage}
            />
          </div>
        </div>
      </div>

      {wide ? (
        shell.inspectorOpen ? (
          <aside
            aria-label="Inspector"
            className="flex w-[380px] shrink-0 flex-col border-l bg-background"
          >
            {inspector}
          </aside>
        ) : null
      ) : (
        <Sheet open={shell.inspectorOpen} onOpenChange={shell.setInspectorOpen}>
          <SheetContent
            side={phone ? "bottom" : "right"}
            onOpenAutoFocus={focusPanelOnOpen}
            // Centred on the 44px tab row.
            closeClassName="top-1.5 right-2 pointer-coarse:top-0 pointer-coarse:right-1"
            className={
              phone
                ? "gap-0 rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)] outline-none data-[side=bottom]:h-[85dvh]"
                : "gap-0 p-0 outline-none data-[side=right]:w-[380px] data-[side=right]:max-w-full data-[side=right]:sm:max-w-[380px]"
            }
          >
            <SheetTitle className="sr-only">Inspector</SheetTitle>
            <SheetDescription className="sr-only">
              Tool calls, approvals, cost and tokens
            </SheetDescription>
            {inspector}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
