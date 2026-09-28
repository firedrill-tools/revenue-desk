// Chat message helpers (web/src/lib/messages.ts): resume-safe history, usage
// totals, orphan approvals and the status line.

import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";
import type {
  ApprovalView,
  ChatUIMessage,
  ConversationDetail,
  ConversationSummary,
} from "../../../src/contracts/api.js";
import type { RunUsage } from "../../../src/contracts/events.js";
import {
  activityLabel,
  conversationUsage,
  describeActivity,
  isRunSettled,
  messageText,
  messageUsage,
  orphanApprovals,
  prepareInitialMessages,
  streamingRunId,
  titleFromPrompt,
} from "../../../web/src/lib/messages.js";

const usage = (costUsd: number, inputTokens: number): RunUsage => ({
  costUsd,
  inputTokens,
  outputTokens: 100,
  cacheReadTokens: 10,
  cacheCreationTokens: 5,
  numTurns: 2,
  modelRequests: 2,
  durationMs: 1_000,
  durationApiMs: 800,
});

const user = (id: string, text = "Hi"): ChatUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const assistant = (
  id: string,
  runId: string,
  extra: Partial<ChatUIMessage> = {},
): ChatUIMessage => ({
  id,
  role: "assistant",
  metadata: { runId, model: "claude-sonnet-5" },
  parts: [{ type: "text", text: `Answer ${id}`, state: "done" }],
  ...extra,
});

function summary(activeRunId: string | null): ConversationSummary {
  return {
    id: "conv_1",
    title: "t",
    source: "ui",
    status: activeRunId ? "running" : "idle",
    activeRunId,
    pendingApprovals: 0,
    totalCostUsd: 0,
    createdAt: "2026-09-28T10:00:00Z",
    updatedAt: "2026-09-28T10:00:00Z",
    archivedAt: null,
  };
}

function tool(
  state: DynamicToolUIPart["state"],
  title: string,
  extra: object = {},
): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolCallId: title,
    toolName: "mcp__stripe__x",
    title,
    state,
    input: {},
    ...extra,
  } as DynamicToolUIPart;
}

describe("prepareInitialMessages", () => {
  it("drops the active run's partial assistant message, which the resume stream replays", () => {
    const detail: ConversationDetail = {
      conversation: summary("run_2"),
      messages: [user("u1"), assistant("a1", "run_1"), user("u2"), assistant("a2", "run_2")],
      pendingApprovals: [],
    };
    expect(prepareInitialMessages(detail).map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("keeps everything when no run is active or the last message belongs to another run", () => {
    const messages = [user("u1"), assistant("a1", "run_1")];
    expect(
      prepareInitialMessages({ conversation: summary(null), messages, pendingApprovals: [] }),
    ).toHaveLength(2);
    expect(
      prepareInitialMessages({ conversation: summary("run_9"), messages, pendingApprovals: [] }),
    ).toHaveLength(2);
  });
});

describe("message facts", () => {
  it("joins text parts and derives a title", () => {
    const message: ChatUIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "text", text: "One." },
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "Two." },
      ],
    };
    expect(messageText(message)).toBe("One.\n\nTwo.");
    expect(titleFromPrompt("  Refund   the duplicate\ncharge now")).toBe("Refund the duplicate");
    expect(titleFromPrompt("a ".repeat(50), 20)).toBe("a a a a a a a a a a…");
  });

  it("finds the streaming run and whether a run is settled", () => {
    const messages = [user("u"), assistant("a", "run_7")];
    expect(streamingRunId(messages, "streaming")).toBe("run_7");
    // The SDK may still say "submitted" after the start chunk.
    expect(streamingRunId(messages, "submitted")).toBe("run_7");
    expect(streamingRunId(messages, "ready")).toBeNull();
    expect(streamingRunId([user("u")], "streaming")).toBeNull();
    expect(isRunSettled(assistant("a", "r"), true)).toBe(false);
    expect(isRunSettled(assistant("a", "r"), false)).toBe(true);
    expect(
      isRunSettled(
        assistant("a", "r", { metadata: { runId: "r", model: "m", status: "cancelled" } }),
        true,
      ),
    ).toBe(true);
    expect(
      isRunSettled(
        assistant("a", "r", { metadata: { runId: "r", model: "m", status: "running" } }),
        false,
      ),
    ).toBe(false);
  });

  it("reads usage from metadata, else the persisted data part, and totals it", () => {
    const fromMetadata = assistant("a", "r1", {
      metadata: { runId: "r1", model: "m", usage: usage(0.02, 1_000) },
    });
    const fromPart = assistant("b", "r2", {
      parts: [{ type: "data-usage", data: usage(0.05, 3_000) }],
    });
    expect(messageUsage(fromMetadata)?.costUsd).toBe(0.02);
    expect(messageUsage(fromPart)?.inputTokens).toBe(3_000);
    expect(messageUsage(assistant("c", "r3"))).toBeNull();
    const total = conversationUsage([user("u"), fromMetadata, fromPart, assistant("c", "r3")]);
    expect(total).toMatchObject({ inputTokens: 4_000, outputTokens: 200, runs: 2 });
    expect(total.costUsd).toBeCloseTo(0.07);
    expect(total.last?.inputTokens).toBe(3_000);
  });
});

