import { useState } from "react";
import { navigate } from "@/app/router";
import { useNotify } from "@/components/app/notices";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { invalidate } from "@/hooks/use-resource";
import { api, errorMessage } from "@/lib/api";
import { titleFromPrompt } from "@/lib/messages";
import { chatHref } from "@/lib/routes";
import { Composer } from "./composer";
import { ChatEmptyState } from "./empty-state";
import { setPendingPrompt } from "./pending-prompts";

/**
 * A chat with no conversation yet. The conversation is created on the first
 * send (POST /api/conversations), so abandoned "New chat" clicks leave no
 * empty conversations behind; the conversation screen then sends the prompt.
 */
export function NewChat() {
  const notify = useNotify();
  const [creating, setCreating] = useState(false);
  // Focus the composer on desktop only; on phones it would open the keyboard.
  const desktop = useMediaQuery(DESKTOP_QUERY);

  const start = async (prompt: string) => {
    if (creating) return;
    setCreating(true);
    try {
      const { conversation } = await api.request("POST /api/conversations", {
        body: { title: titleFromPrompt(prompt) },
      });
      setPendingPrompt(conversation.id, prompt);
      invalidate("conversations");
      navigate(chatHref(conversation.id));
    } catch (error) {
      notify({ tone: "danger", message: errorMessage(error, "The conversation could not start.") });
      setCreating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-center px-4 py-8 sm:px-6">
          <ChatEmptyState onPick={(prompt) => void start(prompt)} disabled={creating} />
        </div>
      </div>
      <div className="shrink-0 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto w-full max-w-[760px]">
          <Composer
            status="ready"
            running={false}
            stopping={false}
            busy={creating}
            onSend={(prompt) => void start(prompt)}
            autoFocus={desktop}
          />
        </div>
      </div>
    </div>
  );
}
