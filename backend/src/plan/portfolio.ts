/**
 * Filing → the basket we intend to hold.
 *
 * This is where a disclosure becomes a product decision, so every reduction it
 * makes is recorded in `excluded` rather than performed silently. The three
 * reductions are always the same:
 *
 *   1. options and non-share rows are dropped (a long-only vault cannot hold
 *      a put, and Scion's final book was 95% of them by value);
 *   2. the book is truncated to the tracker's top N by disclosed value;
 *   3. what remains is renormalized to exactly 100%.
 *
 * Each of those changes what the tracker means, and the card has to be able to
 * say so. A basket that quietly renormalized a 95%-puts filing into "Michael
 * Burry's portfolio" would be the single most dishonest thing this codebase
 * could ship.
 */

import { WEIGHT_DENOMINATOR } from "../types.ts";
import type { Filing, RawHolding, TargetLeg, TargetPortfolio } from "../types.ts";
import { log } from "../log.ts";
import { resolveCusips } from "../mapping/openfigi.ts";
import { loadDirectory, type XStockAsset } from "../mapping/xstocks.ts";
import { env } from "../env.ts";
import type { TrackerBinding } from "../types.ts";

/**
 * Distributes `WEIGHT_DENOMINATOR` across weights so the parts sum to exactly
 * the whole.
 *
 * The program rejects any basket not summing to 10000 bps, and naive rounding
 * lands on 9999 or 10001 often enough to matter. Largest-remainder assigns the
 * floor to everyone, then hands the leftover bps to whoever was rounded down
 * hardest — so the sum is exact by construction and the distortion lands on
 * the position least affected by it.
 */
export function allocateBps(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 0);

  const exact = values.map((v) => (v / total) * WEIGHT_DENOMINATOR);
  const floors = exact.map(Math.floor);
  let remainder = WEIGHT_DENOMINATOR - floors.reduce((sum, v) => sum + v, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  const result = [...floors];
  for (let i = 0; remainder > 0 && i < order.length; i++, remainder--) {
    const slot = order[i];
    if (slot) result[slot.index] = (result[slot.index] ?? 0) + 1;
  }
  // With every value equal the remainder can exceed the number of positions;
  // wrap rather than drop the leftover, since the sum must be exact.
  for (let i = 0; remainder > 0; i = (i + 1) % result.length, remainder--) {
    result[i] = (result[i] ?? 0) + 1;
  }

  return result;
}

/** Share of total disclosed value a set of holdings represents, in bps. */
const shareBps = (subset: RawHolding[], all: RawHolding[]): number => {
  const total = all.reduce((sum, h) => sum + h.valueUsd, 0);
  if (total <= 0) return 0;
  return Math.round(
    (subset.reduce((sum, h) => sum + h.valueUsd, 0) / total) * WEIGHT_DENOMINATOR,
  );
};

