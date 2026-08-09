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
    // Curated rather than filing-driven, by request.
    //
    // The House Clerk pipeline still works and still reads her PTRs — it is
    // what produced the honest reconstruction: most of the disclosed activity
    // is call options a long-only vault cannot hold, and of the share sleeve
    // she has been a net seller of the mega-caps. That basket is real but thin.
    // This one is a hand-picked read of the same disclosures, so it stays put
    // until a human changes it. Switch sourceKind back to "congress" to let the
    // filings drive it again.
    sourceKind: "editorial",
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
    //
    topN: 16,
    frozen: false,
  },
  {
    ticker: "bwSOL",
    name: "Buffett Tracker",
    sourceKind: "13f",
    cik: "0001067983", // Berkshire Hathaway Inc
    topN: 12,
    frozen: false,
  },
  {
    ticker: "psqSOL",
    name: "Ackman Tracker",
    sourceKind: "13f",
    cik: "0001336528", // Pershing Square Capital Management
    topN: 10,
    frozen: false,
  },
  {
    ticker: "rdSOL",
    name: "Bridgewater Tracker",
    sourceKind: "13f",
    cik: "0001350694",
    topN: 12,
    frozen: false,
  },
  {
    ticker: "dtSOL",
    name: "Tepper Tracker",
    sourceKind: "13f",
    cik: "0001656456",
    topN: 12,
    frozen: false,
  },
  {
    ticker: "mg7SOL",
    name: "Magnificent Seven",
    sourceKind: "editorial",
    topN: 7,
    frozen: false,
  },
  {
    ticker: "aiSOL",
    name: "AI Infrastructure",
    sourceKind: "editorial",
    // The program's MAX_LEGS. The basket deliberately runs right up to it:
    // the thesis is that the buildout pays the whole chain, so truncating to
    // the famous few would be a different claim.
    topN: 16,
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
