"use client";

import { useEffect, useState } from "react";

import { SolMark } from "@/components/ui/sol-mark";
import { ParticleField } from "@/components/ui/particle-field";
import { TokenIcon } from "@/components/ui/token-icon";
import { LIVE_TRACKERS } from "@/lib/config";
import { motionBudget } from "@/lib/motion";

/**
 * The trade, as a picture: SOL goes into a vault, one token comes out.
 *
 * The middle glyph swaps the two ends, because redemption is not a different
 * product, it is this diagram read right to left. Pressing it is the cheapest
 * way to say that, and it lets someone check the way out before committing to
 * the way in.
 *
 * Unpinned, the token end cycles through the deployed trackers rather than
 * picking one, because "which token" is exactly the choice step 01 is asking
 * the reader to make. Its border is dashed for the same reason.
 */

const HOLD_MS = 2600;

/** How long each direction is held before the diagram flips itself. */
const SWAP_MS = 3000;

function Tile({
  label,
  caption,
  dashed = false,
  children,
}: {
  label: string;
  caption: string;
  dashed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-3">
      <div
        className={`grid h-24 w-24 place-items-center rounded-3xl bg-white/50 sm:h-28 sm:w-28 ${
          dashed
            ? "border border-dashed border-rule-strong"
            : "border border-rule"
        }`}
      >
        {children}
      </div>
      <div className="flex flex-col items-center gap-0.5 text-center">
        <span className="meta">{label}</span>
        <span className="num text-[0.8125rem] text-ink">{caption}</span>
      </div>
    </div>
  );
}

export function DepositFlow({ pinned }: { pinned?: string } = {}) {
  const [index, setIndex] = useState(0);
  const [redeeming, setRedeeming] = useState(false);
  // The flip runs on its own until someone presses the button, then it stops
  // for good. Continuing to animate under a reader who has just taken hold of
  // the control is the thing carousels get wrong.
  const [auto, setAuto] = useState(true);

  // Pinned to one fund, nothing cycles: on a fund page the reader has already
  // picked, and rotating other tickers past them would be noise.
  useEffect(() => {
    if (pinned) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % LIVE_TRACKERS.length),
      HOLD_MS,
    );
    return () => clearInterval(id);
  }, [pinned]);

  // Both directions on a loop, so the way out is shown without being asked
  // for. Reduced motion leaves it on the deposit, which is the default read.
  useEffect(() => {
    if (!auto || motionBudget() === "none") return;
    const id = setInterval(() => setRedeeming((r) => !r), SWAP_MS);
    return () => clearInterval(id);
  }, [auto]);

  const ticker = pinned ?? LIVE_TRACKERS[index].ticker;

  const solTile = (
    <Tile
      label={redeeming ? "You receive" : "You deposit"}
      caption="SOL"
      dashed={redeeming && !pinned}
    >
      {/* SolMark sizes itself to the surrounding text (h-[0.66em]), which
          beats any h-* class passed in. Drive it with font-size instead. */}
      <span className="flex text-[62px] leading-none sm:text-[70px]">
        <SolMark />
      </span>
    </Tile>
  );

  const tokenTile = (
    <Tile
      label={redeeming ? "You burn" : "You hold"}
      caption={ticker}
      dashed={!redeeming && !pinned}
    >
      {/* Keyed by ticker so a cycle re-runs the fade instead of hot-swapping
          the src underneath a static image. */}
      <TokenIcon key={ticker} ticker={ticker} size={56} className="token-swap" />
    </Tile>
  );

  return (
    <div className="relative isolate">
      {/* The page grid is 24px and reads as paper. Up close behind the
          diagram it wants to be a field, so this one is a drifting canvas of
          specks, masked to fade out at the edges rather than end on one. */}
      <ParticleField
        density={9}
        className="flow-dots pointer-events-none absolute inset-0 -z-10"
      />

      <div className="flex items-start justify-center gap-3 py-6 sm:gap-6 sm:py-8">
        {/* Keyed so React moves the tile rather than rewriting its contents,
            which keeps the token's fade from firing on every press. */}
        {redeeming ? tokenTile : solTile}

        {/* The wire. A gradient bead runs it left to right on a loop, so the
            picture reads as a direction rather than a pair of boxes. Swapping
            the ends is enough to reverse it; the bead always travels away from
            whatever you are giving up. */}
        <div
          className="relative mt-12 h-px flex-1 bg-rule sm:mt-14"
          style={{ maxWidth: "9rem" }}
        >
          <span
            aria-hidden
            className="wire-bead grad-flow absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
          />
          <button
            type="button"
            onClick={() => {
              setRedeeming((r) => !r);
              setAuto(false);
            }}
            aria-pressed={redeeming}
            aria-label={
              redeeming
                ? `Show depositing SOL for ${ticker}`
                : `Show redeeming ${ticker} for SOL`
            }
            title={redeeming ? "Show the deposit" : "Show the redemption"}
            className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border border-rule bg-bg text-muted transition-all duration-200 hover:border-rule-strong hover:text-ink active:scale-95"
          >
            <svg
              viewBox="0 0 16 16"
              aria-hidden
              className={`h-3.5 w-3.5 transition-transform duration-300 ${
                redeeming ? "rotate-180" : ""
              }`}
            >
              <path
                d="M2 5.5h9M8.5 3 11 5.5 8.5 8M14 10.5H5M7.5 8 5 10.5 7.5 13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {redeeming ? solTile : tokenTile}
      </div>
    </div>
  );
}
