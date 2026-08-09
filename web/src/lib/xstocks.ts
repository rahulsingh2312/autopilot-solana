"use client";

import useSWR from "swr";

import type { XStockQuote } from "@/app/api/xstocks/route";
import type { TrackerConfig } from "@/lib/config";

export type { XStockQuote };

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`xStocks ${res.status}`);
  return (await res.json()) as { quotes: XStockQuote[]; asOf: string };
};

/**
 * Live prices for a tracker's tokenized legs, straight from Backed's public
 * API via our own route.
 *
 * Legs with no tokenized equivalent are not requested at all: there is nothing
 * to price, and asking would only invite a fabricated number.
 */
export function useBasketPrices(tracker: TrackerConfig) {
  const symbols = tracker.legs
    .filter((leg) => leg.tokenized && leg.xstock)
    .map((leg) => leg.xstock as string);

  const key = symbols.length
    ? `/api/xstocks?symbols=${symbols.join(",")}`
    : null;

  const { data, error, isLoading } = useSWR(key, fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const bySymbol = new Map((data?.quotes ?? []).map((q) => [q.symbol, q]));

  const priced = (data?.quotes ?? []).filter((q) => q.price !== null);
  /** Backed answered for every leg but had no quote: US markets are shut. */
  const marketClosed =
    (data?.quotes.length ?? 0) > 0 && priced.length === 0;

  return {
    bySymbol,
    asOf: data?.asOf,
    marketClosed,
    hasAnyPrice: priced.length > 0,
    tokenizedCount: symbols.length,
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
