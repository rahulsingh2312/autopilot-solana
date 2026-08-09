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
 * Twelve hours, and it has to be written as a literal: Next reads segment
 * config off the module statically, so `= REVALIDATE_SECONDS` is not a value
 * it can see and the build aborts with "Invalid segment configuration export".
 * The import still earns its keep — the assert below fails the build if the
 * two ever drift, which is the failure the constant was there to prevent.
 */
export const revalidate = 43_200;

const _revalidateMatchesSource: 43_200 = REVALIDATE_SECONDS;
void _revalidateMatchesSource;

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
