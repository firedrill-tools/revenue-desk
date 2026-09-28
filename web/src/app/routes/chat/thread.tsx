import { CheckIcon, CopyIcon, ReceiptTextIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/app/router";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ApprovalCard, type ApprovalSubmission } from "@/components/app/approval-card";
import { StatusDot } from "@/components/app/status";
import {
  ReadsGroup,
  ToolCallBlock,
  ToolCallRow,
  type ToolTiming,
} from "@/components/app/tool-call";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatUIMessage, NoticeData, RunDetailView, ToolCallView } from "@/lib/contracts";
import { formatCost, formatDuration } from "@/lib/format";
import { RUN_STATUS_LABELS } from "@/lib/labels";
import {
  type Activity,
  activityLabel,
  isRunSettled,
  messageText,
  messageUsage,
} from "@/lib/messages";
import { runHref } from "@/lib/routes";
import { layoutAssistantParts, mergeToolRow, toolRowFromPart } from "@/lib/tool-model";

export type DecideApproval = (approvalId: string, approved: boolean, reason?: string) => void;

export type ThreadContext = {
  readonly now: number;
  readonly timings: ReadonlyMap<string, ToolTiming>;
  /** Action-log rows by tool_use id, from the run details. */
  readonly logRows: ReadonlyMap<string, ToolCallView>;
  readonly runs: ReadonlyMap<string, RunDetailView>;
  readonly submissions: Readonly<Record<string, ApprovalSubmission>>;
  readonly onDecide: DecideApproval;
};

function NoticeLine({ notice }: { notice: NoticeData }) {
  return (
    <p className="flex items-start gap-2 text-body-sm text-muted-foreground">
      <StatusDot tone={notice.level === "warning" ? "warning" : "neutral"} className="mt-[5px]" />
      {notice.message}
    </p>
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <MessageAction
      tooltip={copied ? "Copied" : "Copy"}
      className="size-7 text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
}

function AssistantFooter({
  message,
  run,
}: {
  message: ChatUIMessage;
  run: RunDetailView | undefined;
}) {
  const text = messageText(message);
  const usage = messageUsage(message) ?? run?.usage ?? null;
  const status = message.metadata?.status ?? run?.status;
  const runId = message.metadata?.runId;
  const facts = [
    usage ? formatDuration(usage.durationMs) : "",
    usage ? formatCost(usage.costUsd) : "",
  ].filter((fact) => fact !== "");

  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
      {status && status !== "completed" && status !== "running" ? (
        <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground">
          <StatusDot tone={RUN_STATUS_LABELS[status].tone} />
          {RUN_STATUS_LABELS[status].label}
          {status === "failed" && run?.error ? (
            <span className="text-danger">{run.error.message}</span>
          ) : null}
        </span>
      ) : null}
      <MessageActions className="-ml-1.5 gap-0.5">
        {text !== "" ? <CopyAction text={text} /> : null}
        {runId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href={runHref(runId)}
                aria-label="Open run"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ReceiptTextIcon className="size-3.5" />
              </Link>
            </TooltipTrigger>
            <TooltipContent>Open run</TooltipContent>
          </Tooltip>
        ) : null}
      </MessageActions>
      {facts.length > 0 ? (
        <span className="text-meta text-muted-foreground tabular-nums">{facts.join(" · ")}</span>
      ) : null}
    </div>
  );
}

function AssistantMessage({
  message,
  streaming,
  context,
}: {
  message: ChatUIMessage;
  streaming: boolean;
  context: ThreadContext;
}) {
  const blocks = useMemo(
    () => layoutAssistantParts(message.id, message.parts),
    [message.id, message.parts],
  );
  const settled = isRunSettled(message, streaming);
  const run = message.metadata?.runId ? context.runs.get(message.metadata.runId) : undefined;
  // Nothing to show yet: the status line below the thread says what is happening.
  if (blocks.length === 0 && !settled) return null;

  return (
    <Message from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-3 overflow-visible">
        {blocks.map((block) => {
          if (block.kind === "reads") {
            const rows = block.parts.map((part) =>
              mergeToolRow(toolRowFromPart(part, settled), context.logRows.get(part.toolCallId)),
            );
            return (
              <ReadsGroup key={block.key} rows={rows} timings={context.timings} now={context.now} />
            );
          }
          if (block.kind === "tool") {
            const row = mergeToolRow(
              toolRowFromPart(block.part, settled),
              context.logRows.get(block.part.toolCallId),
            );
            const approval = row.approval;
            return (
              <ToolCallBlock
                key={block.key}
                approval={
                  approval ? (
                    <ApprovalCard
                      approval={approval}
                      submission={context.submissions[approval.id]}
                      onDecide={
                        approval.state === "requested" && !settled
                          ? (approved, reason) => context.onDecide(approval.id, approved, reason)
                          : undefined
                      }
                    />
                  ) : null
                }
              >
                <ToolCallRow
                  row={row}
                  timing={context.timings.get(row.toolCallId)}
                  now={context.now}
                />
              </ToolCallBlock>
            );
          }
          const { part } = block;
          switch (part.type) {
            case "text":
              return (
                <MessageResponse
                  key={block.key}
                  className="rd-prose text-body leading-6"
                  isAnimating={streaming && part.state === "streaming"}
                >
                  {part.text}
                </MessageResponse>
              );
            case "reasoning":
              return (
                <Reasoning key={block.key} isStreaming={streaming && part.state === "streaming"}>
                  <ReasoningTrigger />
                  <ReasoningContent>{part.text}</ReasoningContent>
                </Reasoning>
              );
            case "data-notice":
              return <NoticeLine key={block.key} notice={part.data} />;
            default:
              return null;
          }
        })}
      </MessageContent>
      {settled ? <AssistantFooter message={message} run={run} /> : null}
    </Message>
  );
}

const MemoAssistantMessage = memo(AssistantMessage);

function UserMessage({ message }: { message: ChatUIMessage }) {
  return (
    <Message from="user" className="max-w-[88%]">
      <MessageContent className="rounded-[10px] px-3.5 py-2.5 text-body">
        <p className="whitespace-pre-wrap break-words">{messageText(message)}</p>
      </MessageContent>
    </Message>
  );
}

export function ActivityLine({ activity }: { activity: Activity }) {
  return (
    <div className="flex h-6 items-center" role="status">
      <Shimmer as="span" className="text-body-sm" duration={1.8}>
        {activityLabel(activity)}
      </Shimmer>
    </div>
  );
}

export function ThreadMessages({
  messages,
  streamingMessageId,
  context,
}: {
  messages: readonly ChatUIMessage[];
  streamingMessageId: string | null;
  context: ThreadContext;
}) {
  return messages.map((message) =>
    message.role === "user" ? (
      <UserMessage key={message.id} message={message} />
    ) : message.role === "assistant" ? (
      <MemoAssistantMessage
        key={message.id}
        message={message}
        streaming={message.id === streamingMessageId}
        context={context}
      />
    ) : null,
  );
}
