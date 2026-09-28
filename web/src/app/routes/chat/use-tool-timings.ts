import type { DynamicToolUIPart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolTiming } from "@/components/app/tool-call";
import type { ChatUIMessage } from "@/lib/contracts";
import { toolParts } from "@/lib/messages";

function isInFlight(part: DynamicToolUIPart): boolean {
  return (
    part.state === "input-available" ||
    (part.state === "approval-responded" && part.approval.approved)
  );
}

/**
 * Client-side timings for tool calls seen running in this tab: the live
 * elapsed time, and a duration once they settle (the action log's duration
 * replaces it when the run detail loads). The server's data-progress elapsed
 * time corrects the start after a reload or reconnect.
 */
export function useToolTimings(messages: readonly ChatUIMessage[]): {
  timings: ReadonlyMap<string, ToolTiming>;
  reportProgress: (toolCallId: string, elapsedMs: number) => void;
} {
  const ref = useRef(new Map<string, ToolTiming>());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const now = Date.now();
    let changed = false;
    for (const part of toolParts(messages)) {
      const timing = ref.current.get(part.toolCallId);
      if (part.state === "approval-requested") {
        // Waiting for a person is not run time: restart once it is allowed.
        if (timing) {
          ref.current.delete(part.toolCallId);
          changed = true;
        }
      } else if (isInFlight(part)) {
        if (!timing) {
          ref.current.set(part.toolCallId, { startedAt: now, finishedAt: null });
          changed = true;
        }
      } else if (timing && timing.finishedAt === null) {
        ref.current.set(part.toolCallId, { ...timing, finishedAt: now });
        changed = true;
      }
    }
    if (changed) setVersion((value) => value + 1);
  }, [messages]);

  const reportProgress = useCallback((toolCallId: string, elapsedMs: number) => {
    const startedAt = Date.now() - elapsedMs;
    const timing = ref.current.get(toolCallId);
    if (timing?.finishedAt) return;
    if (!timing || Math.abs(timing.startedAt - startedAt) > 750) {
      ref.current.set(toolCallId, { startedAt, finishedAt: null });
      setVersion((value) => value + 1);
    }
  }, []);

  // A new Map identity per change, so memoized consumers re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks a change inside the ref.
  const timings = useMemo<ReadonlyMap<string, ToolTiming>>(() => new Map(ref.current), [version]);
  return { timings, reportProgress };
}
