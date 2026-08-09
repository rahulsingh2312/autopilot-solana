/**
 * STOCK Act disclosures, for pltSOL (one member) and cgSOL (the aggregate).
 *
 * This is the weakest link in the pipeline and the code says so out loud.
 * Unlike a 13F, a congressional disclosure is a *transaction* report, not a
 * holdings report: members file what they bought or sold and in which dollar
 * *range*, never what they hold or how much. A portfolio therefore has to be
 * reconstructed by accumulating trades, and every weight it produces is an
 * estimate built on range midpoints.
 *
 * There **is** a free machine-readable source, contrary to what this file used
 * to say. The community S3 mirrors are genuinely dead (403) and the annual
 * financial disclosures are genuinely scanned — but Periodic Transaction
 * Reports are not. They are generated digitally and carry a real text layer,
 * so the Clerk's own PDFs parse cleanly. `houseClerk.ts` reads them, and that
 * is the default provider.
 *
 * Quiver remains behind CONGRESS_PROVIDER=quiver for the Senate, which the
 * House Clerk obviously does not publish, and for anyone who would rather pay
 * than run poppler.
 */

import { createHash } from "node:crypto";

import { env } from "../env.ts";
import { errText, log } from "../log.ts";
import type { Filing, RawHolding, SourceAdapter, TrackerBinding } from "../types.ts";
import { getJson } from "./http.ts";
import {
  loadFilingIndex,
  loadPtr,
  ptrUrl,
  type ClerkFiling,
  type PtrTransaction,
} from "./houseClerk.ts";

/**
 * Midpoints of the ranges the STOCK Act allows. A filing says
 * "$1,000,001 - $5,000,000" and never a number, so the midpoint is the least
 * wrong single value — and the reason every congressional weight on the site
 * is labelled an estimate.
 */
const RANGE_MIDPOINTS: Array<{ test: RegExp; value: number }> = [
  { test: /1,001\s*-\s*15,000/, value: 8_000 },
  { test: /15,001\s*-\s*50,000/, value: 32_500 },
  { test: /50,001\s*-\s*100,000/, value: 75_000 },
  { test: /100,001\s*-\s*250,000/, value: 175_000 },
  { test: /250,001\s*-\s*500,000/, value: 375_000 },
  { test: /500,001\s*-\s*1,000,000/, value: 750_000 },
  { test: /1,000,001\s*-\s*5,000,000/, value: 3_000_000 },
  { test: /5,000,001\s*-\s*25,000,000/, value: 15_000_000 },
  { test: /25,000,001\s*-\s*50,000,000/, value: 37_500_000 },
  { test: /50,000,000/, value: 50_000_000 },
];

export function rangeMidpoint(range: string): number {
  const normalized = range.replace(/\$/g, "").trim();
  for (const entry of RANGE_MIDPOINTS) {
    if (entry.test.test(normalized)) return entry.value;
  }
  // An unparseable range contributes nothing rather than a made-up number.
  return 0;
}

type QuiverTrade = {
  Ticker?: string;
  Transaction?: string;
  Range?: string;
  TransactionDate?: string;
  ReportDate?: string;
  Representative?: string;
  House?: string;
};

const isPurchase = (transaction: string) => /purchase|buy/i.test(transaction);
const isSale = (transaction: string) => /sale|sold|sell|exchange/i.test(transaction);

/** How far back a trade still counts toward a reconstructed position. */
const LOOKBACK_DAYS = 1095;

async function quiverFetch(path: string): Promise<QuiverTrade[]> {
  if (!env.quiverApiKey) throw new Error("QUIVER_API_KEY is not set");
  return await getJson<QuiverTrade[]>(`https://api.quiverquant.com/beta${path}`, {
    headers: {
      Authorization: `Bearer ${env.quiverApiKey}`,
      accept: "application/json",
    },
    timeoutMs: 20_000,
  });
}

