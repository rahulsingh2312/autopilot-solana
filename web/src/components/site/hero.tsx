"use client";

import { useEffect, useRef, useState } from "react";

import { CountUp } from "@/components/ui/count-up";
import { NavFootnote, NavStar } from "@/components/ui/nav-note";
import { Halftone } from "@/components/ui/halftone";
import { SolMark } from "@/components/ui/sol-mark";
import { TradeForm } from "@/components/trackers/trade-form";
import { TokenMark, useXstocks } from "@/components/trackers/token-mark";
import { useTrackerSelection } from "@/components/trackers/selection";
import { EXPLORER, TRACKERS, type TrackerConfig } from "@/lib/config";
import {
  computeNav,
  formatBps,
  formatNav,
  formatWeight,
  lamportsToSolNumber,
  truncateAddress,
} from "@/lib/format";
import { useVault } from "@/lib/vault/hooks";
import { formatUsdPrice, useBasketPrices } from "@/lib/xstocks";

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
        {snapshot.ticker} vault{" "}
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
    <figure className="flex flex-col items-end gap-3 lg:sticky lg:top-28">
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

/** How often the source is re-read. One number, stated in one place. */
const WATCH_MINUTES = 30;

/** Holdings shown before the list asks to be opened. */
const VISIBLE_LEGS = 3;

/**
 * The tracking strip under the card and the portrait. This is the part of a
 * basket that is about time rather than about price: how often we go back to
 * the source, how stale the source itself is, and when the weights move. It
 * sits below both columns because it describes the whole tracker, not the
 * trade, and reading it should not cost anyone a scroll past the numbers.
 */