describe("orphanApprovals", () => {
  const approval = (id: string, status: ApprovalView["status"] = "pending") =>
    ({ id, status }) as unknown as ApprovalView;

  it("returns pending approvals the parts do not show yet", () => {
    const messages = [
      assistant("a", "r", {
        parts: [tool("approval-requested", "Refund", { approval: { id: "apr_shown" } })],
      }),
    ];
    expect(
      orphanApprovals(
        [approval("apr_shown"), approval("apr_missing"), approval("apr_done", "approved")],
        messages,
      ).map((item) => item.id),
    ).toEqual(["apr_missing"]);
  });
});

describe("describeActivity", () => {
  it("is idle unless a request is in flight", () => {
    expect(describeActivity("ready", [], null)).toBeNull();
    expect(describeActivity("error", [], null)).toBeNull();
  });

  it("thinks before the first chunk and between steps", () => {
    expect(describeActivity("submitted", [user("u")], null)).toEqual({ kind: "thinking" });
    expect(describeActivity("streaming", [user("u"), assistant("a", "r")], null)).toEqual({
      kind: "thinking",
    });
  });

  it("names the running tool, and how many others run with it", () => {
    const one = assistant("a", "r", {
      parts: [
        tool("output-available", "Search Gmail", { output: 1 }),
        tool("input-available", "List Stripe charges"),
      ],
    });
    expect(describeActivity("streaming", [one], null)).toEqual({
      kind: "tool",
      title: "List Stripe charges",
    });
    const many = assistant("a", "r", {
      parts: [
        tool("input-available", "Search HubSpot"),
        tool("input-available", "List Stripe charges"),
      ],
    });
    expect(activityLabel(describeActivity("streaming", [many], null) ?? { kind: "thinking" })).toBe(
      "List Stripe charges and 1 more",
    );
  });

  it("stays quiet while a person must decide", () => {
    const waiting = assistant("a", "r", {
      parts: [tool("approval-requested", "Refund", { approval: { id: "x" } })],
    });
    expect(describeActivity("streaming", [waiting], null)).toBeNull();
  });

  it("shows model retries and compaction", () => {
    const retry = describeActivity("streaming", [user("u")], {
      phase: "retrying",
      attempt: 2,
      maxAttempts: 10,
      retryInMs: 2_000,
      errorStatus: 529,
    });
    expect(retry && activityLabel(retry)).toBe("Model busy, retrying 2/10");
    const compacting = describeActivity("streaming", [user("u")], { phase: "compacting" });
    expect(compacting && activityLabel(compacting)).toBe("Compacting the conversation");
  });
});
