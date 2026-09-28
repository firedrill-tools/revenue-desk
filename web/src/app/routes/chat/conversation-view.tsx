import { Link } from "@/app/router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChatSession } from "./chat-session";
import { CHAT_COLUMN, COMPOSER_DOCK } from "./layout";

/** History skeleton: keeps the thread's structure (user block, prose, tool rows). */
function ThreadSkeleton() {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <div className={cn(CHAT_COLUMN, "flex-1 space-y-8 overflow-hidden pt-6")}>
        {[0, 1].map((turn) => (
          <div key={turn} className="space-y-4">
            <Skeleton className="ml-auto h-10 w-2/3 rounded-[10px] sm:w-1/2" />
            <div className="space-y-2.5">
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
      <div className={COMPOSER_DOCK}>
        <div className={CHAT_COLUMN}>
          <Skeleton className="h-[92px] w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export function ConversationView({ conversationId }: { conversationId: string }) {
  const { data, error, loading, reload } = useResource(`conversation:${conversationId}`, (signal) =>
    api.request("GET /api/conversations/:conversationId", {
      params: { conversationId },
      signal,
    }),
  );

  if (loading) return <ThreadSkeleton />;
  if (error || !data) {
    const missing = error instanceof ApiError && error.code === "not_found";
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="font-medium">
          {missing ? "This conversation does not exist." : "The conversation did not load."}
        </p>
        {missing ? (
          <Link href="/" className="text-body-sm">
            Start a new chat
          </Link>
        ) : (
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return <ChatSession detail={data} />;
}
