import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { parseBoolean, useLocalState } from "@/hooks/use-local-state";
import { useMediaQuery, WIDE_QUERY } from "@/hooks/use-media-query";

// Shell state shared by the app bar and the screens: the phone rail sheet and
// the chat inspector (closed by default). The inline inspector on wide
// screens is remembered per browser; the sheet on narrow screens always
// starts closed, so it never pops open on its own.

export type InspectorTab = "activity" | "run";

type ShellState = {
  readonly railOpen: boolean;
  readonly setRailOpen: (open: boolean) => void;
  readonly inspectorOpen: boolean;
  readonly setInspectorOpen: (open: boolean) => void;
  /** Closes the narrow-screen sheet without touching the wide-screen preference. */
  readonly closeInspectorSheet: () => void;
  readonly inspectorTab: InspectorTab;
  readonly setInspectorTab: (tab: InspectorTab) => void;
  /** Set by the chat screen: the inspector toggle only shows for a conversation. */
  readonly inspectorAvailable: boolean;
  readonly setInspectorAvailable: (available: boolean) => void;
};

const ShellContext = createContext<ShellState | null>(null);

const parseTab = (raw: string): InspectorTab | undefined =>
  raw === "activity" || raw === "run" ? raw : undefined;

export function ShellProvider({ children }: { children: ReactNode }) {
  const [railOpen, setRailOpen] = useState(false);
  const wide = useMediaQuery(WIDE_QUERY);
  const [inspectorPinned, setInspectorPinned] = useLocalState(
    "revenue-desk:inspector-open",
    false,
    parseBoolean,
  );
  const [inspectorSheetOpen, setInspectorSheetOpen] = useState(false);
  const inspectorOpen = wide ? inspectorPinned : inspectorSheetOpen;
  const setInspectorOpen = wide ? setInspectorPinned : setInspectorSheetOpen;
  const [inspectorTab, setInspectorTab] = useLocalState<InspectorTab>(
    "revenue-desk:inspector-tab",
    "activity",
    parseTab,
  );
  const [inspectorAvailable, setInspectorAvailable] = useState(false);
  // Stable, so effects that depend on it do not re-run when the shell changes.
  const closeInspectorSheet = useCallback(() => setInspectorSheetOpen(false), []);

  const value = useMemo<ShellState>(
    () => ({
      railOpen,
      setRailOpen,
      inspectorOpen,
      setInspectorOpen,
      closeInspectorSheet,
      inspectorTab,
      setInspectorTab,
      inspectorAvailable,
      setInspectorAvailable,
    }),
    [
      railOpen,
      inspectorOpen,
      setInspectorOpen,
      closeInspectorSheet,
      inspectorTab,
      setInspectorTab,
      inspectorAvailable,
    ],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useShell must be used inside ShellProvider");
  return context;
}
