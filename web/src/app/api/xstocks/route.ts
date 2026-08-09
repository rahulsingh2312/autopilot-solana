import { NextResponse } from "next/server";

/**
 * Server-side proxy for the xStocks public API.
 *
 * Runs on the server so the browser never deals with CORS, and so one cache
 * entry serves every visitor instead of each of them hammering Backed. Only
 * `/public/*` endpoints are used, which need no API key.
 *
 *   GET /api/xstocks                       → asset directory, keyed by the
 *                                            UNDERLYING ticker (NVDA, not NVDAx)
 *   GET /api/xstocks?symbols=NVDAx,TSLAx   → live quotes for those xStocks
 */

const BASE = "https://api.xstocks.fi/api/v2/public";
const NETWORK = "Solana";

/** Backed's own numbers move slowly; a minute of staleness is invisible. */
export const revalidate = 60;

export type XstockAsset = {
  /** The xStock ticker, e.g. NVDAx. */
  symbol: string;
  /** The share it represents, e.g. NVDA. */
  underlyingSymbol: string;
  name: string;
  logo: string;
  isTradingHalted: boolean;
};

export type XStockQuote = {
  symbol: string;
  /** Indicative price of the underlying share in USD, or null when closed. */
  price: number | null;
  /**
   * Rebasing multiplier. An xStock's claim is `balance × multiplier` shares,
   * so any valuation that skips this drifts as corporate actions accrue.
   */
  multiplier: number | null;
  marketHalted: boolean;
  /** True when the API answered but carried no quote, i.e. market closed. */
  quoteUnavailable: boolean;
};

async function fetchJson(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // A dead upstream must degrade to "no data", never to a broken page.
    return null;
  }
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

async function loadDirectory(): Promise<Record<string, XstockAsset>> {
  const assets: Record<string, XstockAsset> = {};

  // `/assets` is paged at 100 and reports `page.hasNextPage`. Backed lists
  // ~130 names, so a single request silently drops NVDA and most of the
  // mega-caps every basket here actually holds.
  const nodes: unknown[] = [];
  for (let page = 0; page < 10; page++) {
    const data = (await fetchJson(`/assets?page=${page}`)) as {
      nodes?: unknown[];
      page?: { hasNextPage?: boolean };
    } | null;
    if (!data?.nodes?.length) break;
    nodes.push(...data.nodes);
    if (!data.page?.hasNextPage) break;
  }

  for (const node of nodes) {
    const n = node as Record<string, unknown>;
    const symbol = typeof n.symbol === "string" ? n.symbol : null;
    const underlying =
      typeof n.underlyingSymbol === "string" ? n.underlyingSymbol : null;
    const logo = typeof n.logo === "string" ? n.logo : null;
    if (!symbol || !underlying || !logo) continue;

    // Keyed by the underlying ticker, because that is what a basket leg
    // carries. Backed lists some names on several venues; first wins.
    if (assets[underlying]) continue;
    assets[underlying] = {
      symbol,
      underlyingSymbol: underlying,
      name: typeof n.name === "string" ? n.name : symbol,
      logo,
      isTradingHalted: Boolean(n.isTradingHalted),
    };
  }

  return assets;
}

async function loadQuote(symbol: string): Promise<XStockQuote> {
  const [priceData, multiplier, status] = await Promise.all([
    fetchJson(`/assets/${symbol}/price-data?network=${NETWORK}`),
    fetchJson(`/assets/${symbol}/multiplier?network=${NETWORK}`),
    fetchJson(`/system/status/${symbol}`),
  ]);

  const quote = (priceData as { quote?: unknown } | null)?.quote as
    | Record<string, unknown>
    | null
    | undefined;

  // Backed has shipped this under a few names; accept any of them rather than
  // silently reporting "closed" because of a key rename.
  const price =
    asNumber(quote?.price) ??
    asNumber(quote?.value) ??
    asNumber(quote?.mid) ??
    asNumber(quote?.last);

  return {
    symbol,
    price,
    multiplier: asNumber(
      (multiplier as { currentMultiplier?: unknown } | null)?.currentMultiplier,
    ),
    marketHalted: Boolean(
      (status as { isMarketTradingHalted?: unknown } | null)
        ?.isMarketTradingHalted,
    ),
    quoteUnavailable: price === null,
  };
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbols");

  if (raw === null) {
    return NextResponse.json(
      { assets: await loadDirectory() },
      {
        headers: {
          "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  }

  const symbols = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[A-Za-z0-9.]{1,12}$/.test(s)),
    ),
  ].slice(0, 24);

  const quotes = await Promise.all(symbols.map(loadQuote));

  return NextResponse.json(
    { quotes, asOf: new Date().toISOString() },
    {
      headers: {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
