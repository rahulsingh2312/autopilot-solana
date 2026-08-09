/**
 * Baskets a human curates, pushed through the admin API.
 *
 * icSOL has no filing to watch — it is an editorial index, and the site says so
 * plainly. That does not make it a special case in the pipeline: an editorial
 * push lands in the same `filings` table, builds the same target portfolio,
 * and goes through the same diff and the same on-chain publish as a 13F. The
 * only difference is who the source is, and that is recorded on the row.
 *
 * Keeping the manual path identical to the automated one is deliberate. It
 * means the admin panel exercises the exact code that runs unattended at
 * 4am, so a bug in the executor shows up while somebody is watching.
 */

import { createHash } from "node:crypto";

import { log } from "../log.ts";
import { kvGet, kvSet } from "../store/db.ts";
import type { Filing, SourceAdapter, TrackerBinding } from "../types.ts";

/** One hand-entered position. Weights are relative; the builder normalizes. */
export type EditorialPosition = {
  ticker: string;
  company?: string;
  /** Relative weight. Any positive scale works: 25/20/15 or 2500/2000/1500. */
  weight: number;
};

export type EditorialBasket = {
  positions: EditorialPosition[];
  /** Who changed it and why. Shown in the audit trail. */
  note: string;
  author: string;
  submittedAt: string;
};

const key = (ticker: string) => `editorial:${ticker.toLowerCase()}`;

export const getEditorialBasket = (ticker: string): EditorialBasket | null =>
  kvGet<EditorialBasket>(key(ticker));

/**
 * Records a curated basket. Validation is strict here rather than at publish
 * time, so a bad entry fails in front of the person who typed it.
 */
export function setEditorialBasket(
  ticker: string,
  input: { positions: EditorialPosition[]; note: string; author: string },
): EditorialBasket {
  if (input.positions.length === 0) {
    throw new Error("basket must have at least one position");
  }
  if (input.positions.length > 16) {
    throw new Error("basket cannot exceed 16 positions (program limit MAX_LEGS)");
  }

  const seen = new Set<string>();
  for (const position of input.positions) {
    const symbol = position.ticker.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(symbol)) {
      throw new Error(`invalid ticker: ${position.ticker}`);
    }
    if (seen.has(symbol)) throw new Error(`duplicate ticker: ${symbol}`);
    seen.add(symbol);
    if (!(position.weight > 0)) {
      throw new Error(`${symbol}: weight must be positive`);
    }
  }
  if (!input.note.trim()) throw new Error("note is required: it becomes the audit trail");

  const basket: EditorialBasket = {
    positions: input.positions.map((p) => ({
      ticker: p.ticker.trim().toUpperCase(),
      company: p.company?.trim() || undefined,
      weight: p.weight,
    })),
    note: input.note.trim(),
    author: input.author,
    submittedAt: new Date().toISOString(),
  };

  kvSet(key(ticker), basket);
  log.info("editorial basket recorded", {
    tracker: ticker,
    positions: basket.positions.length,
    author: basket.author,
  });
  return basket;
}

export const editorialAdapter: SourceAdapter = {
  kind: "editorial",

  async fetchLatest(tracker: TrackerBinding): Promise<Filing | null> {
    const basket = getEditorialBasket(tracker.ticker);
    if (!basket) return null;

    // The hash covers the positions only, so re-saving the same basket with a
    // new note does not masquerade as a holdings change.
    const contentHash = createHash("sha256")
      .update(JSON.stringify(basket.positions))
      .digest("hex")
      .slice(0, 32);

    return {
      id: `editorial:${tracker.ticker}:${contentHash}`,
      trackerTicker: tracker.ticker,
      sourceKind: "editorial",
      periodEnd: basket.submittedAt.slice(0, 10),
      filedAt: basket.submittedAt.slice(0, 10),
      sourceUrl: `autopilot://editorial/${tracker.ticker}`,
      contentHash,
      holdings: basket.positions.map((position) => ({
        issuer: position.company ?? position.ticker,
        ticker: position.ticker,
        // Relative weights ride in as value; the builder only ever uses
        // ratios, so the unit is irrelevant as long as it is consistent.
        valueUsd: position.weight,
        isDerivative: false,
      })),
    };
  },
};
