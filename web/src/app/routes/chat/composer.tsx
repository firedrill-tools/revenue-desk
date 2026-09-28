import type { ChatStatus } from "ai";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/ui/spinner";
import { formatCost, formatTokens, pluralize } from "@/lib/format";
import type { ConversationUsage } from "@/lib/messages";

function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 text-meta">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** Tokens and cost of the conversation (AI Elements Context with the server's exact cost). */
function UsageSummary({ usage }: { usage: ConversationUsage }) {
  const total = usage.inputTokens + usage.outputTokens;
  return (
    <Context usedTokens={total} maxTokens={0} costUsd={usage.costUsd}>
      <ContextTrigger>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-meta text-muted-foreground tabular-nums outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11"
        >
          {formatTokens(total)} tokens
          <span aria-hidden="true" className="text-border-strong">
            ·
          </span>
          {formatCost(usage.costUsd)}
        </button>
      </ContextTrigger>
      <ContextContent align="start" side="top" className="w-64">
        <ContextContentBody className="space-y-1.5">
          <p className="pb-1 font-medium text-body-sm">
            This conversation, {pluralize(usage.runs, "run")}
          </p>
          <UsageRow label="Input tokens" value={formatTokens(usage.inputTokens)} />
          <UsageRow label="Output tokens" value={formatTokens(usage.outputTokens)} />
          <UsageRow label="Cache reads" value={formatTokens(usage.cacheReadTokens)} />
          <UsageRow label="Cache writes" value={formatTokens(usage.cacheCreationTokens)} />
          {usage.last ? (
            <UsageRow label="Last run turns" value={String(usage.last.numTurns)} />
          ) : null}
        </ContextContentBody>
        <ContextContentFooter />
      </ContextContent>
    </Context>
  );
}

export type ComposerProps = {
  status: ChatStatus;
  /** A run is in flight (the stream, or an active run found on load). */
  running: boolean;
  stopping: boolean;
  /** Creating the conversation or starting the request. */
  busy?: boolean;
  onSend: (text: string) => void;
  onStop?: (() => void) | undefined;
  usage?: ConversationUsage | null;
  placeholder?: string;
  autoFocus?: boolean;
  /** Nothing can run (no model key): Send stays disabled. */
  unavailable?: boolean;
};

export function Composer({
  status,
  running,
  stopping,
  busy = false,
  onSend,
  onStop,
  usage,
  placeholder = "Ask about a customer, an invoice or a charge",
  autoFocus = false,
  unavailable = false,
}: ComposerProps) {
  const [text, setText] = useState("");
  const canSend = text.trim() !== "" && !running && !busy && !unavailable;
  // The submit button doubles as Stop: it calls POST /api/runs/:id/stop, never useChat().stop().
  const submitStatus: ChatStatus = running ? "streaming" : status === "error" ? "ready" : status;

  return (
    <PromptInput
      className="rounded-xl bg-background [&_[data-slot=input-group]]:rounded-xl [&_[data-slot=input-group]]:border-border-strong [&_[data-slot=input-group]]:bg-background [&_[data-slot=input-group]]:shadow-[0_1px_2px_rgb(17_20_24/0.04)] [&_[data-slot=input-group]]:has-[textarea:focus-visible]:border-foreground/30 [&_[data-slot=input-group]]:has-[textarea:focus-visible]:ring-0"
      onSubmit={({ text: submitted }) => {
        const prompt = submitted.trim();
        if (prompt === "" || running || busy || unavailable) return;
        onSend(prompt);
        setText("");
      }}
    >
      <PromptInputTextarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        aria-label="Message Revenue Desk"
        autoFocus={autoFocus}
        className="min-h-[52px] px-3.5 pt-3 text-base placeholder:text-muted-foreground md:text-body"
      />
      <PromptInputFooter className="px-2 pb-2">
        <PromptInputTools>
          {usage && usage.runs > 0 ? <UsageSummary usage={usage} /> : null}
        </PromptInputTools>
        {running && onStop ? (
          <PromptInputSubmit
            status={submitStatus}
            onStop={stopping ? () => {} : onStop}
            disabled={stopping}
            aria-label={stopping ? "Stopping" : "Stop"}
            className="size-8 rounded-lg"
          >
            {stopping ? (
              <Spinner aria-hidden="true" className="size-4" />
            ) : (
              <SquareIcon className="size-3 fill-current" />
            )}
          </PromptInputSubmit>
        ) : (
          <PromptInputSubmit
            status={submitStatus}
            disabled={!canSend}
            aria-label="Send"
            // Idle, it is a quiet tile rather than a greyed-out ink button.
            className="size-8 rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          >
            {busy ? (
              <Spinner aria-hidden="true" className="size-4" />
            ) : (
              <ArrowUpIcon className="size-4" />
            )}
          </PromptInputSubmit>
        )}
      </PromptInputFooter>
    </PromptInput>
  );
}
