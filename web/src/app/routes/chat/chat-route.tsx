import { useEffect } from "react";
import { useShell } from "@/app/shell-context";
import { ConversationView } from "./conversation-view";
import { NewChat } from "./new-chat";

export default function ChatRoute({ conversationId }: { conversationId: string | null }) {
  const { setInspectorAvailable, closeInspectorSheet } = useShell();

  useEffect(() => {
    setInspectorAvailable(conversationId !== null);
    return () => {
      setInspectorAvailable(false);
      closeInspectorSheet();
    };
  }, [conversationId, setInspectorAvailable, closeInspectorSheet]);

  // Motion honours prefers-reduced-motion in CSS (web/src/styles/globals.css);
  // no component uses the motion library.
  return conversationId === null ? (
    <NewChat />
  ) : (
    <ConversationView key={conversationId} conversationId={conversationId} />
  );
}
