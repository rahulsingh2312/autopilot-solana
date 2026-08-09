"use client";

import useSWR from "swr";

import type { XStockPrice } from "@/app/api/prices/route";
import type { TrackerConfig } from "@/lib/config";

export type { XStockPrice };

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`prices ${res.status}`);
  return (await res.json()) as { prices: XStockPrice[]; asOf: string };
};

/** Below this, a rebalance moves the price rather than trading at it. */
const THIN_LIQUIDITY_USD = 250_000;

/**
 * Live prices for a tracker's tokenized legs.
 *
 * Sourced from Jupiter rather than Backed. Backed quotes the underlying
 * equity and goes dark whenever US markets are shut, which is most of the
 * week; xStocks trade on Solana AMMs around the clock, so this has a price at
 * 3am on a Sunday — and it is the price the vault would actually transact at.
 *
 * Legs with no tokenized counterpart are not requested at all: there is
 * nothing to price, and asking would only invite a fabricated number.
 */
export function useBasketPrices(tracker: TrackerConfig) {
  const symbols = tracker.legs
    .filter((leg) => leg.tokenized && leg.xstock)
    .map((leg) => leg.xstock as string);

  const key = symbols.length
    ? `/api/prices?symbols=${symbols.join(",")}`
    : null;

  const { data, error, isLoading } = useSWR(key, fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const bySymbol = new Map((data?.prices ?? []).map((p) => [p.symbol, p]));

  /**
   * The basket's own 24h move: each leg's change weighted by its basket
   * weight, renormalized over the legs actually priced.
   *
   * Renormalizing matters. Averaging over the whole basket while only half of
   * it has a price would quietly report a number closer to zero than the
   * truth, so `coverageBps` travels alongside it and the UI states it.
   */
  let weightedChange: number | null = null;
  let coverageBps = 0;

  for (const leg of tracker.legs) {
    if (!leg.xstock) continue;
    const quote = bySymbol.get(leg.xstock);
    if (!quote || quote.change24h === null) continue;
    coverageBps += leg.weightBps;
    weightedChange = (weightedChange ?? 0) + quote.change24h * leg.weightBps;
  }
  if (weightedChange !== null && coverageBps > 0) {
    weightedChange /= coverageBps;
  }

  /**
   * Legs whose pool is too thin to rebalance through without slippage,
   * shallowest first — the lineup spans four orders of magnitude, and the
   * $800 pool is the one a reader needs to see before the $80,000 one.
   */
  const thin = (data?.prices ?? [])
    .filter((p) => p.liquidity !== null && p.liquidity < THIN_LIQUIDITY_USD)
    .sort((a, b) => (a.liquidity as number) - (b.liquidity as number));

  return {
    bySymbol,
    asOf: data?.asOf,
    hasAnyPrice: (data?.prices.length ?? 0) > 0,
    tokenizedCount: symbols.length,
    /** Weighted 24h move across priced legs, in percent. */
    change24h: weightedChange,
    /** Share of the basket that change covers, in bps. */
    coverageBps,
    thin,
    isLoading,
    error,
  };
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export const formatUsdPrice = (value: number) => usd.format(value);

/** Compact USD, for pool depth: $2.0M, $81K. */
export const formatUsdCompact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

/** A signed percentage, always carrying its sign so direction is unmissable. */
export const formatChange = (value: number) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
