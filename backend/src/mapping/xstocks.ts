/**
 * Equity ticker → the SPL mint that represents it on Solana.
 *
 * Backed's public directory carries a `deployments` array per asset, and the
 * entry with `network: "Solana"` is the mint address. That means the mapping
 * needs no hardcoded registry and stays correct when Backed lists a new name:
 * the token universe is discovered, not declared.
 *
 * Two facts this module exists to keep honest:
 *
 * - **Mints are mainnet-only.** There is no devnet xStocks deployment. On
 *   devnet every leg resolves to no mint, which the program already models as
 *   the SOL sleeve, and the site already says so.
 *
 * - **The multiplier is not the price.** An xStock's claim is
 *   `balance × multiplier` shares, because corporate actions rebase the token
 *   rather than changing its supply. Any valuation that skips it drifts
 *   quietly as splits and dividends accrue.
 */

import { env } from "../env.ts";
import { errText, log } from "../log.ts";
import { getJson } from "../sources/http.ts";
import { kvGet, kvSet } from "../store/db.ts";

const BASE = "https://api.xstocks.fi/api/v2/public";
const NETWORK = "Solana";
const DIRECTORY_KEY = "xstocks:directory";
/** Backed lists in batches, never intraday. A day of staleness is invisible. */
const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 20;

export type XStockAsset = {
  /** xStock symbol, e.g. NVDAx. */
  symbol: string;
  /** Underlying equity ticker, e.g. NVDA. */
  underlying: string;
  name: string;
  /** Solana SPL mint. Null when Backed has no Solana deployment for it. */
  mint: string | null;
  tradingHalted: boolean;
};

type DirectoryNode = {
  symbol?: unknown;
  name?: unknown;
  underlyingSymbol?: unknown;
  isTradingHalted?: unknown;
  deployments?: Array<{ network?: unknown; address?: unknown }>;
};

type DirectoryCache = { fetchedAt: number; assets: Record<string, XStockAsset> };

function solanaMint(node: DirectoryNode): string | null {
  const deployment = node.deployments?.find((d) => d.network === NETWORK);
  return typeof deployment?.address === "string" ? deployment.address : null;
}

async function crawlDirectory(): Promise<Record<string, XStockAsset>> {
  const assets: Record<string, XStockAsset> = {};

  for (let page = 0; page < PAGE_LIMIT; page++) {
    const body = await getJson<{
      nodes?: DirectoryNode[];
      page?: { hasNextPage?: boolean };
    }>(`${BASE}/assets?network=${NETWORK}&page=${page}`);

    for (const node of body.nodes ?? []) {
      const symbol = node.symbol;
      const underlying = node.underlyingSymbol;
      if (typeof symbol !== "string" || typeof underlying !== "string") continue;

      // Keyed by the underlying ticker because that is what a filing carries.
      // A few names are tokenized more than once; the first listing wins and
      // the duplicates are the same claim on the same share.
      if (assets[underlying]) continue;

      assets[underlying] = {
        symbol,
        underlying,
        name: typeof node.name === "string" ? node.name : symbol,
        mint: solanaMint(node),
        tradingHalted: Boolean(node.isTradingHalted),
      };
    }

    if (!body.page?.hasNextPage) break;
  }

  return assets;
}

/**
 * The tokenized universe, keyed by underlying ticker.
 *
 * A failed refresh falls back to the last good crawl rather than returning
 * nothing: an empty directory would look exactly like "Backed tokenizes
 * nothing", which would route every leg to the SOL sleeve and quietly
 * liquidate a basket.
 */
export async function loadDirectory(force = false): Promise<Record<string, XStockAsset>> {
  const cached = kvGet<DirectoryCache>(DIRECTORY_KEY);
  const fresh = cached && Date.now() - cached.fetchedAt < DIRECTORY_TTL_MS;
  if (cached && fresh && !force) return cached.assets;

  try {
    const assets = await crawlDirectory();
    if (Object.keys(assets).length === 0) {
      throw new Error("directory crawl returned no assets");
    }
    kvSet(DIRECTORY_KEY, { fetchedAt: Date.now(), assets } satisfies DirectoryCache);
    log.info("xstocks directory refreshed", {
      assets: Object.keys(assets).length,
      onSolana: Object.values(assets).filter((a) => a.mint).length,
    });
    return assets;
  } catch (error) {
    if (cached) {
      log.warn("xstocks directory refresh failed, serving cache", {
        error: errText(error),
        ageHours: ((Date.now() - cached.fetchedAt) / 3_600_000).toFixed(1),
      });
      return cached.assets;
    }
    throw error;
  }
}

/**
 * Resolves a ticker to its tokenized counterpart.
 *
 * Returns null on devnet regardless of what Backed lists: pretending a mainnet
 * mint exists on devnet would produce a basket the chain cannot hold.
 */
export async function resolveMint(ticker: string): Promise<XStockAsset | null> {
  if (env.cluster !== "mainnet-beta") return null;
  const directory = await loadDirectory();
  const asset = directory[ticker.toUpperCase()];
  return asset?.mint ? asset : null;
}

export type XStockQuote = {
  symbol: string;
  /** USD price of the underlying share, or null when US markets are shut. */
  price: number | null;
  multiplier: number | null;
  marketHalted: boolean;
};

/**
 * Live quote for one xStock.
 *
 * `price` is null outside US market hours — Backed answers 200 with
 * `{"quote": null}` — which is a fact the executor has to respect rather than
 * route around. Sizing a trade against a stale or absent price is how a
 * rebalance turns into a donation.
 */
export async function loadQuote(symbol: string): Promise<XStockQuote> {
  const safe = (path: string) =>
    getJson<Record<string, unknown>>(`${BASE}${path}`).catch(() => null);

  const [priceData, multiplier, status] = await Promise.all([
    safe(`/assets/${symbol}/price-data?network=${NETWORK}`),
    safe(`/assets/${symbol}/multiplier?network=${NETWORK}`),
    safe(`/system/status/${symbol}`),
  ]);

  const quote = priceData?.quote as Record<string, unknown> | null | undefined;
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  return {
    symbol,
    // Backed has shipped this field under several names; accept any rather
    // than report "market closed" because of a key rename.
    price: num(quote?.price) ?? num(quote?.value) ?? num(quote?.mid) ?? num(quote?.last),
    multiplier: num(multiplier?.currentMultiplier),
    marketHalted: Boolean(status?.isMarketTradingHalted),
  };
}

export const loadQuotes = (symbols: string[]): Promise<XStockQuote[]> =>
  Promise.all(symbols.map(loadQuote));
