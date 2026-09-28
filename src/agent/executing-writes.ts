// Writes a run is executing, as its consumers see them in the AgentEvents.
//
// A started write is never cancelled (src/gateway/server.ts): a refund or
// invoice POST may already be at the provider, and only its answer says
// whether it was applied. So whoever ends a run early waits for its
// executing writes, at most WRITE_DRAIN_MS, before giving up on them: the
// agent core before its last events, the server's run registry before it
// closes a run that does not stop, and the CLI before it exits after a
// signal. A write they give up on is recorded as outcome_unknown with its
// idempotency key (src/db/repos/tool-calls.ts), never as not run.
//
// The core reports a call it starts with a tool.progress at 0 ms, then every
// second until its tool.output, so "executing" is: progress seen, no outcome
// yet, and a classification other than read.

import type { AgentEvent } from "../contracts/events.js";
import type { ActionClass } from "../contracts/integration.js";
import { WRITE_DEADLINE_MS } from "../gateway/types.js";

/** How long a run's end waits for its executing writes: their own deadline plus a margin. */
export const WRITE_DRAIN_MS = WRITE_DEADLINE_MS + 5_000;

export class ExecutingWrites {
  readonly #classes = new Map<string, ActionClass | null>();
  readonly #titles = new Map<string, string>();
  readonly #executing = new Set<string>();

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "tool.input.start":
        if (!this.#classes.has(event.toolCallId)) {
          this.#classes.set(event.toolCallId, event.tool?.actionClass ?? null);
        }
        this.#titles.set(event.toolCallId, event.title);
        return;
      case "tool.input.available":
        this.#classes.set(
          event.toolCallId,
          event.tool?.actionClass ?? this.#classes.get(event.toolCallId) ?? null,
        );
        this.#titles.set(event.toolCallId, event.title);
        return;
      case "tool.progress": {
        const actionClass = this.#classes.get(event.toolCallId) ?? null;
        if (actionClass !== null && actionClass !== "read") this.#executing.add(event.toolCallId);
        return;
      }
      case "tool.output":
      case "tool.denied":
        this.#executing.delete(event.toolCallId);
        return;
      case "run.finished":
        this.#executing.clear();
        return;
      default:
        return;
    }
  }

  get count(): number {
    return this.#executing.size;
  }

  /** The executing writes' titles, e.g. "Refund charge in Stripe". */
  titles(): string[] {
    return [...this.#executing].map((id) => this.#titles.get(id) ?? id);
  }
}
