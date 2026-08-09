"use client";

import { CountUp } from "@/components/ui/count-up";
import { Halftone } from "@/components/ui/halftone";
import { SolMark } from "@/components/ui/sol-mark";
import { useTrackerSelection } from "./selection";
import type { TrackerConfig } from "@/lib/config";
import {
  computeNav,
  formatNav,
  formatWeight,
  lamportsToSolNumber,
} from "@/lib/format";
import { formatReturn, useTrackerReturns } from "@/lib/returns";
import { useVault } from "@/lib/vault/hooks";
import { TokenMark, useXstocks } from "./token-mark";

/**
 * The basket's trailing year, on the right where the eye can run down the
 * column and compare funds without opening any of them.
 *
 * Labelled "1Y backtest", never "1Y". There is no room on a list row for the
 * full method, so the one word that stops it being read as a track record has
 * to be the word that is there. The long version lives on the fund panel.
 *
 * Every row shares one SWR key, so seven of these cost one request.
 */
function TrailingYear({ tracker }: { tracker: TrackerConfig }) {
  const { oneYear, isLoading } = useTrackerReturns(tracker);

  // A basket with no tokenized leg has nothing to price, so it gets no number rather than a
  // zero. Nothing renders, and the arrow keeps its place.
  if (oneYear === null) return null;

  return (
    <span
      className={`flex shrink-0 flex-col items-end gap-0.5 transition-opacity ${
        isLoading ? "opacity-40" : "opacity-100"
      }`}
    >
      <span
        className={`num text-lg font-semibold tabular-nums sm:text-xl ${
          oneYear >= 0 ? "text-pos" : "text-neg"
        }`}
      >
        {formatReturn(oneYear)}
      </span>
      <span className="num text-[0.625rem] uppercase tracking-wider text-faint">
        1Y backtest
      </span>
    </span>
  );
}

/** Small halftone avatar; falls back to the ticker in mono when no portrait. */
function Avatar({ tracker }: { tracker: TrackerConfig }) {
  return (
    <div className="relative grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl border border-rule bg-paper sm:h-24 sm:w-24">
      {tracker.portrait ? (
        <Halftone
          src={tracker.portrait}
          alt={`Halftone portrait: ${tracker.portraitAlt}`}
          size={96}
          pitch={3}
        />
      ) : (
        <span className="num text-xs text-muted">{tracker.ticker}</span>
      )}
    </div>
  );
}

/**
 * One fund in the list. Tapping it hands the fund to the hero, which scrolls
 * into view as that fund's detail-and-trade panel.
 */
export function TrackerRow({
  tracker,
  index,
}: {
  tracker: TrackerConfig;
  index: number;
}) {
  const { select } = useTrackerSelection();
  const { snapshot } = useVault(tracker.ticker);
  const xstocks = useXstocks();
  const tokenizedBps = tracker.legs
    .filter((leg) => leg.tokenized)
    .reduce((sum, leg) => sum + leg.weightBps, 0);

  const deployed = Boolean(snapshot?.tracker);
  const nav = snapshot ? computeNav(snapshot.netAssets, snapshot.supply) : 1;
  const tvlSol = snapshot ? lamportsToSolNumber(snapshot.netAssets) : 0;

  return (
    <li
      className="rise card overflow-hidden"
      style={{ "--delay": `${index * 90}ms` } as React.CSSProperties}
    >
      <button
        onClick={() => select(tracker.ticker)}
        aria-label={`Open ${tracker.name}`}
        className="group flex w-full items-center gap-3 px-4 py-5 text-left transition-colors hover:bg-paper sm:gap-6 sm:px-6"
      >
        <Avatar tracker={tracker} />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="truncate text-lg font-semibold tracking-tight text-ink sm:text-xl">
            {tracker.name}
          </span>

          {/* What you are buying leads. A vault balance near zero is the
              least interesting true thing about a fund on day one, so it
              rides at the end in the quiet weight. */}
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem]">
            {tracker.legs.length > 0 ? (
              <span className="flex items-center gap-1.5">
                <span className="flex -space-x-1.5">
                  {tracker.legs.slice(0, 4).map((leg) => (
                    <TokenMark
                      key={leg.symbol}
                      symbol={leg.symbol}
                      asset={xstocks[leg.symbol]}
                      size={18}
                    />
                  ))}
                </span>
                <span className="num text-muted">
                  {tracker.legs.length} holdings
                </span>
              </span>
            ) : null}

            {tokenizedBps > 0 ? (
              <span className="num text-faint">
                {formatWeight(tokenizedBps)} tokenized
              </span>
            ) : null}

            {deployed ? (
              <span className="num text-faint">
                <SolMark className="mr-1" />
                <CountUp value={tvlSol} format={(v) => v.toFixed(3)} /> in vault
              </span>
            ) : (
              <span className="num text-faint">not deployed yet</span>
            )}
          </span>
        </div>

        <TrailingYear tracker={tracker} />

        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="hidden h-5 w-5 shrink-0 text-faint transition-transform duration-300 group-hover:-translate-y-0.5 sm:block"
          fill="none"
        >
          <path
            d="M12 19V5m0 0l-6 6m6-6l6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </li>
  );
}