export async function buildTargetPortfolio(
  filing: Filing,
  binding: TrackerBinding,
): Promise<TargetPortfolio> {
  const excluded: TargetPortfolio["excluded"] = [];

  // 1. Options and principal-amount rows.
  const derivatives = filing.holdings.filter((h) => h.isDerivative);
  const shares = filing.holdings.filter((h) => !h.isDerivative);
  if (derivatives.length > 0) {
    excluded.push({
      ticker: `${derivatives.length} option positions`,
      reason: "Long-only vault cannot hold options or debt principal",
      weightBps: shareBps(derivatives, filing.holdings),
    });
  }

  // 2. Ticker resolution. Sources that disclose tickers skip OpenFIGI.
  //
  // Only the positions that could plausibly survive truncation are looked up.
  // A large quant filer can disclose thousands of names while a tracker keeps
  // five: resolving the whole book would be a hundred rate-limited OpenFIGI
  // batches to answer a question about the top of an already-sorted list.
  // The headroom covers CUSIPs that fail to resolve and share classes that
  // merge into one leg.
  // Resolve a wider slice when untokenized names will be filtered out later:
  // the top few dozen by value can be mostly names Backed has never listed,
  // and truncating first would leave the basket short.
  const candidateCount = Math.min(
    shares.length,
    binding.tokenizedOnly ? binding.topN * 12 + 40 : binding.topN * 3 + 10,
  );
  const byValue = [...shares].sort((a, b) => b.valueUsd - a.valueUsd);
  const candidates = byValue.slice(0, candidateCount);

  const needLookup = candidates.filter((h) => !h.ticker && h.cusip).map((h) => h.cusip!);
  const resolved = needLookup.length > 0 ? await resolveCusips(needLookup) : new Map();

  type Named = RawHolding & { ticker: string; company: string };
  const named: Named[] = [];
  const unresolved: RawHolding[] = [];

  for (const holding of candidates) {
    const hit = holding.ticker
      ? { ticker: holding.ticker, name: holding.issuer }
      : holding.cusip
        ? resolved.get(holding.cusip.toUpperCase())
        : undefined;
    if (!hit) {
      unresolved.push(holding);
      continue;
    }
    named.push({ ...holding, ticker: hit.ticker, company: hit.name });
  }

  if (unresolved.length > 0) {
    excluded.push({
      ticker: `${unresolved.length} unidentified positions`,
      reason: "CUSIP did not resolve to a listed ticker",
      weightBps: shareBps(unresolved, filing.holdings),
    });
  }

  // A filer can report the same issuer under several CUSIPs (share classes).
  // They are one economic position and one basket leg.
  const byTicker = new Map<string, Named>();
  for (const holding of named) {
    const existing = byTicker.get(holding.ticker);
    if (existing) {
      existing.valueUsd += holding.valueUsd;
      existing.shares = (existing.shares ?? 0) + (holding.shares ?? 0);
    } else {
      byTicker.set(holding.ticker, { ...holding });
    }
  }

  const allRanked = [...byTicker.values()].sort((a, b) => b.valueUsd - a.valueUsd);

  // 2b. Optionally keep only names that exist as an xStock.
  //
  // Deliberately off for every tracker. Turning it on makes each card read
  // "100% tokenized", but only by deleting the holdings that were not — it
  // removed American Express from a Buffett tracker and took Pelosi from eight
  // positions to three. A tracker that drops what it cannot tokenize is no
  // longer tracking the thing it is named after, and the coverage percentage
  // stops being information and becomes a tautology. Carrying the real weight
  // in the SOL sleeve and stating the percentage is the honest shape.
  //
  // Tested against the directory rather than against `mint`, because on devnet
  // no leg carries a mint and the filter would empty every basket.
  const directoryEarly: Record<string, XStockAsset> =
    binding.tokenizedOnly ? await loadDirectory().catch(() => ({})) : {};
  const ranked = binding.tokenizedOnly
    ? allRanked.filter((h) => directoryEarly[h.ticker.toUpperCase()]?.mint)
    : allRanked;

  if (binding.tokenizedOnly) {
    const dropped = allRanked.length - ranked.length;
    const droppedValue = allRanked
      .filter((h) => !directoryEarly[h.ticker.toUpperCase()]?.mint)
      .reduce((sum, h) => sum + h.valueUsd, 0);
    if (dropped > 0) {
      excluded.push({
        ticker: `${dropped} untokenized positions`,
        reason: "No xStock exists for these, so the basket skips to the next name that does",
        weightBps: Math.round(
          (droppedValue / Math.max(1, allRanked.reduce((s, h) => s + h.valueUsd, 0))) *
            WEIGHT_DENOMINATOR,
        ),
      });
    }
  }

  // 3. Truncate to top N.
  const kept = ranked.slice(0, binding.topN);

  // Measured against the whole filing rather than against the candidate slice.
  // Only a few dozen positions were resolved above, but the weight this
  // tracker leaves on the table is everything it did not keep — for a
  // thousand-name filer that is almost the whole book, and reporting it as
  // "the handful I looked at" would understate the exclusion enormously.
  const filingTotal = filing.holdings.reduce((sum, h) => sum + h.valueUsd, 0);
  const keptValue = kept.reduce((sum, h) => sum + h.valueUsd, 0);
  const droppedCount = shares.length - kept.length;
  if (droppedCount > 0 && filingTotal > 0) {
    excluded.push({
      ticker: `${droppedCount} smaller positions`,
      reason: `Tracker holds the top ${binding.topN} by disclosed value`,
      weightBps: Math.max(
        0,
        Math.round(
          ((shares.reduce((sum, h) => sum + h.valueUsd, 0) - keptValue) / filingTotal) *
            WEIGHT_DENOMINATOR,
        ),
      ),
    });
  }

  if (kept.length === 0) {
    throw new Error(`${filing.trackerTicker}: filing ${filing.id} yielded no holdable positions`);
  }

  // 4. Renormalize, then bind to tokenized counterparts.
  const weights = allocateBps(kept.map((h) => h.valueUsd));

  // The directory is consulted on every cluster, but only mainnet gets a mint.
  // Knowing a name *is* tokenized is useful everywhere — it is what lets a
  // devnet leg still be called NVDAx, matching the deployed trackers — while
  // binding a mainnet-only mint on devnet would produce a basket the chain
  // there cannot hold.
  const directory: Record<string, XStockAsset> = await loadDirectory().catch(() => ({}));
  const onMainnet = env.cluster === "mainnet-beta";

  const legs: TargetLeg[] = kept.map((holding, index) => {
    const asset = directory[holding.ticker.toUpperCase()];
    return {
      ticker: holding.ticker,
      company: holding.company,
      weightBps: weights[index] ?? 0,
      mint: onMainnet ? (asset?.mint ?? null) : null,
      xstockSymbol: asset?.symbol ?? null,
    };
  });

  const sum = legs.reduce((total, leg) => total + leg.weightBps, 0);
  if (sum !== WEIGHT_DENOMINATOR) {
    throw new Error(`${filing.trackerTicker}: weights sum to ${sum}, expected ${WEIGHT_DENOMINATOR}`);
  }

  log.info("portfolio built", {
    tracker: filing.trackerTicker,
    filing: filing.id,
    legs: legs.length,
    tokenized: legs.filter((l) => l.mint).length,
    excludedBps: excluded.reduce((total, e) => total + e.weightBps, 0),
  });

  return {
    trackerTicker: filing.trackerTicker,
    filingId: filing.id,
    legs,
    excluded,
    builtAt: new Date().toISOString(),
  };
}
