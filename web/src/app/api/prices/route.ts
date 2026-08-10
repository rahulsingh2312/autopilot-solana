import { NextResponse } from "next/server";

/**
 * Live xStock prices: tokens.xyz first, Jupiter as fallback.
 *
 * Both quote the price the token actually trades at on Solana AMMs, which is
 * the honest number for a vault: what the basket could be transacted at, not
 * what its underlying closed at on Friday. Backed's `/price-data` is not in
 * this path at all — it quotes the underlying equity and answers
 * `{"quote":null}` nights, weekends and holidays.
 *
 *   GET /api/prices?symbols=NVDAx,AAPLx
 *
 * # Three sources, in order, and why
 *
 * 1. **tokens.xyz, the held mint.** One batch call for the whole basket, with
 *    deeper pool coverage than Jupiter — $3.27M against $2.01M on NVDAx.
 *
 * 2. **tokens.xyz, the most liquid variant of the same underlying.** The same
 *    equity is tokenized by several issuers, and they are not equally alive.
 *    Uber is the case that forced this: `UBERx` (xStocks) sits on a **$0.28**
 *    pool with zero 24h trades and still prints a stale **$124.03**, against a
 *    real Uber share price of $74.88. `UBERon` (Ondo) holds **$43.45K** and
 *    quotes $74.95. Same company, one dead market and one live one.
 *
 * 3. **Jupiter.** Routes rather than remembering, so it degrades gracefully
 *    where a last-trade price does not, and it covers the case where
 *    tokens.xyz is down or unkeyed entirely.
 *
 * # The guardrail
 *
 * When a better variant supplies the price, `liquidity` still reports the
 * **held** mint's pool, never the variant's. The vault owns UBERx; it cannot
 * reach Ondo's $43K by holding it. Reporting the variant's depth would silence
 * the thin-liquidity warning on a leg that genuinely cannot be traded, which
 * is the opposite of what that warning is for. `betterVariant` carries the
 * alternative explicitly so it can be acted on rather than blended away.
 *
 * Backed remains the source of truth for the rebasing multiplier. Jupiter
 * exposes one under `scaledUiConfig` and tokens.xyz exposes none, so it is a
 * bonus field here and never a dependency.
 */

const TOKENS_XYZ_SNAPSHOTS = "https://api.tokens.xyz/v1/assets/market-snapshots";
const TOKENS_XYZ_SEARCH = "https://api.tokens.xyz/v1/assets/search";
const JUPITER_PRICE = "https://lite-api.jup.ag/price/v3";
const XSTOCKS_ASSETS = "https://api.xstocks.fi/api/v2/public/assets";
const NETWORK = "Solana";

/** AMM prices move constantly; half a minute is the right staleness budget. */
export const revalidate = 30;

/**
 * Below this pool depth a quote is not trusted on its own, because a price is
 * only a price while something is trading against it.
 *
 * The floor is deliberately low. Genuinely thin legs are fine — ASMLx ($94),
 * MUx ($191), TSMx ($1,048) all agree between tokens.xyz and Jupiter to within
 * 0.02% — so this is aimed only at pools that have stopped trading, where a
 * stale print is the failure mode.
 */
const MIN_TRUSTED_LIQUIDITY_USD = 1_000;

export type PriceSource = "tokens.xyz" | "tokens.xyz:variant" | "jupiter";

/** A more liquid tokenization of the same underlying, which the vault does not hold. */
export type BetterVariant = {
  /** e.g. UBERon */
  symbol: string;
  /** e.g. Ondo */
  issuer: string;
  mint: string;
  liquidity: number;
  /** tokens.xyz trust tier for the issuer, when stated. */
  trustTier: string | null;
};

export type XStockPrice = {
  /** xStock symbol, e.g. NVDAx. */
  symbol: string;
  /** Mint on Solana mainnet — the one the vault actually holds. */
  mint: string;
  /** USD price of one token, as traded. */
  usdPrice: number;
  /** USD price of the underlying share, when the upstream carries it. */
  stockPrice: number | null;
  /** Percent move over 24h, as a number (0.39 means +0.39%). */
  change24h: number | null;
  /**
   * Pool depth in USD **of the held mint**. Surfaced rather than hidden
   * because it varies by more than an order of magnitude across the lineup,
   * and a leg with thin liquidity is one a rebalance cannot move without
   * paying for it.
   */
  liquidity: number | null;
  /** Rebasing multiplier, when the upstream reports one. */
  multiplier: number | null;
  /** Which upstream produced this quote. */
  source: PriceSource;
  /**
   * Set when the same underlying has a materially more liquid tokenization
   * elsewhere. A standing signal that this leg is pointed at the wrong mint.
   */
  betterVariant: BetterVariant | null;
};

