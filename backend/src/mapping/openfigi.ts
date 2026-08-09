/**
 * CUSIP → ticker, via OpenFIGI.
 *
 * 13F filings identify positions by CUSIP and never by ticker, so nothing
 * downstream can happen until this resolves. OpenFIGI answers unauthenticated
 * at 25 jobs per request and 25 requests per minute, which is ample: the whole
 * universe across all trackers is a few dozen names, and results are cached
 * permanently because a CUSIP's ticker is not a moving number.
 *
 * An API key raises the limits to 100 jobs and 25 requests per 6 seconds and
 * is read from OPENFIGI_API_KEY when present, but is not required.
 */

import { kvGet, kvSet } from "../store/db.ts";
import { errText, log } from "../log.ts";
import { postJson } from "../sources/http.ts";

const ENDPOINT = "https://api.openfigi.com/v3/mapping";
const CACHE_KEY = "openfigi:cusip-ticker";

/**
 * Jobs per request. Ten is the unauthenticated ceiling and it is enforced with
 * a 413, not a helpful error — a batch of eleven fails outright and takes
 * every CUSIP in it with you. With a key the ceiling is 100.
 */
const BATCH_ANONYMOUS = 10;
const BATCH_WITH_KEY = 100;

type FigiRecord = {
  ticker?: string;
  name?: string;
  exchCode?: string;
  securityType?: string;
  compositeFIGI?: string;
};

type FigiResponse = Array<{ data?: FigiRecord[]; warning?: string; error?: string }>;

type Resolved = { ticker: string; name: string };

const loadCache = (): Record<string, Resolved> =>
  kvGet<Record<string, Resolved>>(CACHE_KEY) ?? {};

/**
 * Picks the listing that represents the ordinary US-listed line.
 *
 * A CUSIP maps to many FIGIs — one per venue — and the composite record is the
 * one whose ticker a filing means. Preferring `exchCode: "US"` picks the
 * composite; without it the first non-empty ticker is the honest fallback.
 */
function pickListing(records: FigiRecord[]): Resolved | null {
  const usable = records.filter((r) => r.ticker);
  if (usable.length === 0) return null;

  const composite = usable.find((r) => r.exchCode === "US") ?? usable[0];
  if (!composite?.ticker) return null;

  return {
    // 13Fs carry share classes as separate CUSIPs and OpenFIGI returns them
    // with a slash (BRK/A). Tokenized tickers never contain one.
    ticker: composite.ticker.replace(/\//g, "."),
    name: composite.name ?? composite.ticker,
  };
}

/**
 * Resolves every CUSIP given, returning a map of the ones that resolved.
 *
 * A CUSIP that does not resolve is omitted rather than guessed at. The caller
 * treats an unresolved position as untokenizable, which routes its weight to
 * the SOL sleeve — wrong in a way that is disclosed, instead of wrong in a way
 * that silently buys the wrong equity.
 */
export async function resolveCusips(
  cusips: string[],
): Promise<Map<string, Resolved>> {
  const cache = loadCache();
  const out = new Map<string, Resolved>();

  const missing: string[] = [];
  for (const cusip of new Set(cusips.map((c) => c.toUpperCase()))) {
    const hit = cache[cusip];
    if (hit) out.set(cusip, hit);
    else missing.push(cusip);
  }

  if (missing.length === 0) return out;

  const apiKey = process.env.OPENFIGI_API_KEY?.trim();
  const headers = apiKey ? { "X-OPENFIGI-APIKEY": apiKey } : undefined;
  const batchSize = apiKey ? BATCH_WITH_KEY : BATCH_ANONYMOUS;
  let dirty = false;

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    try {
      const response = await postJson<FigiResponse>(
        ENDPOINT,
        batch.map((cusip) => ({ idType: "ID_CUSIP", idValue: cusip })),
        { headers, timeoutMs: 20_000 },
      );

      for (let j = 0; j < batch.length; j++) {
        const cusip = batch[j];
        const entry = response[j];
        if (!cusip || !entry?.data) continue;
        const listing = pickListing(entry.data);
        if (!listing) continue;
        cache[cusip] = listing;
        out.set(cusip, listing);
        dirty = true;
      }
    } catch (error) {
      // A mapping outage must not take the pipeline down: the affected
      // positions simply stay unresolved this cycle.
      log.warn("openfigi batch failed", {
        size: batch.length,
        error: errText(error),
      });
    }

    // Unauthenticated callers get 25 requests a minute.
    if (!apiKey && i + batchSize < missing.length) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
  }

  if (dirty) kvSet(CACHE_KEY, cache);

  const unresolved = missing.filter((c) => !out.has(c));
  if (unresolved.length > 0) {
    log.warn("cusips unresolved", { count: unresolved.length, sample: unresolved.slice(0, 5) });
  }

  return out;
}
