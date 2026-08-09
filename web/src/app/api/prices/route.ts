import { NextResponse } from "next/server";

/**
 * Live xStock prices, from Jupiter.
 *
 * This replaces Backed's `/price-data` as the price source, for one decisive
 * reason: Backed quotes the *underlying equity*, so it answers `{"quote":null}`
 * whenever US markets are shut — nights, weekends, holidays. That is most of
 * the week, and it left the site showing "US market closed" to almost everyone
 * who ever visited.
 *
 * xStocks themselves trade on Solana AMMs continuously, so Jupiter has a price
 * at 3am on a Sunday. Since the vault would buy and sell at exactly those AMM
 * prices, Jupiter is also the more *honest* number: it is what the basket could
 * actually be transacted at, not what its underlying closed at on Friday.
 *
 *   GET /api/prices?symbols=NVDAx,AAPLx
 *
 * Backed is still the source of truth for the rebasing multiplier — Jupiter
 * exposes one under `scaledUiConfig` but omits it for some tokens, so it can
 * only ever be a bonus here, never a dependency.
 */

const JUPITER_PRICE = "https://lite-api.jup.ag/price/v3";
const XSTOCKS_ASSETS = "https://api.xstocks.fi/api/v2/public/assets";
const NETWORK = "Solana";

/** AMM prices move constantly; half a minute is the right staleness budget. */
export const revalidate = 30;

export type XStockPrice = {
  /** xStock symbol, e.g. NVDAx. */
  symbol: string;
  /** Mint on Solana mainnet. */
  mint: string;
  /** USD price of one token, already scaled by the rebasing multiplier. */
  usdPrice: number;
  /** USD price of the underlying share, when Jupiter carries it. */
  stockPrice: number | null;
  /** Percent move over 24h, as a number (0.39 means +0.39%). */
  change24h: number | null;
  /**
   * Pool depth in USD. Surfaced rather than hidden because it varies by more
   * than an order of magnitude across the lineup, and a leg with thin
   * liquidity is one a rebalance cannot move without paying for it.
   */
  liquidity: number | null;
  /** Rebasing multiplier, when Jupiter reports one. */
  multiplier: number | null;
};

type JupiterEntry = {
  usdPrice?: unknown;
  priceChange24h?: unknown;
  liquidity?: unknown;
  stockData?: { price?: unknown } | null;
  scaledUiConfig?: { multiplier?: unknown } | null;
};

type DirectoryNode = {
  symbol?: unknown;
  deployments?: Array<{ network?: unknown; address?: unknown }>;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * xStock symbol → Solana mint, discovered from Backed's own directory.
 *
 * No hardcoded registry: the mapping stays correct when Backed lists a new
 * equity, and a mint we invented could never be right.
 */
async function loadMints(): Promise<Map<string, string>> {
  const mints = new Map<string, string>();

  for (let page = 0; page < 20; page++) {
    const response = await fetch(`${XSTOCKS_ASSETS}?network=${NETWORK}&page=${page}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) break;

    const body = (await response.json()) as {
      nodes?: DirectoryNode[];
      page?: { hasNextPage?: boolean };
    };

    for (const node of body.nodes ?? []) {
      const symbol = node.symbol;
      const deployment = node.deployments?.find((d) => d.network === NETWORK);
      if (typeof symbol === "string" && typeof deployment?.address === "string") {
        mints.set(symbol, deployment.address);
      }
    }

    if (!body.page?.hasNextPage) break;
  }

  return mints;
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbols") ?? "";

  const symbols = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[A-Za-z0-9.]{1,12}$/.test(s)),
    ),
  ].slice(0, 24);

  if (symbols.length === 0) {
    return NextResponse.json({ prices: [], asOf: new Date().toISOString() });
  }

  try {
    const mints = await loadMints();
    const wanted = symbols
      .map((symbol) => ({ symbol, mint: mints.get(symbol) }))
      .filter((entry): entry is { symbol: string; mint: string } => Boolean(entry.mint));

    if (wanted.length === 0) {
      return NextResponse.json({ prices: [], asOf: new Date().toISOString() });
    }

    const response = await fetch(
      `${JUPITER_PRICE}?ids=${wanted.map((w) => w.mint).join(",")}`,
      {
        headers: { accept: "application/json" },
        next: { revalidate },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) throw new Error(`jupiter ${response.status}`);

    const body = (await response.json()) as Record<string, JupiterEntry | null>;

    const prices: XStockPrice[] = [];
    for (const { symbol, mint } of wanted) {
      const entry = body[mint];
      const usdPrice = num(entry?.usdPrice);
      // A token Jupiter cannot price is omitted, never zeroed. A zero would
      // render as "$0.00" and read as a crash rather than as missing data.
      if (usdPrice === null) continue;

      prices.push({
        symbol,
        mint,
        usdPrice,
        stockPrice: num(entry?.stockData?.price),
        change24h: num(entry?.priceChange24h),
        liquidity: num(entry?.liquidity),
        multiplier: num(entry?.scaledUiConfig?.multiplier),
      });
    }

    return NextResponse.json(
      { prices, asOf: new Date().toISOString() },
      {
        headers: {
          "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
        },
      },
    );
  } catch {
    // A dead upstream degrades to "no prices", never to a broken page: the
    // holdings list still renders its weights, which is the load-bearing part.
    return NextResponse.json(
      { prices: [], asOf: new Date().toISOString(), error: true },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
