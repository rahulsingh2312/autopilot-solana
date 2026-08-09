"use client";

import useSWR from "swr";

import type { ReturnsPayload, TrackerReturns } from "@/app/api/returns/route";
import type { TrackerConfig } from "@/lib/config";

export type { ReturnWindow, TrackerReturns } from "@/app/api/returns/route";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`returns ${response.status}`);
  return (await response.json()) as ReturnsPayload;
};

/**
 * Backtested returns for one tracker, with the benchmark beside them.
 *
 * The whole payload is fetched once and the tracker picked out of it rather
 * than requesting per ticker: the baskets overlap heavily — NVDA and AAPL and
 * AMZN each sit in four of them — so one call covers every fund on the page
 * and switching funds costs nothing.
 *
 * An hour is the right staleness budget. The underlying series are daily
 * closes; asking more often cannot produce a different answer.
 */
export function useTrackerReturns(tracker: TrackerConfig) {
  const { data, error, isLoading } = useSWR("/api/returns", fetcher, {
    refreshInterval: 3_600_000,
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const returns: TrackerReturns | null =
    data?.trackers.find((entry) => entry.ticker === tracker.ticker) ?? null;

  const oneYear = returns?.windows.find((w) => w.label === "1Y") ?? null;
  const benchOneYear =
    data?.benchmark?.windows.find((w) => w.label === "1Y") ?? null;

  /**
   * Excess return over the benchmark, in the same units. Only computed when
   * both legs of the comparison exist — a basket measured over a year against
   * an index measured over nothing is not a comparison.
   */
  const excess =
    oneYear?.value != null && benchOneYear?.value != null
      ? oneYear.value - benchOneYear.value
      : null;

  return {
    returns,
    windows: returns?.windows ?? [],
    /** Trailing-year total return, as a fraction. */
    oneYear: oneYear?.value ?? null,
    /** Share of basket weight the trailing-year number covers, in bps. */
    coverageBps: oneYear?.coverageBps ?? 0,
    /** Per-leg trailing-year return, keyed by equity symbol. */
    legs: returns?.legs ?? {},
    benchmark: data?.benchmark ?? null,
    benchmarkOneYear: benchOneYear?.value ?? null,
    excess,
    basis: data?.basis ?? "",
    asOf: data?.asOf,
    isLoading,
    error: error || data?.error,
  };
}

/**
 * A return as a signed percentage. Whole points below 10x, because a basket
 * that did +201% does not need a decimal to make its point, and two of them
 * side by side line up better without one.
 */
export const formatReturn = (value: number) => {
  const pct = value * 100;
  const digits = Math.abs(pct) >= 100 ? 0 : 1;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(digits)}%`;
};
