import { NextResponse } from "next/server";

import { loadReturnsPayload, REVALIDATE_SECONDS } from "@/lib/returns-server";

/**
 * Backtested returns for every tracker. The computation lives in
 * `lib/returns-server.ts` because the homepage needs it too — it orders the
 * fund grid by trailing-year return, and doing that on the server avoids the
 * cards reshuffling under the reader after hydration.
 *
 * Both callers go through the same `fetch` calls with the same revalidate
 * window, so Next dedupes them and the free Tiingo tier sees one set of
 * requests every twelve hours rather than one per render.
 */

/**
 * Rendered on demand, never prerendered.
 *
 * A `revalidate` here made this route a build target, and the build ran it
 * against Tiingo from Vercel's builder, where every symbol came back unusable
 * — production served `value: null, coverageBps: 0` for every window while the
 * same code returned real numbers locally, and the 12-hour window meant that
 * empty answer was frozen in for twelve hours. A backtest that silently
 * publishes nulls is worse than one that is briefly slow.
 *
 * The twelve-hour window is not lost: it lives on each symbol's own fetch in
 * `returns-server.ts` (SERIES_TTL/REVALIDATE_SECONDS), so the first request
 * after a cold data cache pays the walk and the rest are free — and a failed
 * walk is retried on the next request instead of cached as fact.
 */
export const dynamic = "force-dynamic";

// Kept honest: the data cache the comment above relies on is this constant.
void REVALIDATE_SECONDS;

export type {
  ReturnWindow,
  TrackerReturns,
  ReturnsPayload,
} from "@/lib/returns-server";

export async function GET() {
  const payload = await loadReturnsPayload();
  return NextResponse.json(payload, {
    headers: payload.error
      ? { "cache-control": "no-store" }
      : { "cache-control": "public, s-maxage=43200, stale-while-revalidate=86400" },
  });
}
