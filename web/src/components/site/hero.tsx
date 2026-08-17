"use client";

import { useEffect, useRef, useState } from "react";
import { PlaneTakeoff } from "lucide-react";

import { CountUp } from "@/components/ui/count-up";
import { DepositFlow } from "@/components/site/deposit-flow";
import { NavFootnote, NavStar } from "@/components/ui/nav-note";
import { Halftone } from "@/components/ui/halftone";
import { SolMark } from "@/components/ui/sol-mark";
import { TokenTicker } from "@/components/ui/token-icon";
import { Performance } from "@/components/trackers/performance";
import { TradeForm } from "@/components/trackers/trade-form";
import { TokenMark, useXstocks } from "@/components/trackers/token-mark";
import { useTrackerSelection } from "@/components/trackers/selection";
import {
  EXPLORER,
  TRACKERS,
  WATCH_SECONDS,
  type TrackerConfig,
} from "@/lib/config";
import {
  computeNav,
  formatNav,
  formatWeight,
  lamportsToSolNumber,
  truncateAddress,
} from "@/lib/format";
import { useVault } from "@/lib/vault/hooks";
import { formatChange, formatUsdPrice, useBasketPrices } from "@/lib/xstocks";

const PORTRAITS = TRACKERS.filter((t) => t.portrait).map((t) => ({
  src: t.portrait!,
  alt: `Halftone dot portrait: ${t.portraitAlt}`,
  ticker: t.ticker,
  subject: t.subject,
}));

const HOLD_MS = 3000;

/**
 * Live line under the CTA: the vault behind whichever portrait the dot matrix
 * is showing, so the numbers and the face are always the same fund. The label
 * comes off the snapshot, not the requested ticker — while a new vault is
 * still in flight SWR hands back the previous one, and a stale number under a
 * fresh ticker would be a lie. Real numbers or nothing, never a placeholder.
 */
function LiveLine({ ticker }: { ticker: string }) {
  const { snapshot } = useVault(ticker);
  if (!snapshot?.tracker) return null;
  const nav = computeNav(snapshot.netAssets, snapshot.supply);
  const tvl = lamportsToSolNumber(snapshot.netAssets);

  return (
    <p className="num flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm text-muted">
      <span>
        <TokenTicker ticker={snapshot.ticker} size={15} /> vault{" "}
        <span className="grad-num text-lg font-semibold">
          <SolMark className="mr-0.5" />
          <CountUp value={tvl} format={(v) => v.toFixed(3)} />
        </span>
      </span>
      <span>
        NAV
        <NavStar />{" "}
        <span className="grad-num text-lg font-semibold">
          <CountUp value={nav} format={formatNav} />
        </span>
      </span>
      <span className="text-faint">read live from devnet</span>
    </p>
  );
}

/**
 * The rotating gallery: every tracked subject, rendered in ink dots. When a
 * fund is selected the cycle pins to that fund's subject. The index lives in
 * `Hero` so the live line under the CTA reads the same fund as the face.
 */
function PortraitCycle({
  pinned,
  index,
}: {
  pinned?: TrackerConfig | null;
  index: number;
}) {
  const current = pinned?.portrait
    ? {
        src: pinned.portrait,
        alt: `Halftone dot portrait: ${pinned.portraitAlt}`,
        ticker: pinned.ticker,
        subject: pinned.subject,
      }
    : PORTRAITS[index];

  if (!current) return null;

  return (
    <figure className="flex w-full min-w-0 flex-col items-end gap-3 lg:sticky lg:top-28">
      {/* Same canvas, new src: the dots morph in place, no blank frame. */}
      <Halftone
        src={current.src}
        alt={current.alt}
        size={460}
        pitch={pinned ? 5 : 6}
      />
      {/* The dot count used to live here. It counted a screen that now
          breathes, so it never settled on a number, and it told a reader
          nothing about the fund. */}
      <figcaption className="meta" aria-live="polite">
        {current.ticker} · {current.subject}
      </figcaption>
    </figure>
  );
}

/** Holdings shown before the list asks to be opened. */
const VISIBLE_LEGS = 3;

/**
 * The tracking strip under the card and the portrait. This is the part of a
 * basket that is about time rather than about price: how often we go back to
 * the source, and when the weights move.
 *
 * Four labels and four values, and nothing else. Each cell used to carry a
 * sentence or two explaining itself, which is the wrong register for a fund
 * whose whole promise is that you do not have to watch it. Anyone who wants
 * the long version can follow the source link in the heading.
 */
