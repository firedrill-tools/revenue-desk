// The first prompt of a new conversation: the new-chat screen creates the
// conversation (POST /api/conversations), leaves the prompt here and
// navigates; the conversation screen sends it once it has mounted. Peek is
// pure (safe in render); consume is the single destructive read.

const pending = new Map<string, string>();

export function setPendingPrompt(conversationId: string, prompt: string): void {
  pending.set(conversationId, prompt);
}

export function peekPendingPrompt(conversationId: string): string | null {
  return pending.get(conversationId) ?? null;
}

export function consumePendingPrompt(conversationId: string): string | null {
  const prompt = pending.get(conversationId) ?? null;
  pending.delete(conversationId);
  return prompt;
}
