import { NextResponse } from "next/server";

/**
 * The xStocks asset directory, reduced to what a holdings row needs: is this
 * equity tokenized, and what does Backed's own artwork for it look like.
 *
 * Sibling to ../route.ts, which answers the moving question (price, multiplier,
 * halt state) for named symbols. This one answers the standing question, so it
 * is a different shape on a much longer cache: the directory changes when
 * Backed lists a new equity, not by the minute.
 *
 * Keyed by the underlying equity ticker rather than the xStock symbol, because
 * that is how the vault config names holdings — the way the 13F does (NVDA) —
 * and whether a tokenized counterpart exists is exactly what we are asking.
 */

const SOURCE = "https://api.xstocks.fi/api/v2/public/assets";
const NETWORK = "Solana";
/** The directory is ~640 assets at 100 a page; this is headroom, not a cap. */
const PAGE_LIMIT = 20;

/** A day. Backed lists new equities in batches, never mid-session. */
export const revalidate = 86_400;

export type XStockAsset = {
  /** The xStock token symbol, e.g. NVDAx. */
  symbol: string;
  /** Backed's own logo, served from their metadata CDN. */
  logo: string;
  name: string;
};

type ApiNode = {
  symbol?: unknown;
  name?: unknown;
  logo?: unknown;
  underlyingSymbol?: unknown;
};

export async function GET() {
  const assets: Record<string, XStockAsset> = {};

  try {
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const response = await fetch(
        `${SOURCE}?network=${NETWORK}&page=${page}`,
        {
          headers: { accept: "application/json" },
          next: { revalidate },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) break;

      const body = (await response.json()) as {
        nodes?: ApiNode[];
        page?: { hasNextPage?: boolean };
      };

      for (const node of body.nodes ?? []) {
        const { underlyingSymbol, symbol, logo, name } = node;
        if (
          typeof underlyingSymbol !== "string" ||
          typeof symbol !== "string" ||
          typeof logo !== "string"
        ) {
          continue;
        }
        // First listing wins: a few equities are tokenized more than once and
        // the duplicates carry the same artwork anyway.
        assets[underlyingSymbol] ??= {
          symbol,
          logo,
          name: typeof name === "string" ? name : symbol,
        };
      }

      if (!body.page?.hasNextPage) break;
    }
  } catch {
    // A directory we cannot reach is a missing logo, not a broken page: the
    // holdings list falls back to monograms and the numbers are unaffected.
    return NextResponse.json({ assets: {} });
  }

  return NextResponse.json(
    { assets },
    {
      headers: {
        "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}
