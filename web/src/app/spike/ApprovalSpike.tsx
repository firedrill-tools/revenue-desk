// Spike S1 page (/spike/approvals): renders the scripted approval stream from
// POST /api/spike/chat with useChat and the owned AI Elements components.
// It is removed when the real chat screen lands.

import { useChat } from "@ai-sdk/react";
import { type DynamicToolUIPart, isTextUIPart } from "ai";
import { useEffect, useState } from "react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  type ApprovalDecisions,
  type ChatUIMessage,
  createChatTransport,
  isHighRiskAction,
  readApprovalFacts,
  readToolMetadata,
  SPIKE_APPROVALS_API,
  SPIKE_CHAT_API,
  useApprovalDecisions,
} from "@/lib/chat";
import { applyTheme, readTheme } from "@/lib/theme";

const SCRIPTED_PROMPT = "Kestrel Analytics says they were charged twice. Refund the duplicate.";

const CONNECTION_LABELS: Record<string, string> = {
  composio: "Composio",
  mcp: "MCP",
  api: "API",
};

function ToolCall({ part, approvals }: { part: DynamicToolUIPart; approvals: ApprovalDecisions }) {
  const metadata = readToolMetadata(part);
  const facts = readApprovalFacts(part.approval);
  const approvalId = part.approval?.id;
  const submission = approvalId ? approvals.submissions[approvalId] : undefined;
  const awaitingDecision = part.state === "approval-requested";
  const sending = awaitingDecision && submission?.status === "sending";
  const failed = awaitingDecision && submission?.status === "failed";
  const connection = metadata.connectionKind
    ? (CONNECTION_LABELS[metadata.connectionKind] ?? metadata.connectionKind)
    : undefined;

  return (
    <div className="flex w-full flex-col gap-2">
      <Tool defaultOpen className="mb-0">
        <ToolHeader
          type="dynamic-tool"
          state={part.state}
          toolName={part.toolName}
          title={part.title}
        />
        <ToolContent>
          {connection ? (
            <p className="text-meta text-muted-foreground">
              {connection}
              {metadata.operation ? ` · ${metadata.operation}` : null}
            </p>
          ) : null}
          <ToolInput input={part.input} />
          <ToolOutput output={part.output} errorText={part.errorText} />
        </ToolContent>
      </Tool>

      <Confirmation approval={part.approval} state={part.state}>
        <ConfirmationTitle className="font-medium text-foreground">
          {facts?.consequence}
        </ConfirmationTitle>
        <ConfirmationRequest>
          {facts && facts.facts.length > 0 ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body-sm">
              {facts.facts.map((fact) => (
                <div key={fact.label} className="contents">
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="min-w-0 break-words tabular-nums">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <p className="text-body-sm text-muted-foreground">Approved</p>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <p className="text-body-sm text-muted-foreground">
            Denied{part.approval?.reason ? `: ${part.approval.reason}` : ""}
          </p>
        </ConfirmationRejected>
        {failed && submission?.error ? (
          <p role="alert" className="text-body-sm text-danger">
            {submission.error}
          </p>
        ) : null}
        <ConfirmationActions>
          {sending ? (
            <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              Sending decision
            </span>
          ) : null}
          <ConfirmationAction
            variant="outline"
            disabled={sending || !approvalId}
            onClick={() => approvalId && approvals.decide(approvalId, false)}
          >
            Deny
          </ConfirmationAction>
          <ConfirmationAction
            className={
              isHighRiskAction(facts?.actionClass)
                ? "h-8 bg-danger px-3 text-danger-foreground text-sm hover:bg-danger/90"
                : "h-8 px-3 text-sm"
            }
            disabled={sending || !approvalId}
            onClick={() => approvalId && approvals.decide(approvalId, true)}
          >
            Approve
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    </div>
  );
}

function AssistantParts({
  message,
  approvals,
}: {
  message: ChatUIMessage;
  approvals: ApprovalDecisions;
}) {
  return message.parts.map((part, index) => {
    const key = `${message.id}-${index}`;
    switch (part.type) {
      case "text":
        return <MessageResponse key={key}>{part.text}</MessageResponse>;
      case "reasoning":
        return (
          <Reasoning key={key} isStreaming={part.state === "streaming"}>
            <ReasoningTrigger />
            <ReasoningContent>{part.text}</ReasoningContent>
          </Reasoning>
        );
      case "dynamic-tool":
        return <ToolCall key={key} part={part} approvals={approvals} />;
      default:
        return null;
    }
  });
}

export function ApprovalSpike() {
  const [transport] = useState(() => createChatTransport({ api: SPIKE_CHAT_API }));
  const { messages, status, error, sendMessage, stop } = useChat<ChatUIMessage>({
    transport,
    throttle: 50,
  });
  const approvals = useApprovalDecisions(SPIKE_APPROVALS_API);
  const running = status === "submitted" || status === "streaming";

  useEffect(() => {
    applyTheme(readTheme());
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-semibold tracking-tight">Revenue Desk</span>
          <span className="rounded-md border px-1.5 text-meta text-muted-foreground">
            Spike: approval stream
          </span>
        </div>
        <a href="/" className="text-body-sm text-brand hover:underline">
          Back to app
        </a>
      </header>

      <Conversation className="min-h-0">
        <ConversationContent className="mx-auto w-full max-w-[760px] px-4 py-6">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Scripted approval stream"
              description="Runs a fixed script through the AI SDK stream: reasoning, a Stripe refund tool call, an approval held on the server, then the result. No model, Stripe account or other system is called."
            />
          ) : (
            messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent className={message.role === "assistant" ? "w-full" : undefined}>
                  {message.role === "assistant" ? (
                    <AssistantParts message={message} approvals={approvals} />
                  ) : (
                    <p className="whitespace-pre-wrap">
                      {message.parts
                        .filter(isTextUIPart)
                        .map((part) => part.text)
                        .join("\n")}
                    </p>
                  )}
                </MessageContent>
              </Message>
            ))
          )}
          {status === "submitted" ? <Shimmer className="text-body-sm">Thinking</Shimmer> : null}
          {error ? (
            <p role="alert" className="text-body-sm text-danger">
              The stream failed: {error.message}
            </p>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <footer className="shrink-0 border-t pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex w-full max-w-[760px] items-center justify-between gap-3 px-4 py-3">
          <p className="min-w-0 text-body-sm text-muted-foreground">
            Scripted demo data. Nothing is sent to a model or an external system.
          </p>
          {running ? (
            <Button variant="outline" onClick={() => stop()}>
              Stop
            </Button>
          ) : (
            <Button onClick={() => sendMessage({ text: SCRIPTED_PROMPT })}>Run script</Button>
          )}
        </div>
      </footer>
    </div>
  );
}
