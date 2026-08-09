"use client";

import { createContext, useCallback, useContext, useState } from "react";

import { getTracker, type TrackerConfig } from "@/lib/config";

type Selection = {
  selected: TrackerConfig | null;
  select: (ticker: string) => void;
  clear: () => void;
};

const SelectionContext = createContext<Selection>({
  selected: null,
  select: () => {},
  clear: () => {},
});

/**
 * Tapping a fund anywhere on the page turns the hero into that fund's
 * detail-and-trade panel. The selection lives here so the list and the hero
 * can talk without threading props through the server layout.
 */
export function TrackerSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<TrackerConfig | null>(null);

  const select = useCallback((ticker: string) => {
    setSelected(getTracker(ticker) ?? null);
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, []);

  const clear = useCallback(() => setSelected(null), []);

  return (
    <SelectionContext.Provider value={{ selected, select, clear }}>
      {children}
    </SelectionContext.Provider>
  );
}

export const useTrackerSelection = () => useContext(SelectionContext);