function TrackingStrip({ tracker }: { tracker: TrackerConfig }) {
  const frozen = tracker.status === "frozen";
  const { snapshot } = useVault(tracker.ticker);
  const deployed = Boolean(snapshot?.tracker);

  const cells = [
    {
      label: "Source check",
      value: frozen ? "Stopped" : `Every ${WATCH_SECONDS}s`,
    },
    {
      label: "Source publishes",
      // "Quarterly, back to equal weight" — the cadence is the first clause;
      // what it rebalances to is already on the card as the weights.
      value: tracker.rebalance.split(",")[0],
    },
    {
      // Ours, not the filer's: the gap between the source publishing and the
      // holdings changing, which the watcher closes.
      label: "Our delay",
      value: "None",
    },
    {
      label: "In vault",
      value: deployed
        ? `${lamportsToSolNumber(snapshot!.netAssets).toFixed(3)} SOL`
        : "Not deployed",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12 sm:px-6 lg:pb-16">
      {/* The trade in one picture before the mechanics of it in four cells.
          Pinned to this fund, so the right-hand tile is this token rather
          than a carousel of ones the reader did not choose. */}
      <div className="border-t border-rule pb-2 pt-8">
        <DepositFlow pinned={tracker.ticker} />
      </div>

      <div className="flex flex-col gap-5 border-t border-rule pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="display text-[clamp(1.5rem,3vw,2rem)] text-ink">
            How {tracker.ticker} stays current
          </h2>
          <a
            href={tracker.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="num text-[0.6875rem] uppercase tracking-wider text-faint underline decoration-dotted underline-offset-4 transition-colors hover:text-ink"
          >
            {tracker.source}
          </a>
        </div>

        {/* Two lines per cell, so all four fit a phone two-up without a
            scroll and the whole strip reads in about a second. */}
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule sm:grid-cols-4">
          {cells.map((cell) => (
            <div
              key={cell.label}
              className="flex flex-col gap-2 bg-bg p-4 sm:p-5"
            >
              <dt className="meta">{cell.label}</dt>
              <dd className="text-[0.9375rem] font-semibold leading-snug text-ink">
                {cell.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** All of a fund on one pane of glass: facts on top, the trade below them. */
function FundPanel({ tracker }: { tracker: TrackerConfig }) {
  const { clear } = useTrackerSelection();
  const { snapshot, refresh } = useVault(tracker.ticker);
  const xstocks = useXstocks();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const deployed = Boolean(snapshot?.tracker);
  const nav = snapshot ? computeNav(snapshot.netAssets, snapshot.supply) : 1;
  const prices = useBasketPrices(tracker);

  // The holdings list is what the vault can hold. A disclosed name with no
  // token on chain is not a holding — it is a hole, and its weight sits in the
  // SOL sleeve — so it stays out of the list entirely and out of every count.
  const tradable = tracker.legs.filter((leg) => leg.tokenized);
  const untradable = tracker.legs.filter((leg) => !leg.tokenized);

  // The top three carry most of the weight in every basket here; the tail is
  // for people who came to read it.
  const [allLegs, setAllLegs] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  const legs = [
    ...(allLegs ? tradable : tradable.slice(0, VISIBLE_LEGS)),
    ...(showMissing ? untradable : []),
  ];
  // Bars scale to what is on screen, so hiding the largest hole does not leave
  // every remaining bar drawn against a weight nobody can see.
  const maxWeight = Math.max(1, ...legs.map((l) => l.weightBps));

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [tracker.ticker]);

  return (
    <div className="glass flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="display text-[clamp(2rem,4.5vw,2.75rem)] text-ink outline-none"
          >
            {tracker.name}
          </h1>
          <p className="num text-[0.8125rem] text-faint">
            <TokenTicker ticker={tracker.ticker} size={15} />
            {deployed ? (
              <>
                {` · NAV `}
                <NavStar />
                {` ${formatNav(nav)} SOL`}
              </>
            ) : (
              " · not deployed yet"
            )}
          </p>
        </div>
        <button
          onClick={clear}
          className="num shrink-0 rounded-full border border-rule bg-bg px-3 py-1.5 text-[0.6875rem] uppercase tracking-wider text-muted transition-colors hover:text-ink"
        >
          ← All funds
        </button>
      </div>

      <p className="max-w-xl text-[0.9375rem] leading-relaxed text-ink">
        {tracker.hook}
      </p>

      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-3">
          {tradable.length > 0 ? (
            <div className="glass-inset group/holdings flex flex-col gap-2 p-3 sm:p-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-baseline gap-2">
                  <span className="meta">Holdings</span>
                  {/* The names the vault cannot hold are disclosure, not product,
                  so they stay out of the way until asked for. On a pointer the
                  toggle only surfaces on hover; touch has no hover, so there
                  it is simply always there. */}
                  {untradable.length > 0 ? (
                    <button
                      onClick={() => setShowMissing((open) => !open)}
                      className="num rounded-full border border-rule px-2 py-0.5 text-[0.5625rem] uppercase tracking-wider text-faint transition-all hover:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-hover/holdings:opacity-100"
                    >
                      {showMissing
                        ? "hide"
                        : `+${untradable.length} not tradable`}
                    </button>
                  ) : null}
                </span>
                {prices.tokenizedCount > 0 ? (
                  <span className="num flex items-baseline gap-2 text-[0.625rem] text-faint">
                    {prices.hasAnyPrice ? (
                      <>
                        {/* The basket's own 24h move. Renormalized over the legs
                        actually priced, and it says so when that is not all
                        of them rather than quietly averaging toward zero. */}
                        {prices.change24h !== null ? (
                          <span
                            className={
                              prices.change24h >= 0 ? "text-pos" : "text-neg"
                            }
                            title={
                              prices.coverageBps < 10_000
                                ? `Covers ${formatWeight(prices.coverageBps)} of the basket`
                                : "24h move across the whole basket"
                            }
                          >
                            {formatChange(prices.change24h)} 24h
                            {prices.coverageBps < 10_000 ? "*" : ""}
                          </span>
                        ) : null}
                        {/* <span>live from Jupiter</span> */}
                      </>
                    ) : (
                      "prices unavailable"
                    )}
                  </span>
                ) : null}
              </div>
              <ul className="flex flex-col">
                {legs.map((leg) => (
                  <li
                    key={leg.symbol}
                    className={`weightbar flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-rule py-1.5 text-[0.8125rem] first:border-t-0 sm:flex-nowrap sm:gap-x-2.5 ${
                      leg.tokenized ? "" : "opacity-55"
                    }`}
                    style={
                      {
                        "--w": `${(leg.weightBps / maxWeight) * 100}%`,
                      } as React.CSSProperties
                    }
                  >
                    <TokenMark
                      symbol={leg.symbol}
                      asset={xstocks[leg.symbol]}
                    />
                    <span className="num w-12 shrink-0 font-semibold text-ink sm:w-14">
                      {leg.tokenized ? leg.xstock : leg.symbol}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-faint">
                      {leg.company}
                    </span>
                    {(() => {
                      // A revealed hole says why it is a hole, in the column the
                      // price would have been in.
                      if (!leg.tokenized)
                        return (
                          <span className="num shrink-0 text-[0.6875rem] uppercase tracking-wider text-faint">
                            no token
                          </span>
                        );
                      const quote = leg.xstock
                        ? prices.bySymbol.get(leg.xstock)
                        : undefined;
                      if (!quote) return null;
                      return (
                        // The per-leg 24h move is the first thing to go on a narrow
                        // screen: price and weight both carry more, and the row's
                        // fixed columns otherwise floor it wider than the phone.
                        <span className="flex shrink-0 items-baseline gap-1.5">
                          <span className="num tabular-nums text-ink">
                            {formatUsdPrice(quote.usdPrice)}
                          </span>
                          {quote.change24h !== null ? (
                            <span
                              className={`num hidden w-14 text-right text-[0.6875rem] tabular-nums sm:block ${
                                quote.change24h >= 0 ? "text-pos" : "text-neg"
                              }`}
                            >
                              {formatChange(quote.change24h)}
                            </span>
                          ) : (
                            <span className="hidden w-14 sm:block" />
                          )}
                        </span>
                      );
                    })()}
                    <span className="num w-12 shrink-0 text-right tabular-nums text-muted sm:w-14">
                      {formatWeight(leg.weightBps)}
                    </span>
                  </li>
                ))}
              </ul>

              {tradable.length > VISIBLE_LEGS ? (
                <button
                  onClick={() => setAllLegs((open) => !open)}
                  className="num self-start pt-1.5 text-[0.6875rem] uppercase tracking-wider text-faint transition-colors hover:text-ink"
                >
                  {allLegs ? "Show less" : `Show all ${tradable.length}`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          {deployed && snapshot?.tracker ? (
            <TradeForm
              tracker={tracker}
              snapshot={snapshot}
              onSettled={() => refresh()}
            />
          ) : (
            <a href="/launch" className="btn btn-ghost self-start">
              Get told when it ships
            </a>
          )}

          {deployed ? <NavFootnote /> : null}

          {deployed && snapshot ? (
            // The token, not the vault. Someone reading this wants the address
            // they can paste into a wallet or an explorer to see the thing they
            // hold; the vault PDA is an implementation detail they cannot do
            // anything with.
            <a
              href={EXPLORER("address", snapshot.shareMintAddress)}
              target="_blank"
              rel="noreferrer"
              className="num self-start text-[0.6875rem] text-faint underline decoration-dotted underline-offset-4 transition-colors hover:text-ink"
            >
              {snapshot.ticker} {truncateAddress(snapshot.shareMintAddress, 6)}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function Hero() {
  const { selected } = useTrackerSelection();
  const [index, setIndex] = useState(0);

  // One clock for the whole hero: it advances the portrait and, with it, the
  // vault the live line is reading. Pinned to a fund, nothing rotates.
  useEffect(() => {
    if (selected) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % PORTRAITS.length),
      HOLD_MS,
    );
    return () => clearInterval(id);
  }, [selected]);

  return (
    <section className="relative -mt-16 overflow-hidden border-b border-rule pt-16">
      <div
        className={`relative mx-auto grid max-w-6xl gap-8 px-4 sm:px-6 lg:gap-10 ${
          selected
            ? "pb-8 pt-8 lg:grid-cols-2 lg:items-start lg:pb-10 lg:pt-10"
            : "pb-20 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pb-28 lg:pt-24"
        }`}
      >
        {selected ? (
          // Keyed by ticker: a different fund is a different panel, so React
          // remounts it and every local toggle (open holdings, expanded
          // caveat, a half-typed deposit) resets without an effect to do it.
          <FundPanel key={selected.ticker} tracker={selected} />
        ) : (
          <div className="flex flex-col gap-7">
            <h1
              className="display rise text-[clamp(3rem,8vw,5.5rem)] text-ink"
              style={{ "--delay": "0ms" } as React.CSSProperties}
            >
              Trade the trader,
              <br />
              <em>not the market.</em>
            </h1>

            <p
              className="rise max-w-md text-lg leading-relaxed text-muted"
              style={{ "--delay": "90ms" } as React.CSSProperties}
            >
              Deposit SOL and hold one token that tracks a famous
              investor&apos;s disclosed portfolio. Burn it back to SOL whenever
              you like. No brokerage account, no market hours.
            </p>

            <div
              className="rise flex flex-wrap items-center gap-3"
              style={{ "--delay": "180ms" } as React.CSSProperties}
            >
              <a href="#trackers" className="btn btn-grad group">
                Run it up
                {/* The plane lifts off toward the trackers the button scrolls
                    to. Reduced motion already flattens the transition. */}
                <PlaneTakeoff
                  size={16}
                  aria-hidden="true"
                  className="transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                />
              </a>
              <a href="#how" className="btn btn-ghost">
                How it works
              </a>
            </div>

            <div
              className="rise"
              style={{ "--delay": "260ms" } as React.CSSProperties}
            >
              <LiveLine ticker={PORTRAITS[index].ticker} />
            </div>

            <p
              className="rise text-xs leading-relaxed text-faint"
              style={{ "--delay": "320ms" } as React.CSSProperties}
            >
              Not an ETF. Not advice. Not affiliated with anyone a tracker
              follows. Devnet: test SOL only.
            </p>
          </div>
        )}

        {/* The backtest sits under the portrait rather than under the holdings:
            it belongs to the person, not to the panel, and the column it used
            to live in was already carrying the weights, the caveat, and the
            trade form. */}
        <div
          /* w-fit takes its width from the portrait, the widest child, and the
             default stretch then pulls the backtest out to the same edges —
             so the two read as one stacked unit instead of a card parked
             under a picture. */
          className="rise mx-auto flex w-full min-w-0 flex-col gap-6 lg:mx-0 lg:ml-auto lg:w-fit lg:self-center"
          style={{ "--delay": "150ms" } as React.CSSProperties}
        >
          <PortraitCycle pinned={selected} index={index} />
          {selected ? <Performance tracker={selected} /> : null}
        </div>
      </div>

      {selected ? <TrackingStrip tracker={selected} /> : null}
    </section>
  );
}
