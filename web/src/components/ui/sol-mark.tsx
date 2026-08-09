"use client";

import { useId } from "react";

/**
 * The Solana logomark, inline, sized to the surrounding text and filled with
 * the exact OG logo gradient. This is the currency icon everywhere an amount
 * is denominated in SOL.
 */
export function SolMark({ className = "" }: { className?: string }) {
  const id = useId();
  return (
    <svg
      aria-label="SOL"
      role="img"
      viewBox="0 0 398 312"
      className={`inline-block h-[0.66em] w-auto -translate-y-px ${className}`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="312" x2="398" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M64.6 237.9a13 13 0 0 1 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8A13.3 13.3 0 0 1 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1a13 13 0 0 0-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7a13 13 0 0 0 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"
      />
    </svg>
  );
}