function TrackingStrip({ tracker }: { tracker: TrackerConfig }) {
  const frozen = tracker.status === "frozen";
  const { snapshot } = useVault(tracker.ticker);
  const deployed = Boolean(snapshot?.tracker);

  const cells = [
    {
      label: "Source check",
      value: frozen
        ? "Stopped. There is no next filing."
        : `Every ${WATCH_MINUTES} minutes`,
      note: frozen
        ? "The filer deregistered, so nothing new can arrive."
        : `We re-read the source every ${WATCH_MINUTES} minutes and update the basket when it changes.`,
    },
    {
      label: "Rebalance",
      value: tracker.rebalance,
      note: "Weights move only when the source does. Every change is a transaction you can read on chain.",
    },
    {
      label: "Filing delay",
      value: tracker.filingDelay,
      note: "How stale this basket can be against its source, at worst.",
    },
    {
      label: "In vault",
      value: deployed ? `${lamportsToSolNumber(snapshot!.netAssets).toFixed(3)} SOL` : "Not deployed",
      note:
        deployed && snapshot?.tracker
          ? `Deposit fee ${formatBps(snapshot.tracker.depositFeeBps)}. Read from devnet while you look at it.`
          : "This vault is not live on devnet yet.",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12 sm:px-6 lg:pb-16">
      <div className="flex flex-col gap-4 border-t border-rule pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="display text-[clamp(1.5rem,3vw,2rem)] text-ink">
            How this basket stays current
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

        <dl className="grid gap-px overflow-hidden rounded-2xl border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
          {cells.map((cell) => (
            <div key={cell.label} className="flex flex-col gap-1.5 bg-bg p-4">
              <dt className="meta">{cell.label}</dt>
              <dd className="text-[0.9375rem] font-semibold leading-snug text-ink">
                {cell.value}
              </dd>
              <dd className="text-[0.8125rem] leading-relaxed text-muted">
                {cell.note}
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
  const maxWeight = Math.max(1, ...tracker.legs.map((l) => l.weightBps));
  const prices = useBasketPrices(tracker);

  // The top three carry most of the weight in every basket here; the tail is
  // for people who came to read it. Same for the caveat: it stays on the card
  // rather than behind a link, but it does not get to push the trade below
  // the fold on first look.
  const [allLegs, setAllLegs] = useState(false);
  const [fullCaveat, setFullCaveat] = useState(false);
  const legs = allLegs ? tracker.legs : tracker.legs.slice(0, VISIBLE_LEGS);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [tracker.ticker]);

  return (
    <div className="glass flex flex-col gap-4 p-5 sm:p-6">
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
            {tracker.ticker}
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
      {tracker.legs.length > 0 ? (
        <div className="glass-inset flex flex-col gap-2 p-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="meta">Holdings</span>
            {prices.tokenizedCount > 0 ? (
              <span className="num text-[0.625rem] text-faint">
                {prices.hasAnyPrice
                  ? "live from xStocks"
                  : prices.marketClosed
                    ? "US market closed"
                    : "prices unavailable"}
              </span>
            ) : null}
          </div>
          <ul className="flex flex-col">
            {legs.map((leg) => (
              <li
                key={leg.symbol}
                className="weightbar flex items-center gap-2.5 border-t border-rule py-1.5 text-[0.8125rem] first:border-t-0"
                style={
                  {
                    "--w": `${(leg.weightBps / maxWeight) * 100}%`,
                  } as React.CSSProperties
                }
              >
                <TokenMark symbol={leg.symbol} asset={xstocks[leg.symbol]} />
                <span className="num w-14 shrink-0 font-semibold text-ink">
                  {leg.tokenized ? leg.xstock : leg.symbol}
                </span>
                <span className="flex-1 truncate text-faint">
                  {leg.company}
                </span>
                {(() => {
                  const quote = leg.xstock
                    ? prices.bySymbol.get(leg.xstock)
                    : undefined;
                  if (!quote?.price) return null;
                  return (
                    <span className="num shrink-0 tabular-nums text-ink">
                      {formatUsdPrice(quote.price)}
                    </span>
                  );
                })()}
                <span className="num w-14 shrink-0 text-right tabular-nums text-muted">
                  {formatWeight(leg.weightBps)}
                </span>
              </li>
            ))}
          </ul>

          {tracker.legs.length > VISIBLE_LEGS ? (
            <button
              onClick={() => setAllLegs((open) => !open)}
              className="num self-start pt-1.5 text-[0.6875rem] uppercase tracking-wider text-faint transition-colors hover:text-ink"
            >
              {allLegs ? "Show less" : `Show all ${tracker.legs.length}`}
            </button>
          ) : null}
        </div>
      ) : null}

          {/* Collapsed, the toggle rides the end of the same line the text is
              clipped on, so one line costs one line. Open, it follows the last
              word inline rather than claiming a row of its own. */}
          {fullCaveat ? (
            <p className="text-[0.8125rem] leading-relaxed text-muted">
              <span className="meta mr-2">Straight up</span>
              {tracker.caveat}{" "}
              <button
                onClick={() => setFullCaveat(false)}
                className="num whitespace-nowrap text-[0.6875rem] uppercase tracking-wider text-faint transition-colors hover:text-ink"
              >
                Show less
              </button>
            </p>
          ) : (
            <div className="flex items-end gap-2 text-[0.8125rem] leading-relaxed text-muted">
              <p className="line-clamp-2 min-w-0 flex-1">
                <span className="meta mr-2">Straight up</span>
                {tracker.caveat}
              </p>
              <button
                onClick={() => setFullCaveat(true)}
                className="num shrink-0 whitespace-nowrap text-[0.6875rem] uppercase tracking-wider text-faint transition-colors hover:text-ink"
              >
                Show more
              </button>
            </div>
          )}
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
            <a
              href={EXPLORER("address", snapshot.vaultAddress)}
              target="_blank"
              rel="noreferrer"
              className="num self-start text-[0.6875rem] text-faint underline decoration-dotted underline-offset-4 transition-colors hover:text-ink"
            >
              vault {truncateAddress(snapshot.vaultAddress, 6)}
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
              <a href="#trackers" className="btn btn-grad">
                Deposit SOL
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

        <div
          className="rise flex justify-center lg:justify-end lg:self-center"
          style={{ "--delay": "150ms" } as React.CSSProperties}
        >
          <PortraitCycle pinned={selected} index={index} />
        </div>
      </div>

      {selected ? <TrackingStrip tracker={selected} /> : null}
    </section>
  );
}