type DirectoryNode = {
  symbol?: unknown;
  deployments?: Array<{ network?: unknown; address?: unknown }>;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const apiKey = () => process.env.TOKENS_XYZ_API_KEY?.trim() || null;

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

/** What tokens.xyz says about the mint we hold, before any trust decision. */
type Snapshot = {
  usdPrice: number;
  liquidity: number | null;
  change24h: number | null;
};

type SnapshotRow = {
  address?: unknown;
  hasMarket?: unknown;
  token?: { price?: unknown; priceChange24hPercent?: unknown; liquidity?: unknown } | null;
};

/**
 * Batch snapshot of the held mints, keyed by mint.
 *
 * Reports what the upstream said without judging it — the trust decision
 * belongs to the caller, which also knows what to do instead. Returns an empty
 * map on any failure, because a missing key, a dead upstream and a malformed
 * body all have the same correct response: let something else answer.
 */
async function fetchSnapshots(mints: string[]): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  const key = apiKey();
  if (!key || mints.length === 0) return out;

  try {
    const response = await fetch(TOKENS_XYZ_SNAPSHOTS, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ mints }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return out;

    const rows = (await response.json()) as SnapshotRow[];
    if (!Array.isArray(rows)) return out;

    for (const row of rows) {
      const mint = str(row.address);
      const usdPrice = num(row.token?.price);
      // `hasMarket: false` is the upstream saying it knows the token but has
      // no tradeable market for it. That is a gap to fill, not a price.
      if (!mint || usdPrice === null || row.hasMarket === false) continue;

      out.set(mint, {
        usdPrice,
        liquidity: num(row.token?.liquidity),
        change24h: num(row.token?.priceChange24hPercent),
      });
    }
  } catch {
    return out;
  }

  return out;
}

type VariantQuote = { usdPrice: number; change24h: number | null; variant: BetterVariant };

/**
 * The most liquid tokenization of whatever underlying this mint represents.
 *
 * Searching by mint address is an exact lookup — it resolved `UBERx`'s mint to
 * the `uber` asset with a single hit. Searching by *ticker* is fuzzy and must
 * not be used for this: `q=QSR` returns KLA and `q=NRG` returns Coinbase.
 *
 * tokens.xyz ranks variants by liquidity (`primaryVariantStrategy: "liquidity"`),
 * so the primary variant is already the answer.
 */
