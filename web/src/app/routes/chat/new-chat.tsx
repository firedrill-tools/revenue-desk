import { useState } from "react";
import { navigate } from "@/app/router";
import { useSession } from "@/app/session";
import { useNotify } from "@/components/app/notices";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { invalidate } from "@/hooks/use-resource";
import { api, errorMessage } from "@/lib/api";
import { chatHref } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { ChatEmptyState } from "./empty-state";
import { CHAT_COLUMN, COMPOSER_DOCK } from "./layout";
import { setPendingPrompt } from "./pending-prompts";

/**
 * A chat with no conversation yet. The conversation is created on the first
 * send (POST /api/conversations), so abandoned "New chat" clicks leave no
 * empty conversations behind; the conversation screen then sends the prompt.
 */
export function NewChat() {
  const notify = useNotify();
  const session = useSession();
  const [creating, setCreating] = useState(false);
  // Focus the composer on desktop only; on phones it would open the keyboard.
  const desktop = useMediaQuery(DESKTOP_QUERY);

  /**
   * A suggestion names the conversation with its title. A typed prompt sends
   * no title: the server names the conversation from its first sentence.
   */
  const start = async (prompt: string, title?: string) => {
    if (creating) return;
    setCreating(true);
    try {
      const { conversation } = await api.request("POST /api/conversations", {
        body: title === undefined ? {} : { title },
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
        <div className={cn(CHAT_COLUMN, "flex min-h-full flex-col justify-center py-8")}>
          <ChatEmptyState
            onPick={(job) => void start(job.prompt, job.title)}
            disabled={creating}
            showWaiting
          />
        </div>
      </div>
      <div className={COMPOSER_DOCK}>
        <div className={CHAT_COLUMN}>
          <Composer
            status="ready"
            running={false}
            stopping={false}
            busy={creating}
            onSend={(prompt) => void start(prompt)}
            autoFocus={desktop}
            unavailable={session?.modelConfigured === false}
          />
        </div>
      </div>
    </div>
  );
}
