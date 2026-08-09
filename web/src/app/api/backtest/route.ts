import { NextResponse } from "next/server";

import { TRACKERS } from "@/lib/config";

/**
 * Weighted historical return for a tracker's basket, computed from real daily
 * closes of the underlying shares.
 *
 * This is a BACKTEST, not fund performance. The vaults hold SOL on devnet and
 * have no trading history, so anything labelled as their return would be a
 * fiction. What this measures is what the published basket would have done,
 * held at today's weights over the window, ignoring fees, rebalancing, and
 * the tracking error a real vault would accumulate. Callers must label it.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Daily is far more data than a single return needs; monthly closes suffice. */
const CHART = (symbol: string, range: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1mo`;

export const revalidate = 21_600; // six hours; closes move once a day at most

export type LegReturn = {
  symbol: string;
  weightBps: number;
  /** Fractional return over the window, e.g. 0.42 for +42%. */
  changePct: number | null;
};

export type BacktestResult = {
  ticker: string;
  range: string;
  /** Weighted basket return, or null when too little of it could be priced. */
  changePct: number | null;
  /** Share of basket weight that actually resolved to price history. */
  coverageBps: number;
  legs: LegReturn[];
  asOf: string;
};

async function legReturn(symbol: string, range: string): Promise<number | null> {
  try {
    const res = await fetch(CHART(symbol, range), {
      headers: { "user-agent": UA, accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };

    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes) return null;

    const clean = closes.filter(
      (c): c is number => typeof c === "number" && Number.isFinite(c) && c > 0,
    );
    if (clean.length < 2) return null;

    return clean[clean.length - 1] / clean[0] - 1;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const ticker = params.get("ticker") ?? "";
  const range = params.get("range") === "2y" ? "2y" : "1y";

  const tracker = TRACKERS.find((t) => t.ticker === ticker);
  if (!tracker) {
    return NextResponse.json({ error: "unknown ticker" }, { status: 404 });
  }

  const legs: LegReturn[] = await Promise.all(
    tracker.legs.map(async (leg) => ({
      symbol: leg.symbol,
      weightBps: leg.weightBps,
      changePct: await legReturn(leg.symbol, range),
    })),
  );

  const priced = legs.filter((l) => l.changePct !== null);
  const coverageBps = priced.reduce((sum, l) => sum + l.weightBps, 0);

  // Renormalize across what actually priced. Below two thirds of the basket
  // the number stops describing the strategy, so report nothing instead.
  const changePct =
    coverageBps >= 6_600
      ? priced.reduce(
          (sum, l) => sum + (l.changePct as number) * (l.weightBps / coverageBps),
          0,
        )
      : null;

  return NextResponse.json(
    {
      ticker,
      range,
      changePct,
      coverageBps,
      legs,
      asOf: new Date().toISOString(),
    } satisfies BacktestResult,
    {
      headers: {
        "cache-control": "public, s-maxage=21600, stale-while-revalidate=86400",
      },
    },
  );
}