/**
 * Net position per ticker for a single filer.
 *
 * Purchases add their midpoint, sales subtract it, and anything that nets to
 * zero or below is treated as closed. This is a coarse reconstruction and it
 * cannot see cost basis, price moves, or positions opened before the lookback
 * window — which is exactly why the product calls these estimates.
 */
export function reconstructPositions(trades: QuiverTrade[]): RawHolding[] {
  const cutoff = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const net = new Map<string, { value: number; name: string; derivative: boolean }>();

  for (const trade of trades) {
    const ticker = trade.Ticker?.trim().toUpperCase();
    const transaction = trade.Transaction?.trim();
    if (!ticker || !transaction) continue;

    const traded = Date.parse(trade.TransactionDate ?? "");
    if (Number.isFinite(traded) && traded < cutoff) continue;

    const amount = rangeMidpoint(trade.Range ?? "");
    if (amount === 0) continue;

    // Options are disclosed inline, e.g. "INTC call". A long-only vault holds
    // the share instead, which is the same direction and none of the leverage.
    const derivative = /\b(call|put|option)\b/i.test(transaction) ||
      /\b(call|put)\b/i.test(trade.Ticker ?? "");

    const entry = net.get(ticker) ?? {
      value: 0,
      name: ticker,
      derivative,
    };
    if (isPurchase(transaction)) entry.value += amount;
    else if (isSale(transaction)) entry.value -= amount;
    entry.derivative = entry.derivative || derivative;
    net.set(ticker, entry);
  }

  return [...net.entries()]
    .filter(([, entry]) => entry.value > 0)
    .map(([ticker, entry]) => ({
      issuer: entry.name,
      ticker,
      valueUsd: entry.value,
      isDerivative: entry.derivative,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

/**
 * The aggregate book: names held most *widely* across members, equal weighted.
 *
 * Deliberately a breadth measure, not a size measure. Disclosure ranges make
 * true aggregate sizing impossible, so counting distinct members with an open
 * position is the honest question this data can answer — and it is what the
 * cgSOL card already claims to do.
 */
export function reconstructAggregate(trades: QuiverTrade[]): RawHolding[] {
  const cutoff = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const holders = new Map<string, Set<string>>();

  for (const trade of trades) {
    const ticker = trade.Ticker?.trim().toUpperCase();
    const member = trade.Representative?.trim();
    const transaction = trade.Transaction?.trim();
    if (!ticker || !member || !transaction || !isPurchase(transaction)) continue;

    const traded = Date.parse(trade.TransactionDate ?? "");
    if (Number.isFinite(traded) && traded < cutoff) continue;

    const set = holders.get(ticker) ?? new Set<string>();
    set.add(member);
    holders.set(ticker, set);
  }

  return [...holders.entries()]
    .map(([ticker, members]) => ({
      issuer: ticker,
      ticker,
      // "Value" here is a member count. The builder only uses ratios, and
      // equal weighting falls out of the truncation step downstream.
      valueUsd: members.size,
      isDerivative: false,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

/**
 * Reconstructs a book from House Clerk PTR transactions.
 *
 * The same accumulate-and-net approach as the Quiver path, but working from
 * the primary documents, which carry two things a reseller's JSON usually
 * flattens away: the asset-type code, so an option is knowably an option, and
 * both ends of the disclosed range rather than a pre-chosen midpoint.
 *
 * Options are kept and flagged rather than dropped here. The portfolio builder
 * excludes them and reports the excluded weight — which for this filer is most
 * of the book, and is exactly the disclosure pltSOL's card is built around.
 */
export function positionsFromPtrs(transactions: PtrTransaction[]): RawHolding[] {
  const cutoff = Date.now() - LOOKBACK_DAYS * 86_400_000;

  // Shares and options are tracked as separate sleeves of the same ticker,
  // not as one flag on it.
  //
  // This filer routinely holds both at once — buying NVDA calls in December
  // and NVDA shares in January. Marking the whole ticker "derivative" because
  // one transaction was an option discarded the share position along with it,
  // which emptied the basket down to the few names that had never been
  // optioned. The share sleeve is holdable; the option sleeve is not; they
  // have to be counted apart to say either thing truthfully.
  type Sleeve = { shares: number; options: number; name: string };
  const net = new Map<string, Sleeve>();

  for (const txn of transactions) {
    const ticker = txn.ticker?.toUpperCase();
    if (!ticker) continue;

    const traded = Date.parse(txn.transactionDate);
    if (Number.isFinite(traded) && traded < cutoff) continue;

    // Midpoint of the disclosed range. The filing never states a size, so
    // every weight downstream is an estimate and the card says so.
    const amount = (txn.amountLow + txn.amountHigh) / 2;
    if (!(amount > 0)) continue;

    const entry = net.get(ticker) ?? { shares: 0, options: 0, name: txn.assetName || ticker };

    // `OP` is the Clerk's asset-type code for options.
    const isOption = txn.assetCode === "OP";
    const type = txn.transactionType.toUpperCase();
    const signed = type.startsWith("P") ? amount : type.startsWith("S") ? -amount : 0;
    // `E` is an exchange — a spinoff or conversion, not a directional trade.

    if (isOption) entry.options += signed;
    else entry.shares += signed;

    net.set(ticker, entry);
  }

  const holdings: RawHolding[] = [];
  for (const [ticker, entry] of net) {
    if (entry.shares > 0) {
      holdings.push({
        issuer: entry.name,
        ticker,
        valueUsd: entry.shares,
        isDerivative: false,
      });
    }
    // Emitted so the option exposure is *reported* as excluded rather than
    // vanishing. The portfolio builder drops these and states their weight.
    if (entry.options > 0) {
      holdings.push({
        issuer: `${entry.name} (options)`,
        ticker,
        valueUsd: entry.options,
        isDerivative: true,
      });
    }
  }

  return holdings.sort((a, b) => b.valueUsd - a.valueUsd);
}

/**
 * The chamber's aggregate book: names bought by the most distinct members.
 *
 * A breadth measure, not a size one. Disclosure ranges make true aggregate
 * sizing impossible — summing midpoints across 400 filers would produce a
 * confident-looking number built entirely on bucket centres — so the honest
 * question this data answers is "how many members bought this", and equal
 * weighting follows from it. That is what the cgSOL card already claims.
 *
 * Every filing is parsed, but each is cached by document ID, so only genuinely
 * new disclosures cost a download and a poppler run on later cycles.
 */
async function buildAggregate(
  filings: ClerkFiling[],
  tracker: TrackerBinding,
): Promise<Filing | null> {
  if (filings.length === 0) return null;

  filings.sort((a, b) => Date.parse(b.filingDate) - Date.parse(a.filingDate));

  const cutoff = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const buyersByTicker = new Map<string, Set<string>>();
  let parsed = 0;

  for (const filing of filings) {
    let transactions: PtrTransaction[];
    try {
      transactions = await loadPtr(filing);
    } catch (error) {
      log.debug("aggregate ptr skipped", { doc: filing.docId, error: errText(error) });
      continue;
    }
    parsed++;

    // One filer counts once per ticker however many times they bought it.
    const member = `${filing.last},${filing.first},${filing.stateDst}`;
    for (const txn of transactions) {
      const ticker = txn.ticker?.toUpperCase();
      if (!ticker) continue;
      // Shares only: an aggregate of who holds what cannot include exposure a
      // long-only vault could never take.
      if (txn.assetCode === "OP") continue;
      if (!txn.transactionType.toUpperCase().startsWith("P")) continue;

      const traded = Date.parse(txn.transactionDate);
      if (Number.isFinite(traded) && traded < cutoff) continue;

      const buyers = buyersByTicker.get(ticker) ?? new Set<string>();
      buyers.add(member);
      buyersByTicker.set(ticker, buyers);
    }
  }

  const holdings: RawHolding[] = [...buyersByTicker.entries()]
    .map(([ticker, buyers]) => ({
      issuer: ticker,
      ticker,
      // A member count, not dollars. Only ratios are used downstream, and
      // truncating to the top N of a breadth ranking is the equal weighting.
      valueUsd: buyers.size,
      isDerivative: false,
    }))
    .filter((holding) => holding.valueUsd > 1)
    .sort((a, b) => b.valueUsd - a.valueUsd);

  if (holdings.length === 0) {
    log.warn("aggregate reconstruction empty", { tracker: tracker.ticker, parsed });
    return null;
  }

  const newest = filings[0]!;
  const filedAt = new Date(newest.filingDate).toISOString().slice(0, 10);
  const contentHash = createHash("sha256")
    .update(JSON.stringify(holdings.slice(0, 40).map((h) => [h.ticker, h.valueUsd])))
    .digest("hex")
    .slice(0, 32);

  log.info("congress aggregate built", {
    tracker: tracker.ticker,
    filingsParsed: parsed,
    tickers: holdings.length,
    top: holdings.slice(0, 5).map((h) => `${h.ticker}:${h.valueUsd}`).join(","),
  });

  return {
    id: `clerk-agg:${tracker.ticker}:${contentHash}`,
    trackerTicker: tracker.ticker,
    sourceKind: "congress",
    periodEnd: filedAt,
    filedAt,
    sourceUrl: "https://disclosures-clerk.house.gov/FinancialDisclosure",
    holdings,
    contentHash,
  };
}

/** Matches an index entry to the member a tracker follows. */
const matchesMember = (filing: ClerkFiling, tracker: TrackerBinding): boolean => {
  const last = tracker.memberLast?.toLowerCase();
  if (!last) return false;
  if (filing.last.toLowerCase() !== last) return false;
  return tracker.memberState
    ? filing.stateDst.toUpperCase() === tracker.memberState.toUpperCase()
    : true;
};

/**
 * House Clerk path: index → this member's PTRs → transactions → positions.
 *
 * Two calendar years, because a book reconstructed from transactions needs
 * enough history to see the buys that opened the positions still held.
 */
async function fetchFromHouseClerk(
  tracker: TrackerBinding,
): Promise<Filing | null> {
  const year = new Date().getUTCFullYear();
  // Three calendar years, not two. A book reconstructed from transactions is
  // only as wide as the filings behind it, and a filer who trades rarely can
  // net to a handful of positions over two years — too few to fill a basket
  // once untokenized names are filtered out.
  const years = [year, year - 1, year - 2];
  // No member bound means the aggregate tracker: every filer, not one.
  const aggregate = !tracker.memberLast;

  const filings: ClerkFiling[] = [];
  for (const y of years) {
    try {
      const index = await loadFilingIndex(y);
      filings.push(
        ...index.filter(
          (f) => f.filingType === "P" && (aggregate || matchesMember(f, tracker)),
        ),
      );
    } catch (error) {
      // Same reasoning as a failed filing: a year of disclosures missing does
      // not make the book smaller, it makes the answer wrong.
      log.error("clerk index unavailable, abandoning cycle", {
        tracker: tracker.ticker,
        year: y,
        error: errText(error),
      });
      return null;
    }
  }

  if (aggregate) return await buildAggregate(filings, tracker);

  if (filings.length === 0) {
    log.warn("no PTR filings found for member", {
      tracker: tracker.ticker,
      member: tracker.memberLast,
    });
    return null;
  }

  // Newest first, and capped: a book is defined by its recent transactions,
  // and each filing costs a PDF fetch plus a poppler run.
  filings.sort((a, b) => Date.parse(b.filingDate) - Date.parse(a.filingDate));
  const recent = filings.slice(0, 12);

  // Every filing must parse, or the whole read is abandoned.
  //
  // A reconstructed book is the *net* of its transactions, so a single missing
  // filing does not degrade the answer — it changes it. One dropped PTR turned
  // this tracker from five positions into two and published that to chain,
  // because the buys that opened AB, VST and TEM all lived in the filing that
  // failed. Partial input must never become a published basket.
  const transactions: PtrTransaction[] = [];
  for (const filing of recent) {
    try {
      transactions.push(...(await loadPtr(filing)));
    } catch (error) {
      log.error("ptr parse failed, abandoning cycle", {
        tracker: tracker.ticker,
        doc: filing.docId,
        error: errText(error),
      });
      return null;
    }
  }

  const holdings = positionsFromPtrs(transactions);
  if (holdings.length === 0) {
    log.warn("ptr reconstruction empty", { tracker: tracker.ticker });
    return null;
  }

  const newest = recent[0]!;
  const filedAt = new Date(newest.filingDate).toISOString().slice(0, 10);
  const contentHash = createHash("sha256")
    .update(JSON.stringify(holdings.map((h) => [h.ticker, Math.round(h.valueUsd)])))
    .digest("hex")
    .slice(0, 32);

  log.info("house clerk ptrs parsed", {
    tracker: tracker.ticker,
    filings: recent.length,
    transactions: transactions.length,
    positions: holdings.length,
    options: holdings.filter((h) => h.isDerivative).length,
  });

  return {
    id: `clerk:${tracker.ticker}:${contentHash}`,
    trackerTicker: tracker.ticker,
    sourceKind: "congress",
    periodEnd: filedAt,
    filedAt,
    sourceUrl: ptrUrl(newest),
    holdings,
    contentHash,
  };
}

export const congressAdapter: SourceAdapter = {
  kind: "congress",

  async fetchLatest(tracker: TrackerBinding): Promise<Filing | null> {
    if (env.congressProvider === "none") {
      log.warn("congress source disabled", {
        tracker: tracker.ticker,
        hint: "set CONGRESS_PROVIDER=houseClerk to read the official filings",
      });
      return null;
    }

    if (env.congressProvider === "houseClerk") {
      try {
        return await fetchFromHouseClerk(tracker);
      } catch (error) {
        log.warn("house clerk fetch failed", {
          tracker: tracker.ticker,
          error: errText(error),
        });
        return null;
      }
    }

    try {
      const aggregate = !tracker.bioguideId;
      const trades = aggregate
        ? await quiverFetch("/live/congresstrading")
        : await quiverFetch(`/historical/congresstrading/${tracker.bioguideId}`);

      const holdings = aggregate
        ? reconstructAggregate(trades)
        : reconstructPositions(trades);

      if (holdings.length === 0) {
        log.warn("congress reconstruction empty", { tracker: tracker.ticker });
        return null;
      }

      // Newest disclosure date in the set stands in for "as of".
      const filedAt = trades
        .map((t) => t.ReportDate ?? t.TransactionDate ?? "")
        .filter(Boolean)
        .sort()
        .at(-1) ?? new Date().toISOString().slice(0, 10);

      const contentHash = createHash("sha256")
        .update(JSON.stringify(holdings.map((h) => [h.ticker, h.valueUsd])))
        .digest("hex")
        .slice(0, 32);

      log.info("congress fetched", {
        tracker: tracker.ticker,
        positions: holdings.length,
        filedAt,
      });

      return {
        id: `congress:${tracker.ticker}:${contentHash}`,
        trackerTicker: tracker.ticker,
        sourceKind: "congress",
        periodEnd: filedAt.slice(0, 10),
        filedAt: filedAt.slice(0, 10),
        sourceUrl: tracker.bioguideId
          ? `https://www.quiverquant.com/congresstrading/politician/${tracker.bioguideId}`
          : "https://disclosures-clerk.house.gov/FinancialDisclosure",
        holdings,
        contentHash,
      };
    } catch (error) {
      log.warn("congress fetch failed", {
        tracker: tracker.ticker,
        error: errText(error),
      });
      return null;
    }
  },
};
