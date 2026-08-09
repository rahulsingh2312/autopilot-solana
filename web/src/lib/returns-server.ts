import { TRACKERS } from "@/lib/config";

/**
 * Backtested returns for every tracker, plus the index beside them.
 *
 * Tiingo is the source the repo had been missing: every free price-history
 * feed tried before either rate-limited from Vercel egress (Yahoo), demanded a
 * proof-of-work (Stooq), or only served IBM (Alpha Vantage's demo key).
 *
 * **What this number is, and is not.** It is a backtest of the basket each
 * tracker publishes *today*, held unchanged across the window. It is not the
 * investor's return — it ignores when they actually bought, how much, the
 * options they hold that a long-only vault cannot, and the cash they sit on.
 * Nor is it the vault's return: the vaults are days old and hold SOL. Every
 * consumer of this route has to say "backtest", and `basis` travels with the
 * payload so the disclosure cannot be separated from the number.
 *
 * Prices are of the *underlying* equity rather than the xStock, because that
 * is what the token is a claim on, and because the equity has years of history
 * where the token has months.
 *
 * The whole payload is computed in one request. The baskets overlap heavily —
 * NVDA, AAPL and AMZN each sit in several — so a per-tracker route would fetch
 * the same series repeatedly and burn a free tier that allows 50 requests an
 * hour.
 */

const TIINGO = "https://api.tiingo.com/tiingo/daily";
const TOKEN = process.env.TIINGO_API_KEY?.trim() ?? "";

/** The index every basket is measured against. */
const BENCHMARK = "SPY";

/** Twelve hours. The inputs are daily closes; asking more often cannot help. */
export const REVALIDATE_SECONDS = 43_200;

export type ReturnWindow = {
  label: string;
  /** Total return as a fraction (0.2274 = +22.74%), or null if unmeasurable. */
  value: number | null;
  /** Share of basket weight this number covers, in bps. */
  coverageBps: number;
  /** True when `value` is a per-year rate rather than a total. */
  annualized?: boolean;
};

export type TrackerReturns = {
  ticker: string;
  windows: ReturnWindow[];
  /** Trailing-year return per equity symbol, as a fraction. */
  legs: Record<string, number>;
};

export type ReturnsPayload = {
  trackers: TrackerReturns[];
  benchmark: { ticker: string; windows: ReturnWindow[] } | null;
  basis: string;
  asOf: string;
  error?: string;
};

type Bar = { date: string; price: number };

/** Window definitions. 3Y and 5Y are annualized; YTD and 1Y are totals. */
const WINDOWS: Array<{ label: string; days: number | "ytd"; annualized: boolean }> = [
  { label: "YTD", days: "ytd", annualized: false },
  { label: "1Y", days: 365, annualized: false },
  { label: "3Y", days: 1095, annualized: true },
  { label: "5Y", days: 1825, annualized: true },
];

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/**
 * Five years of weekly adjusted closes for one symbol.
 *
 * `adjClose` is split- and dividend-adjusted; using the raw close would report
 * a 4:1 split as a 75% loss. Weekly resampling keeps the payload small without
 * changing any window measured in months.
 */