async function fetchBestVariant(mint: string): Promise<VariantQuote | null> {
  const key = apiKey();
  if (!key) return null;

  try {
    const response = await fetch(`${TOKENS_XYZ_SEARCH}?q=${mint}&limit=1`, {
      headers: { "x-api-key": key, accept: "application/json" },
      // A mint's set of sibling variants changes when an issuer launches one,
      // which is a matter of months, not seconds.
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      results?: Array<{
        primaryVariant?: {
          mint?: unknown;
          symbol?: unknown;
          label?: unknown;
          trustTier?: unknown;
          market?: { price?: unknown; liquidity?: unknown; priceChange24hPercent?: unknown } | null;
        } | null;
      }>;
    };

    const primary = body.results?.[0]?.primaryVariant;
    const variantMint = str(primary?.mint);
    const usdPrice = num(primary?.market?.price);
    const liquidity = num(primary?.market?.liquidity);

    // Same mint back means there is no alternative, only the one we hold.
    if (!primary || !variantMint || variantMint === mint) return null;
    if (usdPrice === null || liquidity === null) return null;
    // A sibling no healthier than the leg it would replace is not an answer.
    if (liquidity < MIN_TRUSTED_LIQUIDITY_USD) return null;

    return {
      usdPrice,
      change24h: num(primary.market?.priceChange24hPercent),
      variant: {
        symbol: str(primary.symbol) ?? "?",
        issuer: str(primary.label) ?? "?",
        mint: variantMint,
        liquidity,
        trustTier: str(primary.trustTier),
      },
    };
  } catch {
    return null;
  }
}

type JupiterEntry = {
  usdPrice?: unknown;
  priceChange24h?: unknown;
  liquidity?: unknown;
  stockData?: { price?: unknown } | null;
  scaledUiConfig?: { multiplier?: unknown } | null;
};

type JupiterQuote = {
  usdPrice: number;
  stockPrice: number | null;
  change24h: number | null;
  liquidity: number | null;
  multiplier: number | null;
};

async function fetchJupiter(mints: string[]): Promise<Map<string, JupiterQuote>> {
  const out = new Map<string, JupiterQuote>();
  if (mints.length === 0) return out;

  try {
    const response = await fetch(`${JUPITER_PRICE}?ids=${mints.join(",")}`, {
      headers: { accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return out;

    const body = (await response.json()) as Record<string, JupiterEntry | null>;

    for (const mint of mints) {
      const entry = body[mint];
      const usdPrice = num(entry?.usdPrice);
      if (usdPrice === null) continue;

      out.set(mint, {
        usdPrice,
        stockPrice: num(entry?.stockData?.price),
        change24h: num(entry?.priceChange24h),
        liquidity: num(entry?.liquidity),
        multiplier: num(entry?.scaledUiConfig?.multiplier),
      });
    }
  } catch {
    return out;
  }

  return out;
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
    const directory = await loadMints();
    const wanted = symbols
      .map((symbol) => ({ symbol, mint: directory.get(symbol) }))
      .filter((e): e is { symbol: string; mint: string } => Boolean(e.mint));

    if (wanted.length === 0) {
      return NextResponse.json({ prices: [], asOf: new Date().toISOString() });
    }

    const mintList = wanted.map((w) => w.mint);
    const snapshots = await fetchSnapshots(mintList);

    // A held mint whose own pool is too shallow to price against. Only these
    // pay for the extra variant lookup, so a healthy basket costs one call.
    const untrusted = mintList.filter((mint) => {
      const snap = snapshots.get(mint);
      return !snap || snap.liquidity === null || snap.liquidity < MIN_TRUSTED_LIQUIDITY_USD;
    });

    const variants = new Map<string, VariantQuote>();
    if (untrusted.length > 0) {
      const found = await Promise.all(untrusted.map((mint) => fetchBestVariant(mint)));
      untrusted.forEach((mint, i) => {
        const quote = found[i];
        if (quote) variants.set(mint, quote);
      });
    }

    // Whatever neither the held pool nor a sibling variant could answer.
    const stillMissing = untrusted.filter((mint) => !variants.has(mint));
    const jupiter = await fetchJupiter(stillMissing);

    const prices: XStockPrice[] = [];
    for (const { symbol, mint } of wanted) {
      const snap = snapshots.get(mint);
      // Always the held mint's own depth, whichever source priced it. This is
      // what says "this leg cannot be traded", and a variant's liquidity would
      // quietly contradict it.
      const heldLiquidity = snap?.liquidity ?? null;
      const trusted =
        snap && snap.liquidity !== null && snap.liquidity >= MIN_TRUSTED_LIQUIDITY_USD;

      if (trusted) {
        prices.push({
          symbol,
          mint,
          usdPrice: snap.usdPrice,
          stockPrice: null,
          change24h: snap.change24h,
          liquidity: heldLiquidity,
          multiplier: null,
          source: "tokens.xyz",
          betterVariant: null,
        });
        continue;
      }

      const variant = variants.get(mint);
      if (variant) {
        prices.push({
          symbol,
          mint,
          usdPrice: variant.usdPrice,
          stockPrice: null,
          change24h: variant.change24h,
          liquidity: heldLiquidity,
          multiplier: null,
          source: "tokens.xyz:variant",
          betterVariant: variant.variant,
        });
        continue;
      }

      const fallback = jupiter.get(mint);
      // A token nothing can price is omitted, never zeroed. A zero would
      // render as "$0.00" and read as a crash rather than as missing data.
      if (!fallback) continue;

      prices.push({
        symbol,
        mint,
        usdPrice: fallback.usdPrice,
        stockPrice: fallback.stockPrice,
        change24h: fallback.change24h,
        liquidity: heldLiquidity ?? fallback.liquidity,
        multiplier: fallback.multiplier,
        source: "jupiter",
        betterVariant: null,
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
