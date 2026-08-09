/**
 * Which source drives which tracker.
 *
 * This is deliberately NOT a copy of the web app's `config.ts`. That file owns
 * copy, colour, and portraits. This one owns the only two facts the worker
 * needs: where a tracker's holdings come from, and how many of them to keep.
 *
 * Weights are absent on purpose. Once this worker runs, the on-chain
 * `Tracker.legs` is the source of truth for what a tracker holds, and the
 * filing is the source of truth for what it should hold. A third hardcoded
 * copy in the backend would be a third thing to drift.
 */

import type { TrackerBinding } from "./types.ts";

export const TRACKER_BINDINGS: TrackerBinding[] = [
  {
    ticker: "icSOL",
    name: "Inverse Cramer Index",
    sourceKind: "editorial",
    topN: 6,
    frozen: false,
  },
  {
    ticker: "pltSOL",
    name: "Pelosi Tracker",
    sourceKind: "congress",
    bioguideId: "P000197",
    memberLast: "Pelosi",
    memberState: "CA11",
    topN: 8,
    frozen: false,
  },
  {
    ticker: "cgSOL",
    name: "Congress Tracker",
    sourceKind: "congress",
    // No bioguideId: this one aggregates across members rather than following
    // a single filer.
    topN: 5,
    frozen: false,
  },
  {
    ticker: "bwSOL",
    name: "Buffett Tracker",
    sourceKind: "13f",
    cik: "0001067983", // Berkshire Hathaway Inc
    topN: 6,
    frozen: false,
  },
  {
    ticker: "psqSOL",
    name: "Ackman Tracker",
    sourceKind: "13f",
    cik: "0001336528", // Pershing Square Capital Management
    topN: 5,
    frozen: false,
  },
];

export const getBinding = (ticker: string): TrackerBinding | undefined =>
  TRACKER_BINDINGS.find(
    (t) => t.ticker.toLowerCase() === ticker.toLowerCase(),
  );

/** Trackers a scheduled run should actually try to move. */
export const activeBindings = (): TrackerBinding[] =>
  TRACKER_BINDINGS.filter((t) => !t.frozen);
