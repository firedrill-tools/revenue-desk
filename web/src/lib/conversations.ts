// Conversation list helpers for the rail.
//
// Alias-free and DOM-free so the Node test suite can import it.

import type { ConversationSummary } from "../../../src/contracts/api.js";

export type ConversationGroup = {
  readonly label: "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";
  readonly items: readonly ConversationSummary[];
};

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Groups by last activity (updatedAt), newest first, in the viewer's time zone. */
export function groupByRecency(
  items: readonly ConversationSummary[],
  now: Date = new Date(),
): ConversationGroup[] {
  const today = startOfDay(now);
  const order: ConversationGroup["label"][] = [
    "Today",
    "Yesterday",
    "Previous 7 days",
    "Previous 30 days",
    "Older",
  ];
  const buckets = new Map<ConversationGroup["label"], ConversationSummary[]>();
  const sorted = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const item of sorted) {
    const time = new Date(item.updatedAt);
    const days = Number.isNaN(time.getTime())
      ? Number.POSITIVE_INFINITY
      : Math.round((today - startOfDay(time)) / 86_400_000);
    const label =
      days <= 0
        ? "Today"
        : days === 1
          ? "Yesterday"
          : days <= 7
            ? "Previous 7 days"
            : days <= 30
              ? "Previous 30 days"
              : "Older";
    const bucket = buckets.get(label) ?? [];
    bucket.push(item);
    buckets.set(label, bucket);
  }
  return order.flatMap((label) => {
    const bucket = buckets.get(label);
    return bucket ? [{ label, items: bucket }] : [];
  });
}

export function conversationTitle(conversation: Pick<ConversationSummary, "title">): string {
  const title = conversation.title.trim();
  return title === "" ? "New conversation" : title;
}

/** Conversations with an approval waiting for a person, newest first. */
export function awaitingConversations(
  items: readonly ConversationSummary[],
): ConversationSummary[] {
  return items
    .filter((item) => item.status === "awaiting_approval" || item.pendingApprovals > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Approvals waiting across every conversation: the app bar badge and the tab title. */
export function waitingApprovalCount(items: readonly ConversationSummary[]): number {
  return awaitingConversations(items).reduce(
    (sum, item) => sum + Math.max(1, item.pendingApprovals),
    0,
  );
}

/** "(2) Revenue Desk" while approvals wait, so a background tab says so. */
export function documentTitle(base: string, waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${base}` : base;
}

/** The rail's marker text for a waiting conversation: what it waits for. */
export function waitingMarker(
  conversation: Pick<ConversationSummary, "pendingApprovals" | "pendingConsequence">,
): string {
  const count =
    conversation.pendingApprovals > 1
      ? `${conversation.pendingApprovals} approvals waiting`
      : "Needs approval";
  return conversation.pendingConsequence === null
    ? count
    : `${count} · ${conversation.pendingConsequence}`;
}