async function loadSeries(symbol: string): Promise<Bar[] | null> {
  const start = new Date(Date.now() - 1900 * 86_400_000).toISOString().slice(0, 10);
  const url =
    `${TIINGO}/${encodeURIComponent(symbol)}/prices` +
    `?startDate=${start}&resampleFreq=weekly&token=${TOKEN}`;

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;

    const rows = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) return null;

    const bars: Bar[] = [];
    for (const row of rows) {
      const price = num(row.adjClose) ?? num(row.close);
      const date = typeof row.date === "string" ? row.date.slice(0, 10) : null;
      if (price !== null && date) bars.push({ date, price });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

/** Total return across a window, as a fraction. */
function windowReturn(bars: Bar[], days: number | "ytd"): number | null {
  const cutoff =
    days === "ytd"
      ? `${new Date().getUTCFullYear()}-01-01`
      : new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const start = bars.find((bar) => bar.date >= cutoff);
  const end = bars[bars.length - 1];
  if (!start || !end || start === end || start.price <= 0) return null;

  // A window the series does not actually cover would otherwise report the
  // whole history as if it were five years: a 2-year-old listing showing a
  // "5Y" number is a fabrication.
  if (days !== "ytd") {
    const spanDays =
      (Date.parse(end.date) - Date.parse(bars[0]!.date)) / 86_400_000;
    if (spanDays < days * 0.9) return null;
  }

  return (end.price - start.price) / start.price;
}

/** Converts a total return over `days` into a per-year rate. */
const annualize = (total: number, days: number): number =>
  Math.pow(1 + total, 365 / days) - 1;

export async function loadReturnsPayload(): Promise<ReturnsPayload> {
  const asOf = new Date().toISOString();
  const basis =
    "Backtest, not performance. Each fund's basket is held at its currently published weights " +
    "across the window, priced on the underlying equity's split- and dividend-adjusted closes " +
    "(Tiingo). It is not the investor's return — it ignores their trade timing, position sizing, " +
    "the options they hold that a long-only vault cannot, and their cash. It is not the vault's " +
    "return either: these vaults are days old. Legs with no price are excluded and the remaining " +
    "weight renormalized, which is what the coverage figure reports. 3Y and 5Y are annualized.";

  if (!TOKEN) {
    return {
      trackers: [],
      benchmark: null,
      basis,
      asOf,
      error: "TIINGO_API_KEY is not configured",
    };
  }

  // Every distinct underlying across every basket, plus the index.
  const symbols = [
    ...new Set([
      BENCHMARK,
      ...TRACKERS.flatMap((tracker) => tracker.legs.map((leg) => leg.symbol)),
    ]),
  ];

  // Four at a time: the free tier allows 50 requests an hour, and a burst of
  // twenty parallel fetches is the fastest way to spend that on one cold load.
  const series = new Map<string, Bar[]>();
  for (let i = 0; i < symbols.length; i += 4) {
    const group = symbols.slice(i, i + 4);
    const loaded = await Promise.all(group.map(loadSeries));
    group.forEach((symbol, index) => {
      const bars = loaded[index];
      if (bars) series.set(symbol, bars);
    });
  }

  const benchmarkBars = series.get(BENCHMARK);
  const benchmark = benchmarkBars
    ? {
        ticker: BENCHMARK,
        windows: WINDOWS.map(({ label, days, annualized }) => {
          const total = windowReturn(benchmarkBars, days);
          return {
            label,
            value:
              total === null
                ? null
                : annualized && typeof days === "number"
                  ? annualize(total, days)
                  : total,
            coverageBps: total === null ? 0 : 10_000,
            annualized,
          } satisfies ReturnWindow;
        }),
      }
    : null;

  const trackers: TrackerReturns[] = TRACKERS.map((tracker) => {
    const legs: Record<string, number> = {};
    const oneYear = windowReturnsFor(tracker.legs, series, 365);
    for (const [symbol, value] of oneYear.perLeg) legs[symbol] = value;

    return {
      ticker: tracker.ticker,
      legs,
      windows: WINDOWS.map(({ label, days, annualized }) => {
        const { weighted, coverageBps } = windowReturnsFor(tracker.legs, series, days);
        return {
          label,
          value:
            weighted === null
              ? null
              : annualized && typeof days === "number"
                ? annualize(weighted, days)
                : weighted,
          coverageBps,
          annualized,
        } satisfies ReturnWindow;
      }),
    };
  });

  return { trackers, benchmark, basis, asOf };
}

/**
 * Weight-averages one window across a basket.
 *
 * Renormalized over the legs that actually priced, with the covered weight
 * reported alongside. Averaging over the full basket while half of it is
 * unpriced would drag every number toward zero and quietly understate a
 * concentrated bet.
 */
function windowReturnsFor(
  legs: Array<{ symbol: string; weightBps: number }>,
  series: Map<string, Bar[]>,
  days: number | "ytd",
): { weighted: number | null; coverageBps: number; perLeg: Map<string, number> } {
  const perLeg = new Map<string, number>();
  let weightedSum = 0;
  let coverageBps = 0;

  for (const leg of legs) {
    const bars = series.get(leg.symbol);
    if (!bars) continue;
    const value = windowReturn(bars, days);
    if (value === null) continue;
    perLeg.set(leg.symbol, value);
    weightedSum += value * leg.weightBps;
    coverageBps += leg.weightBps;
  }

  return {
    weighted: coverageBps > 0 ? weightedSum / coverageBps : null,
    coverageBps,
    perLeg,
  };
}
