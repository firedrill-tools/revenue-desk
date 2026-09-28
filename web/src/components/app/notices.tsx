import { XIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status";

// Short notices for side actions (archive failed, check finished, settings
// saved). One polite live region; never role="alert". Replaces Sonner, whose
// shadcn wrapper depends on next-themes (docs/ARCHITECTURE.md §9).

type Notice = { readonly id: number; readonly tone: Tone; readonly message: string };
type Notify = (notice: { tone?: Tone; message: string }) => void;

const NoticeContext = createContext<Notify>(() => {});

const DISMISS_AFTER_MS = 5_000;

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    ({ tone = "neutral", message }) => {
      const id = nextId.current++;
      setNotices((current) => [...current.slice(-2), { id, tone, message }]);
      setTimeout(() => dismiss(id), DISMISS_AFTER_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => notify, [notify]);

  return (
    <NoticeContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:right-4"
      >
        {notices.map((notice) => (
          <div
            key={notice.id}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border bg-popover px-3 py-2.5 text-body-sm shadow-popover",
              "fade-in-0 slide-in-from-bottom-2 animate-in duration-150",
            )}
          >
            <StatusDot tone={notice.tone} className="mt-[5px]" />
            <p className="min-w-0 flex-1 text-foreground">{notice.message}</p>
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mr-1 text-muted-foreground"
              aria-label="Dismiss"
              onClick={() => dismiss(notice.id)}
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}

export function useNotify(): Notify {
  return useContext(NoticeContext);
}
