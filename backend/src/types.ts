/**
 * The domain model, in the order the pipeline produces it:
 *
 *   SourceAdapter → Filing → TargetPortfolio → RebalancePlan → executed txs
 *
 * Each stage is a plain value that can be stored, diffed, and shown to a user.
 * Nothing here knows about Solana; the chain layer consumes these types but
 * this file must stay signable-by-hand and testable without an RPC.
 */

export const WEIGHT_DENOMINATOR = 10_000;

/** How a tracker's target basket is discovered. */
export type SourceKind = "13f" | "congress" | "editorial";

/**
 * One position as the source disclosed it, before any mapping to a token.
 * `valueUsd` is what the filing reports; `shares` is present for 13Fs and
 * absent for range-based congressional disclosures.
 */
export type RawHolding = {
  /** Issuer name exactly as filed. Kept for provenance, never for matching. */
  issuer: string;
  /** 9-character CUSIP. Absent on sources that disclose tickers directly. */
  cusip?: string;
  /** Resolved after mapping. Sources that disclose a ticker set it directly. */
  ticker?: string;
  valueUsd: number;
  shares?: number;
  /**
   * True when the row is an option rather than the underlying share. A
   * long-only vault cannot hold these, and dropping them silently is exactly
   * how a Burry tracker ends up claiming to track a book that was 80% puts.
   */
  isDerivative: boolean;
};

/**
 * A single observation of a source at a point in time. Immutable once stored:
 * this is the evidence behind every basket change, and the UI cites it.
 */
export type Filing = {
  /** Stable identity of this observation, e.g. an EDGAR accession number. */
  id: string;
  trackerTicker: string;
  sourceKind: SourceKind;
  /** Period the filing describes, ISO date. */
  periodEnd: string;
  /** When it became public, ISO date. */
  filedAt: string;
  /** Canonical URL a human can open to check our arithmetic. */
  sourceUrl: string;
  holdings: RawHolding[];
  /** Raw payload hash, so a re-fetch that changed nothing is a no-op. */
  contentHash: string;
};

/** One leg of a basket we intend to hold, after mapping and normalization. */
export type TargetLeg = {
  /** Underlying equity ticker, e.g. NVDA. */
  ticker: string;
  company: string;
  weightBps: number;
  /**
   * The xStocks SPL mint this leg is held as, or null when Backed does not
   * tokenize the name. A null mint means the weight sits in the SOL sleeve,
   * which is a disclosed product fact rather than a dropped position.
   */
  mint: string | null;
  /** The xStocks symbol, e.g. NVDAx. Null exactly when `mint` is null. */
  xstockSymbol: string | null;
};

/**
 * What the tracker should hold, derived from one filing. Weights sum to
 * exactly WEIGHT_DENOMINATOR because the program rejects anything else.
 */
export type TargetPortfolio = {
  trackerTicker: string;
  filingId: string;
  legs: TargetLeg[];
  /** Positions the source disclosed that this basket deliberately excludes. */
  excluded: Array<{ ticker: string; reason: string; weightBps: number }>;
  builtAt: string;
};

/** What the chain currently says the basket is. */
export type OnChainLeg = {
  symbol: string;
  mint: string;
  weightBps: number;
};

/** A single trade the executor must perform to reach the target. */
export type PlannedTrade = {
  side: "buy" | "sell";
  ticker: string;
  mint: string;
  /**
   * Lamports to spend (buy) or token base units to sell. Sized from the
   * vault's current value, so a plan is only valid for the balances it was
   * built against.
   */
  amount: string;
  /** Weight this trade closes, for logging and for the UI's explanation. */
  deltaBps: number;
};

export type RebalancePlan = {
  trackerTicker: string;
  filingId: string;
  /** Summed absolute weight change, in bps. Zero means nothing to do. */
  driftBps: number;
  /** The basket to publish on chain. */
  targetLegs: TargetLeg[];
  previousLegs: OnChainLeg[];
  /** Swaps that move real assets to match the published weights. */
  trades: PlannedTrade[];
  /**
   * Why this plan cannot execute right now, if anything. A non-empty list
   * means "publish weights only", never "guess and proceed".
   */
  blockers: string[];
  builtAt: string;
};

/** Contract every ingestion source implements. */
export type SourceAdapter = {
  kind: SourceKind;
  /**
   * Returns the newest observation, or null when the source has published
   * nothing new. Implementations must be side-effect free and must not throw
   * on an upstream outage: return null and let the caller alarm on staleness.
   */
  fetchLatest(tracker: TrackerBinding): Promise<Filing | null>;
};

/**
 * Binds one on-chain tracker to the source that drives it.
 *
 * Presentation copy stays in the web app's config. This file owns only the
 * machine-readable half: where the data comes from and how to shape it.
 */
export type TrackerBinding = {
  ticker: string;
  name: string;
  sourceKind: SourceKind;
  /** SEC Central Index Key, 13F sources only. */
  cik?: string;
  /** Bioguide ID, used by the Quiver congress path. */
  bioguideId?: string;
  /** Surname as it appears in the House Clerk index, e.g. "Pelosi". */
  memberLast?: string;
  /** State and district, e.g. "CA11". Disambiguates common surnames. */
  memberState?: string;
  /** Keep only this many positions, by disclosed value. */
  topN: number;
  /**
   * Frozen trackers are ingested for the record but never rebalanced — for a
   * filer that deregistered or was acquired, there is no next filing to track
   * and the product should say so rather than quietly go stale.
   */
  frozen: boolean;
  /** Minimum drift before a rebalance is worth a transaction. */
  minDriftBps?: number;
};
