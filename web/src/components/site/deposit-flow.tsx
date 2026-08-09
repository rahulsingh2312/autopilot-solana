"use client";

import { useEffect, useState } from "react";

import { SolMark } from "@/components/ui/sol-mark";
import { ParticleField } from "@/components/ui/particle-field";
import { TokenIcon } from "@/components/ui/token-icon";
import { LIVE_TRACKERS } from "@/lib/config";

/**
 * The trade, as a picture: SOL goes into a vault, one token comes out, and the
 * arrow runs both ways because redemption is the same path in reverse.
 *
 * The right-hand tile cycles through the deployed trackers rather than picking
 * one, because "which token" is exactly the choice step 01 is asking the reader
 * to make. Its border is dashed for the same reason: that side is not decided
 * yet.
 */

const HOLD_MS = 2600;

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

  const ticker = pinned ?? LIVE_TRACKERS[index].ticker;

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
      <Tile label="You deposit" caption="SOL">
        {/* SolMark sizes itself to the surrounding text (h-[0.66em]), which
            beats any h-* class passed in. Drive it with font-size instead. */}
        <span className="text-[62px] leading-none sm:text-[70px]">
          <SolMark />
        </span>
      </Tile>

      {/* The wire. A gradient bead runs it left to right on a loop, so the
          picture reads as a direction rather than a pair of boxes. */}
      <div
        aria-hidden
        className="relative mt-12 h-px flex-1 bg-rule sm:mt-14"
        style={{ maxWidth: "9rem" }}
      >
        <span className="wire-bead grad-flow absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full" />
        <span className="absolute left-1/2 top-1/2 grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-lg border border-rule bg-bg">
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
            <path
              d="M2 5.5h9M8.5 3 11 5.5 8.5 8M14 10.5H5M7.5 8 5 10.5 7.5 13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted"
            />
          </svg>
        </span>
      </div>

        <Tile label="You hold" caption={ticker} dashed={!pinned}>
        {/* Keyed by ticker so the swap re-runs the fade instead of hot-swapping
            the src underneath a static image. */}
        <TokenIcon
          key={ticker}
          ticker={ticker}
          size={56}
          className="token-swap"
        />
        </Tile>
      </div>
    </div>
  );
}
